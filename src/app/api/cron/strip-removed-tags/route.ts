import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { POST as bulkTags } from "@/app/api/deliverability/bulk-tags/route";
import { logEvents } from "@/lib/replacement/store";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/strip-removed-tags — hourly: a domain whose replacement state
// is `removed` must not carry its assigned client tag, or it inflates that
// client's domain count everywhere the dashboard counts by tag.
//
// How the lingering tags happen: removals before the untag-at-removal fix
// (f1cf2fc) never untagged at all, and even after it the untag can fail on
// disconnected inboxes — one tagged inbox keeps the tag in the domain rollup,
// and conform-tags then re-added it to every healthy inbox (guard for that now
// in conform-tags.ts). Found live 2026-08-21: 347 removed domains still tagged
// across ~35 client/instance pairs — the direct cause of Nick's "SBTB/BHS/
// CCGLA read 29-30 when they should read 20".
//
// The strip is surgical: inboxes are passed as explicit (instance, id) pairs,
// never as bare domain names, because ~50 domains exist in TWO instances and
// the copy in the other instance may be live for the same client.
//
// Bounded per run; the hourly schedule drains any backlog and then no-ops on
// two cheap reads. `?dry=1` previews; `?tag=&instance=` limits to one client
// side (used to clear a client someone is waiting on ahead of queue order).

const MAX_DOMAINS_PER_RUN = 40;

interface RemovedRow {
  instance: string;
  domain: string;
  assigned_client_tag: string | null;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyTag = (params.get("tag") || "").trim().toUpperCase();
    const onlyInstance = (params.get("instance") || "").trim();

    const supabase = getSupabaseAdmin();
    const PAGE = 1000;

    const removed: RemovedRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("domain_replacement_state")
        .select("instance, domain, assigned_client_tag")
        .eq("state", "removed")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`state read: ${error.message}`);
      if (!data || data.length === 0) break;
      removed.push(...(data as RemovedRow[]));
      if (data.length < PAGE) break;
    }

    const rollup = new Map<string, string[]>();
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`domains read: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data as { instance: string; domain: string; tags: string[] | null }[]) {
        rollup.set(
          `${r.instance}::${r.domain}`,
          (r.tags || []).map((t) => String(t).trim().toUpperCase()),
        );
      }
      if (data.length < PAGE) break;
    }

    // Still-tagged = removed rows whose rollup still lists the client tag that
    // was on them when they were removed. Only that one tag is stripped.
    let pending = removed.filter((r) => {
      const tag = (r.assigned_client_tag || "").trim().toUpperCase();
      if (!tag || !isInstanceSlug(r.instance)) return false;
      if (onlyTag && tag !== onlyTag) return false;
      if (onlyInstance && r.instance !== onlyInstance) return false;
      return (rollup.get(`${r.instance}::${r.domain}`) || []).includes(tag);
    });

    const totalPending = pending.length;
    if (totalPending === 0) {
      return NextResponse.json({ clean: true, pending: 0 });
    }

    pending = pending.slice(0, MAX_DOMAINS_PER_RUN);

    // Group by (instance, tag) — one bulk-tags call per group.
    const groups = new Map<string, { instance: BisonInstanceSlug; tag: string; domains: string[] }>();
    for (const r of pending) {
      const tag = (r.assigned_client_tag || "").trim();
      const key = `${r.instance}::${tag.toUpperCase()}`;
      const g = groups.get(key) ?? { instance: r.instance as BisonInstanceSlug, tag, domains: [] };
      g.domains.push(r.domain);
      groups.set(key, g);
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        pending: totalPending,
        thisRun: pending.length,
        groups: [...groups.values()].map((g) => ({
          instance: g.instance,
          tag: g.tag,
          domains: g.domains,
        })),
      });
    }

    const results: { instance: string; tag: string; domains: number; inboxes: number; failed: number; error?: string }[] = [];

    for (const g of groups.values()) {
      // Explicit (instance, id) inboxes so the strip cannot touch the same
      // domain's copy in another instance.
      const inboxes: { instance: string; id: number }[] = [];
      for (const domain of g.domains) {
        for (let offset = 0; ; offset += PAGE) {
          const { data, error } = await supabase
            .from("deliverability_inboxes")
            .select("id")
            .eq("instance", g.instance)
            .eq("domain", domain)
            .range(offset, offset + PAGE - 1);
          if (error) throw new Error(`inboxes read: ${error.message}`);
          if (!data || data.length === 0) break;
          for (const row of data as { id: number }[]) {
            inboxes.push({ instance: g.instance, id: row.id });
          }
          if (data.length < PAGE) break;
        }
      }
      if (inboxes.length === 0) continue;

      let failedCount = 0;
      let updated = 0;
      let errorMsg: string | undefined;
      try {
        const res = await bulkTags(
          new Request("http://internal/api/cron/strip-removed-tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove", tagNames: [g.tag], inboxes }),
          }),
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.error) {
          errorMsg = json?.error || `HTTP ${res.status}`;
        } else {
          updated = (json.inboxesAffected as number) ?? 0;
          failedCount = (json.failed as number) ?? 0;
        }
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : "bulk-tags call failed";
      }

      results.push({
        instance: g.instance,
        tag: g.tag,
        domains: g.domains.length,
        inboxes: updated,
        failed: failedCount,
        ...(errorMsg ? { error: errorMsg } : {}),
      });

      await logEvents(
        g.domains.map((d) => ({
          instance: g.instance,
          domain: d,
          clientTag: g.tag,
          eventType: errorMsg ? ("error" as const) : ("removed" as const),
          detail: errorMsg
            ? `strip-removed-tags failed: ${errorMsg}`
            : "stripped lingering client tag from removed domain (pre-untag-fix removal / conform re-add)",
        })),
      ).catch(() => {});
    }

    return NextResponse.json({
      pending: totalPending,
      processed: pending.length,
      remaining: Math.max(0, totalPending - pending.length),
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strip-removed-tags failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
