import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { readClientTracker } from "@/lib/replacement/redirect-audit";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/redirect-conform — daily: every client-tagged domain must
// point at that client's redirect.
//
// Nick + Spencer 2026-08-19: JPWC domains were found pointing at other
// clients' redirects (knoxville, ne). Cause: retagging a domain by hand moves
// the tag but not the redirect — the fill sets redirects, manual bulk-tags
// never did. Rather than patching that one entry point, this cron closes the
// loop for every path: compare what the redirect-check cron OBSERVED against
// the client_redirects expectation and re-point whatever drifted. It is both
// the retroactive audit ("fix what's out there") and the forward fix (any
// future drift self-heals within a day).
//
// Guardrails:
//   - only domains the redirect-check has actually looked at (checked_at set);
//     an unchecked domain's mismatch can't be distinguished from stale data
//   - domains mid-replacement (removed/replacing/retired) are left alone —
//     they are leaving; the release path clears their redirect itself
//   - normalized comparison (protocol / www / trailing slash / case) so
//     "https://jan-pro.com/x/" vs "http://www.jan-pro.com/x" is NOT drift
//   - capped per run; the daily cadence converges the backlog
//   - expectations come from the Client Tracker's Website column, with
//     client_redirects only as fallback for tags without a Website cell.
//     Nick 2026-08-22: "The system always needs to read the client tracker
//     sheet tab... That is the source of truth for redirect URLs." That
//     wholesale confirmation is also why applying is now the DEFAULT — the
//     earlier audit-only stance existed because the client_redirects list
//     itself was stale (JPET said chattanooga, SBTB the bare root).
//
// ?dry=1 — audit only; ?apply=TAG1,TAG2 — restrict fixes to those tags.

const MAX_FIXES_PER_RUN = 100;

/** Protocol, www., trailing slashes and case are presentation, not identity. */
function normalizeUrl(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s || s === "no redirect" || s === "(none)") return "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return s.replace(/\/+$/, "");
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const applyParam = (params.get("apply") || "").trim();
    const applyTags = new Set(
      applyParam && applyParam.toLowerCase() !== "all"
        ? applyParam.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
        : [],
    );
    const dry = params.get("dry") === "1";
    const supabase = getSupabaseAdmin();

    const { data: redirectRows, error: rErr } = await supabase
      .from("client_redirects")
      .select("client_tag, redirect_url");
    if (rErr) throw new Error(rErr.message);
    const expectedByTag = new Map<string, string>();
    for (const r of redirectRows || []) {
      const url = String(r.redirect_url || "").trim();
      if (url) expectedByTag.set(r.client_tag.toUpperCase(), url);
    }

    // Sheet wins wherever it has a plausible value. Fail-open: a sheet read
    // error leaves the run on client_redirects alone rather than skipping it.
    try {
      const { websites } = await readClientTracker();
      for (const [tag, site] of websites) {
        const s = site.trim();
        if (!s || /\s/.test(s) || !s.includes(".")) continue; // "n/a", notes, junk
        expectedByTag.set(tag, /^https?:\/\//i.test(s) ? s : `https://${s}`);
      }
    } catch (e) {
      console.error("[REDIRECT-CONFORM] tracker read failed; using client_redirects only:", e);
    }

    const handled = await getHandledDomains();

    interface Row {
      instance: string;
      domain: string;
      tags: string[] | null;
      redirect_url: string | null;
      redirect_checked_at: string | null;
    }
    const rows: Row[] = [];
    let off = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, redirect_url, redirect_checked_at")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data || []) as Row[]));
      if (!data || data.length < 1000) break;
      off += 1000;
    }

    // One fix per DOMAIN (redirects are domain-level at the provider), even
    // when the domain has rows on two instances — pick the first tagged row.
    const seen = new Set<string>();
    const mismatches: { domain: string; instance: string; tag: string; expected: string; observed: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.domain)) continue;
      if (!r.redirect_checked_at) continue;
      if (handled.has(`${r.instance}:${r.domain}`)) continue;
      const tag = (r.tags || [])
        .map((t) => String(t).trim().toUpperCase())
        .find((t) => expectedByTag.has(t));
      if (!tag) continue;
      const expected = expectedByTag.get(tag)!;
      if (normalizeUrl(r.redirect_url) === normalizeUrl(expected)) continue;
      seen.add(r.domain);
      mismatches.push({
        domain: r.domain,
        instance: r.instance,
        tag,
        expected,
        observed: r.redirect_url || "(none)",
      });
    }

    const toApply = applyTags.size > 0
      ? mismatches.filter((m) => applyTags.has(m.tag))
      : mismatches;

    if (dry || toApply.length === 0) {
      return NextResponse.json({
        dry,
        mismatches: mismatches.length,
        applied: 0,
        sample: mismatches.slice(0, 50),
      });
    }

    // Group by target URL so one change-redirect call covers a batch.
    const byUrl = new Map<string, typeof mismatches>();
    for (const m of toApply.slice(0, MAX_FIXES_PER_RUN)) {
      byUrl.set(m.expected, [...(byUrl.get(m.expected) ?? []), m]);
    }

    let fixed = 0;
    const failed: { domain: string; error: string }[] = [];
    for (const [url, group] of byUrl) {
      const domains = group.map((g) => g.domain);
      try {
        const res = await internalFetch("/api/deliverability/change-redirect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false, domains, newUrl: url }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.error) throw new Error(json?.error || `HTTP ${res.status}`);

        // Optimistic local update so tomorrow's run doesn't re-fix the same
        // domains before the redirect-check re-observes them.
        await supabase
          .from("deliverability_domains")
          .update({ redirect_url: url })
          .in("domain", domains);

        await logEvents(
          group.map((g) => ({
            instance: g.instance as BisonInstanceSlug,
            domain: g.domain,
            clientTag: g.tag,
            eventType: "redirect_set" as const,
            detail: `conform: was ${g.observed}`,
          })),
        ).catch(() => {});
        fixed += domains.length;
      } catch (e) {
        for (const d of domains) {
          failed.push({ domain: d, error: e instanceof Error ? e.message : "failed" });
        }
      }
    }

    return NextResponse.json({
      mismatches: mismatches.length,
      fixed,
      failed,
      remaining: Math.max(0, toApply.length - MAX_FIXES_PER_RUN),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "redirect-conform failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
