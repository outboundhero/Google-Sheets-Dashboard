import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { POST as bulkTags } from "@/app/api/deliverability/bulk-tags/route";
import { logEvents } from "@/lib/replacement/store";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/strip-burnt-tag — one-off maintenance, operator-triggered:
// remove the hand-applied "Burnt" tag from UNASSIGNED domains that no longer
// deserve it.
//
// Spencer 2026-08-27: "SURBL blacklisted domains isn't a direct reason for
// flagging a domain at this time. We will still use blacklisted domains as
// long as the group thresholds are fine." The 77 Burnt-tagged reserve domains
// were labelled by hand during the blacklist-driven period; judged by the
// group thresholds alone, ZERO of them come out burnt (12 pass on real
// sending history, 65 never sent). The label is stale, so it goes — the
// blacklist FIELD is left untouched, because that data is still true.
//
// Scope guards (deliberately narrow — this is a hand-applied label):
//   • only domains with NO client tag (never touches a client's live domain)
//   • only domains not already leaving (removed / queued for deletion)
//   • ?domains=a.com,b.com restricts further; ?dry=1 previews
//
// ?allowAssigned=1 lifts ONLY the no-client-tag guard, and only for domains
// named explicitly in ?domains= — for a reviewed list. Used 2026-08-28 for
// the 57 client-assigned Burnt-tagged domains that PASS the group thresholds
// (checked individually: reply 2-6%, low bounce). The one that failed was
// left alone for the replacement engine to handle through the normal burnt
// path. Never use this to clear labels in bulk without that per-domain check.
//
// The Burnt-tag reserve rule in code stays: a Burnt tag still means "do not
// use" going forward. This only clears labels that predate Spencer's ruling.

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const only = new Set(
      (params.get("domains") || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
    );
    // Reviewed-list mode: only meaningful with an explicit ?domains= list.
    const allowAssigned = params.get("allowAssigned") === "1" && only.size > 0;

    const supabase = getSupabaseAdmin();
    const { data: knownRows } = await supabase.from("client_redirects").select("client_tag");
    const known = new Set((knownRows || []).map((r) => String(r.client_tag).toUpperCase()));

    // Leaving = lifecycle removed/replacing/retired or queued for deletion.
    const leaving = new Set<string>();
    for (const [table, filter] of [
      ["domain_replacement_state", "state=in.(removed,replacing,retired)"],
      ["duplicate_domain_deletions", "status=eq.pending"],
    ] as const) {
      for (let off = 0; ; off += 1000) {
        const q = supabase.from(table).select("instance,domain").range(off, off + 999);
        const { data } = filter.startsWith("state")
          ? await q.in("state", ["removed", "replacing", "retired"])
          : await q.eq("status", "pending");
        if (!data || data.length === 0) break;
        for (const r of data as { instance: string; domain: string }[]) leaving.add(`${r.instance}:${r.domain}`);
        if (data.length < 1000) break;
      }
    }

    const targets: Record<string, string[]> = {};
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance,domain,tags")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as { instance: string; domain: string; tags: string[] | null }[]) {
        const tags = (d.tags || []).map((t) => String(t).trim());
        if (!tags.some((t) => t.toLowerCase() === "burnt")) continue;
        if (!allowAssigned && tags.some((t) => known.has(t.toUpperCase()))) continue; // assigned to a client
        if (leaving.has(`${d.instance}:${d.domain}`)) continue;                // already leaving
        if (only.size > 0 && !only.has(d.domain.toLowerCase())) continue;
        if (!isInstanceSlug(d.instance)) continue;
        (targets[d.instance] ||= []).push(d.domain);
      }
      if (data.length < 1000) break;
    }

    const total = Object.values(targets).reduce((n, v) => n + v.length, 0);
    if (dryRun || total === 0) {
      return NextResponse.json({ dryRun, total, byInstance: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, v.length])), sample: Object.values(targets)[0]?.slice(0, 5) ?? [] });
    }

    const results: { instance: string; domains: number; inboxesAffected: number; failed: number; error?: string }[] = [];
    for (const [instance, domains] of Object.entries(targets)) {
      try {
        const res = await bulkTags(
          new Request("http://internal/api/cron/strip-burnt-tag", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove", tagNames: ["Burnt"], domains }),
          }),
        );
        const json = await res.json().catch(() => ({}));
        results.push({
          instance,
          domains: domains.length,
          inboxesAffected: (json.inboxesAffected as number) ?? 0,
          failed: (json.failed as number) ?? 0,
          ...(json.error ? { error: String(json.error) } : {}),
        });
        await logEvents(
          domains.map((d) => ({
            instance: instance as BisonInstanceSlug,
            domain: d,
            eventType: "skipped" as const,
            detail: "Burnt tag cleared — SURBL listing alone is not a flagging reason (Spencer 2026-08-27); group thresholds decide",
          })),
        ).catch(() => {});
      } catch (e) {
        results.push({ instance, domains: domains.length, inboxesAffected: 0, failed: domains.length, error: e instanceof Error ? e.message : "failed" });
      }
    }

    return NextResponse.json({ total, results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "strip-burnt-tag failed" }, { status: 500 });
  }
}
