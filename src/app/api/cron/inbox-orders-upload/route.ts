import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as inboxing from "@/lib/inboxing";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount } from "@/lib/inboxing-accounts";
import { inboxingConnectionFor } from "@/lib/replacement/inboxing-connections";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/inbox-orders-upload — hourly: every ACTIVE Inboxing order must
// actually be in its Bison instance.
//
// Spencer 2026-08-26 (Loom) + Ramon at Inboxing: the 291 Premium-Tenant
// domains ordered 2026-08-12 went "active" at Inboxing but were never uploaded
// to any Bison workspace. Cause, on our side: the order flow creates the
// domain (registrar + Cloudflare + redirect) but never passes the platform
// connection — the only caller of the upload endpoint was the move flow. And
// the status poll marks "active" from Inboxing's domain status alone, so the
// dashboard read "active: 200" with nothing in Bison.
//
// This closes both halves for every order, past and future:
//   1. an active Inboxing order not yet uploaded → upload to the connection of
//      the instance the order was placed for (never "all 4" — that would mint
//      cross-instance duplicates)
//   2. verification: once the deliverability crawl sees the domain in that
//      instance, the order is marked in_bison; queued-but-absent orders are
//      reported so the lag is visible instead of silent
//
// State lives in inbox_orders.setup_stage for active rows (the poll only
// rewrites it for pending rows): null → bison_upload_queued → in_bison, or
// bison_upload_failed (retried next run).
//
// ?dry=1 preview · ?instance= filter · ?max= per-run cap (default 40).

const DEFAULT_MAX = 40;
// HOLD (2026-08-26): Ramon at Inboxing may upload the August Premium-Tenant
// backlog by hand, and our connection IDs are unverified under the Premium
// login. While held, the cron only VERIFIES (marks in_bison as the crawl
// confirms) and reports — it uploads nothing unless called with ?force=1.
// Flip to false once the backlog is in Bison and a canary upload has proven
// the Premium-account connections.
const UPLOAD_HOLD = true;
const STAGE_QUEUED = "bison_upload_queued";
const STAGE_IN_BISON = "in_bison";
const STAGE_FAILED = "bison_upload_failed";

interface OrderRow {
  id: number;
  domain: string;
  instance: string;
  provider_domain_id: string | null;
  inboxing_account: string | null;
  setup_stage: string | null;
  completed_at: string | null;
  created_at: string;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyInstance = (params.get("instance") || "").trim();
    const max = Math.max(1, Math.min(200, Number(params.get("max")) || DEFAULT_MAX));

    const supabase = getSupabaseAdmin();

    const orders: OrderRow[] = [];
    for (let off = 0; ; off += 1000) {
      let q = supabase
        .from("inbox_orders")
        .select("id, domain, instance, provider_domain_id, inboxing_account, setup_stage, completed_at, created_at")
        .eq("provider", "inboxing")
        .eq("status", "active")
        .range(off, off + 999);
      if (onlyInstance) q = q.eq("instance", onlyInstance);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      orders.push(...(data as OrderRow[]));
      if (data.length < 1000) break;
    }
    if (orders.length === 0) return NextResponse.json({ clean: true, active: 0 });

    // Presence from the deliverability crawl — per (instance, domain) AND per
    // domain across ALL instances. The all-instances view is the safety rail:
    // an older order's recorded instance can differ from where the domain
    // lives today (moved since, or pre-instance-column default), and the
    // first dry-run showed 488 "absent" that way. Uploading a domain that
    // already exists in another instance would mint exactly the cross-
    // instance duplicates the cleanup cron exists to remove — so those are
    // reported, never uploaded.
    const present = new Set<string>();
    const presentAnywhere = new Map<string, string[]>();
    const names = [...new Set(orders.map((o) => o.domain))];
    for (let i = 0; i < names.length; i += 200) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain")
        .in("domain", names.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        present.add(`${r.instance}:${r.domain}`);
        presentAnywhere.set(r.domain, [...(presentAnywhere.get(r.domain) ?? []), r.instance]);
      }
    }

    const nowMs = Date.now();
    const toUpload: OrderRow[] = [];
    const markInBison: OrderRow[] = [];
    const awaiting: { domain: string; instance: string; queuedFor: string }[] = [];
    const unresolvable: { domain: string; reason: string }[] = [];
    const inOtherInstance: { domain: string; orderedFor: string; livesIn: string[] }[] = [];
    let alreadyInBison = 0;

    for (const o of orders) {
      const inBison = present.has(`${o.instance}:${o.domain}`);
      if (o.setup_stage === STAGE_IN_BISON) { alreadyInBison++; continue; }
      if (inBison) { markInBison.push(o); continue; }
      const elsewhere = presentAnywhere.get(o.domain);
      if (elsewhere && elsewhere.length > 0) {
        inOtherInstance.push({ domain: o.domain, orderedFor: o.instance, livesIn: elsewhere });
        continue;
      }
      if (!isInstanceSlug(o.instance)) { unresolvable.push({ domain: o.domain, reason: `unknown instance ${o.instance}` }); continue; }
      if (!o.provider_domain_id) { unresolvable.push({ domain: o.domain, reason: "no Inboxing domain id on the order" }); continue; }
      if (o.setup_stage === STAGE_QUEUED) {
        // Uploaded, not yet seen by the crawl (runs every ~2 days per instance).
        const since = o.completed_at || o.created_at;
        awaiting.push({ domain: o.domain, instance: o.instance, queuedFor: `${Math.floor((nowMs - new Date(since).getTime()) / 86_400_000)}d` });
        continue;
      }
      toUpload.push(o); // null stage or a previous failure → (re)try
    }

    const force = params.get("force") === "1";
    const held = UPLOAD_HOLD && !force;
    const batch = held ? [] : toUpload.slice(0, max);

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        active: orders.length,
        alreadyInBison: alreadyInBison + markInBison.length,
        toUpload: toUpload.length,
        thisRun: batch.map((o) => ({ domain: o.domain, instance: o.instance })),
        awaitingCrawl: awaiting.length,
        inOtherInstance: inOtherInstance.length,
        inOtherInstanceSample: inOtherInstance.slice(0, 10),
        unresolvable,
      });
    }

    // Verification half: crawl has confirmed these — mark them.
    for (const o of markInBison) {
      await supabase.from("inbox_orders").update({ setup_stage: STAGE_IN_BISON, last_checked_at: new Date().toISOString() }).eq("id", o.id);
    }

    // Upload half.
    const uploaded: { domain: string; instance: string; jobs: number }[] = [];
    const failed: { domain: string; instance: string; error: string }[] = [];
    for (const o of batch) {
      const account = toInboxingAccount(o.inboxing_account) ?? DEFAULT_INBOXING_ACCOUNT;
      const connection = inboxingConnectionFor(o.instance as BisonInstanceSlug);
      try {
        const r = await inboxing.uploadDomainToPlatform(o.provider_domain_id!, connection, account);
        uploaded.push({ domain: o.domain, instance: o.instance, jobs: r.jobsCreated });
        await supabase.from("inbox_orders").update({
          setup_stage: STAGE_QUEUED,
          failure_reason: null,
          last_checked_at: new Date().toISOString(),
        }).eq("id", o.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "upload failed";
        failed.push({ domain: o.domain, instance: o.instance, error: msg });
        await supabase.from("inbox_orders").update({
          setup_stage: STAGE_FAILED,
          failure_reason: msg.slice(0, 500),
          last_checked_at: new Date().toISOString(),
        }).eq("id", o.id);
      }
    }

    return NextResponse.json({
      held,
      active: orders.length,
      alreadyInBison: alreadyInBison + markInBison.length,
      markedInBison: markInBison.length,
      uploaded: uploaded.length,
      failed,
      remainingToUpload: Math.max(0, toUpload.length - batch.length),
      awaitingCrawl: awaiting,
      inOtherInstance,
      unresolvable,
      sample: uploaded.slice(0, 10),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inbox-orders-upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
