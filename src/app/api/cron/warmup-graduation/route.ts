import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import type { NewEvent } from "@/lib/replacement/store";

export const maxDuration = 300;

// GET /api/cron/warmup-graduation — the "system that turns warmup off" that
// never existed (Vicky, 2026-08-29).
//
// Every inbox order enters Bison with warmup on and a tiny daily limit — by
// design, new domains must warm ~21 days. But warmup has no timer: nothing in
// Bison or LeadSync ever raised the limit afterwards. Exiting warmup was an
// unwritten manual step done at client launch, so any domain that missed its
// launch sat at 2/day forever. The audit found 68 client-tagged domains idle
// this way; separately the fill assigns reserve domains without ramping them,
// recreating the problem for every future assignment.
//
// This cron is the missing timer. Rule (the system's own, WARMUP_DAYS=21 in
// plan.ts / true-up.ts): an inbox ≥21 days old has finished warmup → raise its
// daily limit to the fleet's live setting. Inboxes under 21d are left warming.
// Age comes from the mirror's created_at, verified identical to Bison's
// (2026-08-29 spot-check). Limits are only ever RAISED — an operator's higher
// custom limit is never touched — via the same Bison bulk endpoint the manual
// Daily Limit button uses.
//
// Guards: skips Burnt-tagged domains and anything in the deletion/cancel
// queues (no point ramping a domain that's leaving). Cap per run bounds the
// blast radius; the hourly schedule drains any backlog within a day.
//
// ?dry=1   preview only.  ?limit=   override the per-run cap.

/** Fleet convention for a live (out of warmup) inbox — matches what ops set by
 *  hand on every launched sender. */
const TARGET_LIMIT = 10;
const WARMUP_DAYS = 21; // same rule as plan.ts / true-up.ts
const RUN_CAP = 400;    // inboxes per run

interface InboxRow {
  id: number;
  instance: BisonInstanceSlug;
  domain: string;
  created_at: string | null;
  daily_limit: number | null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const cap = Math.max(1, Number(url.searchParams.get("limit") ?? RUN_CAP) || RUN_CAP);

    const supabase = getSupabaseAdmin();
    const handled = await getHandledDomains();
    const cutoff = new Date(Date.now() - WARMUP_DAYS * 86_400_000).toISOString();

    // Domain tags — to skip Burnt-tagged domains.
    const burntDomains = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as { instance: string; domain: string; tags: string[] | null }[]) {
        if (hasBurntTag(d.tags)) burntDomains.add(`${d.instance}:${d.domain}`);
      }
      if (data.length < 1000) break;
    }

    // Graduation candidates: ≥21d old AND still under the live limit.
    const candidates: InboxRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_inboxes")
        .select("id, instance, domain, created_at, daily_limit")
        .in("instance", ALL_INSTANCE_SLUGS)
        .lt("daily_limit", TARGET_LIMIT)
        .lte("created_at", cutoff)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as InboxRow[]) {
        const key = `${r.instance}:${r.domain}`;
        if (handled.has(key) || burntDomains.has(key)) continue;
        candidates.push(r);
      }
      if (data.length < 1000) break;
    }

    // Oldest first: whoever has waited longest graduates first.
    candidates.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const work = candidates.slice(0, cap);

    let updated = 0;
    const failedBatches: { instance: string; count: number; status: number }[] = [];
    if (!dryRun) {
      const byInstance = new Map<BisonInstanceSlug, number[]>();
      for (const r of work) {
        if (!byInstance.has(r.instance)) byInstance.set(r.instance, []);
        byInstance.get(r.instance)!.push(r.id);
      }
      for (const [instance, ids] of byInstance) {
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
          const res = await bisonFetch(instance, `/sender-emails/daily-limits/bulk`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch, daily_limit: TARGET_LIMIT }),
          });
          if (res.ok) {
            updated += batch.length;
            await supabase
              .from("deliverability_inboxes")
              .update({ daily_limit: TARGET_LIMIT })
              .eq("instance", instance)
              .in("id", batch);
          } else {
            failedBatches.push({ instance, count: batch.length, status: res.status });
          }
        }
      }

      // One audit event per domain so the graduation shows in the live feed
      // and per-domain history.
      const byDomain = new Map<string, number>();
      for (const r of work) {
        const k = `${r.instance}:${r.domain}`;
        byDomain.set(k, (byDomain.get(k) || 0) + 1);
      }
      const events: NewEvent[] = [...byDomain.entries()].map(([k, n]) => {
        const i = k.indexOf(":");
        return {
          instance: k.slice(0, i) as BisonInstanceSlug,
          domain: k.slice(i + 1),
          eventType: "ramped",
          detail: `warmup graduation: ${n} inbox(es) ≥${WARMUP_DAYS}d old raised to daily limit ${TARGET_LIMIT}`,
          signals: { inboxes: n, limit: TARGET_LIMIT },
        };
      });
      if (updated > 0) await logEvents(events);
    }

    return NextResponse.json({
      dryRun,
      eligible: candidates.length,
      processed: work.length,
      updated,
      remaining: Math.max(0, candidates.length - work.length),
      failedBatches,
      sample: work.slice(0, 5).map((r) => `${r.instance}:${r.domain}`),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "warmup graduation failed" },
      { status: 500 },
    );
  }
}
