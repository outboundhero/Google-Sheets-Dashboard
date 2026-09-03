import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { getLastClientTags } from "@/lib/replacement/tag-memory";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { getSkipSet, skipKey } from "@/lib/replacement/skips";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";
import { getAllocations } from "@/lib/client-tag-allocations";
import { loadRedirectsByTag } from "@/lib/replacement/redirect-audit";
import { recordPipelineAlert } from "@/lib/pipeline-alerts";
import { ALL_INSTANCE_SLUGS, getInstance, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/tag-memory-restore — the MEMORY BANK (Spencer's Loom,
// 2026-09-03).
//
// Inboxing stores no client tags. When sender domains are disconnected (token
// expiry) and re-added, they land in Bison nameless with only their old
// redirect intact — veterans that then masquerade as fresh reserve, sometimes
// in the wrong group's instance. Spencer spent a night re-tagging them by
// reading redirects; this cron makes that the last time.
//
// Per untagged, unhandled domain:
//   HISTORY HIT  — the events log names its most recent client tag and that
//     client isn't offboarded → the tag is reapplied in Bison (resolve/create
//     by NAME per instance, attach to every inbox) and mirrored, logged as a
//     restore. The hourly orphan-attach cron then attaches campaigns, and
//     conform keeps inboxes aligned — reuse, not new machinery. If the tag's
//     allocation group doesn't match the instance it landed in, a silent
//     pipeline alert flags the mismatch in Deliverability immediately.
//   NO HISTORY, VETERAN (has sends) — never guessed. Silent pipeline alert
//     ("tagless veteran") for a human call, exactly as Spencer asked.
//     EXCEPTION: ?redirectFallback=1 (supervised sweeps only) maps the
//     domain's redirect back to a client via the tracker — the same inference
//     Spencer did by hand, allowed once under supervision, never unattended.
//   NO HISTORY, FRESH — genuinely new stock, left alone (reserve).
//
// ?dry=1 previews. Capped per run; hourly cadence drains any backlog fast
// ("within the hour", as promised).

const RUN_CAP = 40;

const norm = (u: string | null | undefined) =>
  (u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const redirectFallback = url.searchParams.get("redirectFallback") === "1";
    const cap = Math.max(1, Number(url.searchParams.get("limit") ?? RUN_CAP) || RUN_CAP);

    const supabase = getSupabaseAdmin();
    const [lastTags, handled, skips, offboarded] = await Promise.all([
      getLastClientTags(), getHandledDomains(), getSkipSet(), getOffboardedClientTags(),
    ]);
    // A COMPLETED vendor cancellation drops out of getHandledDomains (status
    // 'done'), but the domain lingers in the mirror until the crawl prunes it
    // — the first dry runs offered CCGW its own already-cancelled burnt
    // domains back. Any cancellation history, any status, bars a restore.
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("replacement_cancellations").select("instance, domain")
        .order("domain", { ascending: true }).range(off, off + 999);
      if (error) break;
      if (!data || data.length === 0) break;
      for (const r of data as { instance: string; domain: string }[]) handled.add(`${r.instance}:${r.domain}`);
      if (data.length < 1000) break;
    }
    const alloc = await getAllocations().catch(() => ({ map: {} as Record<string, number> }));

    // Known client tags = campaign universe (same rule as everywhere else).
    const { data: camps } = await supabase.from("campaigns").select("client_tag").limit(10000);
    const known = new Set(
      ((camps || []) as { client_tag: string | null }[])
        .map((c) => (c.client_tag || "").trim().toUpperCase())
        .filter(Boolean),
    );

    // Reverse redirect → tag map, for the supervised fallback only.
    let tagByRedirect = new Map<string, string>();
    if (redirectFallback) {
      const byTag = await loadRedirectsByTag();
      tagByRedirect = new Map([...byTag.entries()].map(([tag, u]) => [norm(u), tag]));
    }

    interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null; total_sent: number | null; redirect_url: string | null }
    const doms: DomRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, total_sent, redirect_url")
        .in("instance", ALL_INSTANCE_SLUGS)
        .order("domain", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      doms.push(...(data as DomRow[]));
      if (data.length < 1000) break;
    }

    interface Restore { instance: BisonInstanceSlug; domain: string; tag: string; source: "history" | "redirect"; historyAt?: string; groupMismatch: boolean }
    const restores: Restore[] = [];
    const taglessVeterans: { instance: string; domain: string }[] = [];

    for (const d of doms) {
      const key = `${d.instance}:${d.domain}`;
      if ((d.tags || []).some((t) => known.has(String(t).trim().toUpperCase()))) continue; // already owned
      if (handled.has(key) || skips.has(skipKey(d.instance, d.domain)) || hasBurntTag(d.tags)) continue;

      const hist = lastTags.get(`${d.instance}:${d.domain.toLowerCase()}`);
      // Only OWNERSHIP events justify a restore. If the last client-tag event
      // is a release (removed / cancel_queued / trimmed), the system took this
      // domain away from that client ON PURPOSE — restoring would undo the
      // replacement engine's own work (the first dry run tried to hand CCGW
      // back its removed burnt domains). Disconnects lose tags silently, so a
      // reconnect-loss always shows tagged/attached as the last owner event.
      // Strictly {tagged, attached}: 'detected'/'proposed' mean flagged-burnt
      // (a later manual untag would be undone by restoring), and manual bulk
      // removes don't yet write per-domain release events — until they do,
      // this cron must not run unattended (supervised sweeps only).
      const OWNERSHIP = new Set(["tagged", "attached"]);
      const histTag = hist && OWNERSHIP.has(hist.eventType) && !isOffboardedTagName(hist.tag, offboarded) && known.has(hist.tag) ? hist : null;

      if (histTag) {
        const group = alloc.map[histTag.tag] ?? null;
        restores.push({
          instance: d.instance, domain: d.domain, tag: histTag.tag, source: "history",
          historyAt: histTag.at,
          groupMismatch: group !== null && group !== getInstance(d.instance).group,
        });
        continue;
      }

      const veteran = (d.total_sent ?? 0) > 0;
      if (!veteran) continue; // fresh stock — reserve is where it belongs

      if (redirectFallback) {
        const tag = tagByRedirect.get(norm(d.redirect_url));
        if (tag && known.has(tag) && !isOffboardedTagName(tag, offboarded)) {
          const group = alloc.map[tag] ?? null;
          restores.push({
            instance: d.instance, domain: d.domain, tag, source: "redirect",
            groupMismatch: group !== null && group !== getInstance(d.instance).group,
          });
          continue;
        }
      }
      taglessVeterans.push({ instance: d.instance, domain: d.domain });
    }

    const work = restores.slice(0, cap);
    let restored = 0;
    const failures: { domain: string; error: string }[] = [];

    if (!dryRun) {
      // Resolve/create each needed tag NAME per instance once (ids are per-instance).
      const tagIdCache = new Map<string, number>(); // `${instance}:${TAG}` → id
      const resolveTag = async (instance: BisonInstanceSlug, name: string): Promise<number | null> => {
        const ck = `${instance}:${name}`;
        if (tagIdCache.has(ck)) return tagIdCache.get(ck)!;
        const list = await bisonFetch(instance, `/tags`);
        if (list.ok) {
          const j = await list.json().catch(() => null);
          const hit = (j?.data || []).find((t: { id: number; name: string }) => (t.name || "").trim().toUpperCase() === name);
          if (hit) { tagIdCache.set(ck, hit.id); return hit.id; }
        }
        const created = await bisonFetch(instance, `/tags`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!created.ok) return null;
        const cj = await created.json().catch(() => null);
        const id = cj?.data?.id;
        if (typeof id === "number") { tagIdCache.set(ck, id); return id; }
        return null;
      };

      for (const r of work) {
        try {
          const tagId = await resolveTag(r.instance, r.tag);
          if (tagId === null) throw new Error("could not resolve/create tag in Bison");
          const { data: inb } = await supabase
            .from("deliverability_inboxes").select("id").eq("instance", r.instance).eq("domain", r.domain).limit(1000);
          const ids = ((inb || []) as { id: number }[]).map((i) => i.id);
          for (let i = 0; i < ids.length; i += 100) {
            const res = await bisonFetch(r.instance, `/tags/attach-to-sender-emails`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag_ids: [tagId], sender_email_ids: ids.slice(i, i + 100) }),
            });
            if (!res.ok) throw new Error(`attach HTTP ${res.status}`);
            await new Promise((s) => setTimeout(s, 600));
          }
          // Mirror the tag so conform/orphan-attach/reserve math see it now,
          // not two crawl-days from now.
          const row = doms.find((d) => d.instance === r.instance && d.domain === r.domain);
          const newTags = [...new Set([...(row?.tags || []), r.tag])];
          await supabase.from("deliverability_domains").update({ tags: newTags }).eq("instance", r.instance).eq("domain", r.domain);

          restored++;
          await logEvents([{
            instance: r.instance, domain: r.domain, clientTag: r.tag, eventType: "tagged",
            detail: r.source === "history"
              ? `memory restore: last client tag ${r.tag} (history ${String(r.historyAt).slice(0, 10)}) reapplied after reconnect — ${ids.length} inbox(es)`
              : `memory restore (redirect fallback, supervised sweep): ${r.tag} inferred from redirect — ${ids.length} inbox(es)`,
            signals: { source: r.source, inboxes: ids.length, groupMismatch: r.groupMismatch },
          }]);

          if (r.groupMismatch) {
            await recordPipelineAlert({
              source: "tag-memory", clientTag: r.tag, step: "group-mismatch",
              reason: `restored ${r.tag} on ${r.domain} but it sits in ${r.instance} (wrong group for this client) — needs a move or a decision`,
              domains: [r.domain], silent: true,
            });
          }
        } catch (e) {
          failures.push({ domain: r.domain, error: e instanceof Error ? e.message.slice(0, 120) : "failed" });
        }
      }

      // Tagless veterans: never guessed — surfaced.
      for (const v of taglessVeterans.slice(0, 20)) {
        await recordPipelineAlert({
          source: "tag-memory", clientTag: null, step: "tagless-veteran",
          reason: `${v.domain} (${v.instance}) has sending history but no client tag and no tag history — needs a human call`,
          domains: [v.domain], silent: true,
        });
      }
    }

    return NextResponse.json({
      dryRun, redirectFallback,
      candidates: restores.length,
      processed: work.length,
      restored,
      remaining: Math.max(0, restores.length - work.length),
      taglessVeterans: taglessVeterans.length,
      groupMismatches: work.filter((r) => r.groupMismatch).length,
      failures,
      list: work.map((r) => `${r.instance}:${r.domain} → ${r.tag} (${r.source}${r.groupMismatch ? ", WRONG GROUP" : ""})`),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "tag-memory-restore failed" }, { status: 500 });
  }
}
