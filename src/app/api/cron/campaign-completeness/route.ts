import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { fetchCampaignSenderEmails } from "@/lib/attach-campaigns";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { getOffboardedClientTags, isOffboardedTagName } from "@/lib/offboarded-tags";

export const maxDuration = 300;

// GET /api/cron/campaign-completeness — every healthy tagged sender is in every
// live campaign of its client. Daily at 7:30 AM PT (Spencer's Loom, 2026-09-16:
// "run in the morning when campaigns are no longer processing… add all client
// tagged accounts that are healthy to the correct client tag campaign").
//
// Why a second pass next to orphan-attach: that cron judges a DOMAIN attached
// from a few sampled senders, so a domain with 40 of 49 senders in a campaign
// looks done and the 9 never arrive (JPCO, Nick 2026-09-23: "maybe it just
// didn't capture all of the email accounts for a couple of domains"). This
// pass compares the campaign's full sender list against the client's tagged
// inboxes and attaches exactly the difference. Per-sender, not per-domain.
//
// Rules: active + paused campaigns only (never draft/queued/archived/completed
// — going live is a human step, Nick 2026-09-22); no churned clients; no
// burnt / removed / handled domains. Attaching never changes a campaign's
// status. ?dry=1 previews. One audit event per client with a diff; nothing
// posts to Slack. Time-budgeted; the next day's run picks up where it stopped.

const ATTACHABLE = new Set(["active", "paused"]);
const BUDGET_MS = 240_000;
const BATCH = 100;

interface CampaignRow { id: number; instance: BisonInstanceSlug; client_tag: string | null; status: string; name: string }

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const onlyTag = (url.searchParams.get("tag") || "").trim().toUpperCase() || null;

    const supabase = getSupabaseAdmin();
    const [handled, offboarded] = await Promise.all([getHandledDomains(), getOffboardedClientTags()]);

    // Live campaigns per (tag, instance).
    const campaigns: CampaignRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns").select("id, instance, client_tag, status, name")
        .order("id", { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      campaigns.push(...(data as CampaignRow[]));
      if (data.length < 1000) break;
    }
    const byKey = new Map<string, CampaignRow[]>();
    for (const c of campaigns) {
      const tag = (c.client_tag || "").trim().toUpperCase();
      if (!tag || !ATTACHABLE.has(String(c.status || "").toLowerCase())) continue;
      if (isOffboardedTagName(tag, offboarded)) continue;
      if (onlyTag && tag !== onlyTag) continue;
      const k = `${tag}:${c.instance}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(c);
    }

    // Healthy tagged inbox ids per (tag, instance), from the mirror.
    interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null }
    const domainsByKey = new Map<string, string[]>();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains").select("instance, domain, tags")
        .in("instance", ALL_INSTANCE_SLUGS).order("domain", { ascending: true }).range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as DomRow[]) {
        if (handled.has(`${d.instance}:${d.domain}`) || hasBurntTag(d.tags)) continue;
        for (const t of d.tags || []) {
          const tag = String(t).trim().toUpperCase();
          const k = `${tag}:${d.instance}`;
          if (!byKey.has(k)) continue;
          if (!domainsByKey.has(k)) domainsByKey.set(k, []);
          domainsByKey.get(k)!.push(d.domain);
        }
      }
      if (data.length < 1000) break;
    }

    interface ClientResult { tag: string; instance: string; domains: number; inboxes: number; campaigns: number; missingBefore: number; attached: number; errors: string[] }
    const results: ClientResult[] = [];
    let budgetHit = false;

    // Clients with the most domains first — they are where a partial attach costs the most.
    const keys = [...byKey.keys()].sort((a, b) => (domainsByKey.get(b)?.length ?? 0) - (domainsByKey.get(a)?.length ?? 0));
    for (const k of keys) {
      if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
      const [tag, instance] = k.split(":") as [string, BisonInstanceSlug];
      const domains = domainsByKey.get(k) ?? [];
      if (domains.length === 0) continue;

      // All inbox ids for the client's domains on this instance.
      const inboxIds = new Set<number>();
      for (let i = 0; i < domains.length; i += 100) {
        const { data } = await supabase
          .from("deliverability_inboxes").select("id").eq("instance", instance).in("domain", domains.slice(i, i + 100)).limit(10000);
        for (const r of (data || []) as { id: number }[]) inboxIds.add(r.id);
      }
      if (inboxIds.size === 0) continue;

      const res: ClientResult = { tag, instance, domains: domains.length, inboxes: inboxIds.size, campaigns: 0, missingBefore: 0, attached: 0, errors: [] };
      for (const c of byKey.get(k)!) {
        if (Date.now() - startedAt > BUDGET_MS) { budgetHit = true; break; }
        res.campaigns++;
        let onCampaign: Set<number>;
        try {
          onCampaign = new Set(await fetchCampaignSenderEmails(instance, c.id));
        } catch (e) {
          res.errors.push(`${c.name}: list ${e instanceof Error ? e.message : "failed"}`);
          continue;
        }
        const missing = [...inboxIds].filter((id) => !onCampaign.has(id));
        res.missingBefore += missing.length;
        if (missing.length === 0 || dryRun) continue;
        for (let i = 0; i < missing.length; i += BATCH) {
          const batch = missing.slice(i, i + BATCH);
          const r = await bisonFetch(instance, `/campaigns/${c.id}/attach-sender-emails`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sender_email_ids: batch }),
          });
          if (r.ok) res.attached += batch.length;
          else res.errors.push(`${c.name}: attach HTTP ${r.status}`);
        }
      }
      results.push(res);
      if (!dryRun && (res.missingBefore > 0 || res.errors.length > 0)) {
        await logEvents([{
          instance, clientTag: tag, eventType: res.errors.length ? "error" : "attached",
          detail: `campaign-completeness: ${res.missingBefore} missing sender slot(s) across ${res.campaigns} campaign(s) — attached ${res.attached}${res.errors.length ? ` · ${res.errors.length} error(s)` : ""}`,
          signals: { kind: "campaign_completeness", ...res },
        }]).catch(() => undefined);
      }
    }

    if (!dryRun) {
      await logEvents([{
        eventType: "proposed",
        detail: `campaign-completeness run: ${results.length} client(s) checked · ${results.reduce((s, r) => s + r.missingBefore, 0)} missing · ${results.reduce((s, r) => s + r.attached, 0)} attached · ${Math.round((Date.now() - startedAt) / 1000)}s${budgetHit ? " · budget hit, continues tomorrow" : ""}`,
        signals: { kind: "campaign_completeness_run", budgetHit, clients: results.length },
      }]).catch(() => undefined);
    }

    return NextResponse.json({
      dryRun, budgetHit, clientsChecked: results.length, elapsedMs: Date.now() - startedAt,
      totalMissing: results.reduce((s, r) => s + r.missingBefore, 0),
      totalAttached: results.reduce((s, r) => s + r.attached, 0),
      results: results.filter((r) => r.missingBefore > 0 || r.errors.length > 0),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "campaign-completeness failed" }, { status: 500 });
  }
}
