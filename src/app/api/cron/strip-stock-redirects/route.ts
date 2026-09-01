import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { updateRedirect as inboxingUpdateRedirect } from "@/lib/inboxing";
import type { InboxingAccount } from "@/lib/inboxing-accounts";
import { updateRedirect as milkboxUpdateRedirect } from "@/lib/milkbox";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { logEvents } from "@/lib/replacement/store";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/strip-stock-redirects — reserve stock points NOWHERE.
//
// Spencer 2026-09-02: "we don't want the redirect to go to anything" until a
// domain is assigned to a client. New orders are now created redirect-less
// (Inboxing) or with a transient self-redirect (MilkBox, whose create spec
// doesn't document a nullable redirect — their PATCH null is the documented
// removal path, used here). This cron finishes the job for everything already
// created with the old placeholder: any UNASSIGNED order-sourced domain that
// still carries a redirect gets it removed at the provider.
//
// Assigned domains are never touched — the replacement system owns their
// redirect (client's real website, conformed hourly). Scope is order-sourced
// domains only (we have their provider ids), so legacy/manual domains are
// left alone. ?dry=1 previews; capped per run.

const RUN_CAP = 40;
/** Neutral parking site for veteran (previously used) reserve domains —
 *  Spencer 2026-09-02: churned clients' healthy domains returning to reserve
 *  are the ONLY stock that should point here. */
const PARKING_URL = "https://findlocalcommercialcleaning.com";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const cap = Math.max(1, Number(url.searchParams.get("limit") ?? RUN_CAP) || RUN_CAP);

    const supabase = getSupabaseAdmin();
    const knownTags = await getKnownClientTags();
    const knownUpper = new Set([...knownTags].map((t) => t.toUpperCase()));

    // Order-sourced domains with a provider id we can act on.
    interface OrderRow {
      provider: string; domain: string; instance: string | null;
      provider_domain_id: string | null; inboxing_account: string | null;
    }
    const orders: OrderRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("inbox_orders")
        .select("provider, domain, instance, provider_domain_id, inboxing_account")
        .in("provider", ["inboxing", "milkbox"])
        .not("provider_domain_id", "is", null)
        .order("domain", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      orders.push(...(data as OrderRow[]));
      if (data.length < 1000) break;
    }

    // Mirror state: which of those domains are unassigned and still carry a
    // redirect. A domain absent from the mirror (not crawled yet) is skipped —
    // it gets picked up on a later run once we can see its tags.
    interface DomRow { instance: string; domain: string; tags: string[] | null; redirect_url: string | null; total_sent: number | null }
    const mirror = new Map<string, DomRow>();
    const names = [...new Set(orders.map((o) => o.domain.toLowerCase()))];
    for (let i = 0; i < names.length; i += 100) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, redirect_url, total_sent")
        .in("domain", names.slice(i, i + 100));
      if (error) throw new Error(error.message);
      for (const d of (data || []) as DomRow[]) mirror.set(`${d.instance}:${d.domain.toLowerCase()}`, d);
    }
    const isAssigned = (d: DomRow) =>
      (d.tags || []).some((t) => knownUpper.has(String(t).trim().toUpperCase()));

    interface Candidate { order: OrderRow; row: DomRow; target: string | null }
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const o of orders) {
      if (!o.instance) continue;
      const key = `${o.instance}:${o.domain.toLowerCase()}`;
      if (seen.has(key)) continue;
      const row = mirror.get(key);
      if (!row) continue;                    // not crawled yet — next run
      if (isAssigned(row)) continue;         // client stock — replacement owns it
      // Spencer's full stock policy (2026-09-02): FRESH stock (never sent)
      // points NOWHERE; VETERAN stock (came back from a client) points at the
      // neutral parking site — never at an ex-client's website, never dark.
      const veteran = (row.total_sent ?? 0) > 0;
      const target = veteran ? PARKING_URL : null;
      const current = (row.redirect_url || "").replace(/\/+$/, "");
      if ((target === null && !row.redirect_url) || (target !== null && current === PARKING_URL.replace(/\/+$/, ""))) continue; // already on policy
      seen.add(key);
      candidates.push({ order: o, row, target });
    }

    const work = candidates.slice(0, cap);
    let stripped = 0;
    const failures: { domain: string; provider: string; error: string }[] = [];

    if (!dryRun) {
      for (const c of work) {
        try {
          if (c.order.provider === "inboxing") {
            await inboxingUpdateRedirect(
              c.order.provider_domain_id!,
              c.target,
              (c.order.inboxing_account as InboxingAccount) || undefined,
            );
          } else {
            await milkboxUpdateRedirect(c.order.provider_domain_id!, c.target);
          }
          stripped++;
          await supabase
            .from("deliverability_domains")
            .update({ redirect_url: c.target })
            .eq("instance", c.row.instance)
            .eq("domain", c.row.domain);
          await logEvents([{
            instance: c.row.instance as BisonInstanceSlug,
            domain: c.row.domain,
            eventType: "redirect_set",
            detail: c.target === null
              ? `stock policy: fresh reserve redirect stripped to none at ${c.order.provider} (points nowhere until assignment)`
              : `stock policy: veteran reserve parked at ${PARKING_URL} at ${c.order.provider} (never an ex-client's site)`,
          }]);
        } catch (e) {
          failures.push({ domain: c.order.domain, provider: c.order.provider, error: e instanceof Error ? e.message.slice(0, 150) : "failed" });
        }
        await new Promise((r) => setTimeout(r, 800)); // provider rate-limit pacing
      }
    }

    return NextResponse.json({
      dryRun,
      candidates: candidates.length,
      processed: work.length,
      stripped,
      remaining: Math.max(0, candidates.length - work.length),
      failures,
      sample: work.slice(0, 8).map((c) => `${c.order.provider}:${c.row.domain}`),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "strip-stock-redirects failed" }, { status: 500 });
  }
}
