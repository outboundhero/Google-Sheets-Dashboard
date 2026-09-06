import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, senderSearchTerm, emailIsOnDomain } from "@/lib/bison";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/orphan-attach — closes the provisioning → replacement handoff
// gap (the CCGW 14, 2026-08-29).
//
// Domains ordered FOR a client arrive in Bison already carrying the client's
// tag — the order flow tags them at upload. The replacement engine only
// auto-attaches domains IT assigns from reserve, so a pre-tagged arrival never
// fires that path: the engine sees "already a client's domain" and assumes
// whoever tagged it finished the launch. Launch (attach to campaigns) was an
// unwritten manual step; when uploads came late and in bulk (the Inboxing
// backlog pushed Aug 18–19) the step was missed and 37 tagged domains sat
// attached to nothing — or to an ex-client's archived campaigns — sending zero.
//
// This cron owns that orphan state. A candidate is a client-tagged domain,
// warmed (≥21d, the same domain-age rule the manual attach flow uses), not
// Burnt, not leaving, whose inboxes have all sent 0 emails. Each candidate is
// re-verified LIVE in Bison before anything happens: if its inboxes are
// already attached to one of its own client's live campaigns it is skipped
// (the warmup-graduation cron handles its limits). Only genuinely unattached
// domains get attached — to every non-archived/completed campaign carrying
// their tag in their instance, exactly the set the manual dialog would offer.
//
// Small cap per run + live verification per domain: this is a repair loop,
// not a bulk mover. ?dry=1 previews. Failures are logged as events so they
// surface on the dashboard instead of vanishing.

const RUN_CAP = 10;            // domains per run — repair loop, not a bulk mover
const WARMUP_DAYS = 21;        // domain-age rule, same as the manual attach flow
const DEAD = new Set(["archived", "completed"]);

interface CampaignRow { id: number; instance: BisonInstanceSlug; client_tag: string | null; status: string; name: string }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const cap = Math.max(1, Number(url.searchParams.get("limit") ?? RUN_CAP) || RUN_CAP);

    const supabase = getSupabaseAdmin();
    const handled = await getHandledDomains();

    // Campaign universe → client tags + per (tag, instance) attachable sets.
    const campaigns: CampaignRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, instance, client_tag, status, name")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      campaigns.push(...(data as CampaignRow[]));
      if (data.length < 1000) break;
    }
    const knownTags = new Set<string>();
    const attachable = new Map<string, CampaignRow[]>(); // `${TAG}:${instance}`
    for (const c of campaigns) {
      const tag = (c.client_tag || "").trim().toUpperCase();
      if (!tag) continue;
      knownTags.add(tag);
      if (DEAD.has(String(c.status || "").toLowerCase())) continue;
      const k = `${tag}:${c.instance}`;
      if (!attachable.has(k)) attachable.set(k, []);
      attachable.get(k)!.push(c);
    }

    // Candidate domains: client-tagged, warmed, not burnt, not leaving.
    const cutoff = new Date(Date.now() - WARMUP_DAYS * 86_400_000).toISOString();
    interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null; domain_created_at: string | null }
    const tagged: (DomRow & { tag: string })[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, domain_created_at")
        .in("instance", ALL_INSTANCE_SLUGS)
        .lte("domain_created_at", cutoff)
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as DomRow[]) {
        if (handled.has(`${d.instance}:${d.domain}`) || hasBurntTag(d.tags)) continue;
        const tag = (d.tags || []).map((t) => String(t).trim().toUpperCase()).find((t) => knownTags.has(t));
        if (tag) tagged.push({ ...d, tag });
      }
      if (data.length < 1000) break;
    }

    // Never-sent filter from the mirror's per-inbox sends (cheap pre-filter;
    // each survivor is re-verified live below).
    const candidates: (DomRow & { tag: string })[] = [];
    for (const d of tagged) {
      if (candidates.length >= cap * 3) break; // enough to fill the cap after live checks
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("emails_sent_count")
        .eq("instance", d.instance)
        .eq("domain", d.domain)
        .limit(1000);
      const rows = (data || []) as { emails_sent_count: number | null }[];
      if (rows.length === 0) continue;
      if (rows.every((r) => (r.emails_sent_count ?? 0) === 0)) candidates.push(d);
    }

    interface Result {
      instance: string; domain: string; tag: string;
      action: "attached" | "skip" | "error";
      detail: string;
      campaigns?: string[];
      inboxes?: number;
    }
    const results: Result[] = [];
    let attachedDomains = 0;

    for (const d of candidates) {
      if (attachedDomains >= cap) break;
      const camps = attachable.get(`${d.tag}:${d.instance}`) || [];
      if (camps.length === 0) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "no live campaign for this tag in this instance" });
        continue;
      }

      // LIVE verification — inboxes + current attachments.
      const sr = await bisonFetch(d.instance, `/sender-emails?search=${encodeURIComponent(senderSearchTerm(d.domain))}&per_page=100`);
      if (!sr.ok) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "error", detail: `Bison inbox lookup HTTP ${sr.status}` });
        continue;
      }
      // Exact-domain filter is load-bearing: the newer Bison on FR/OC returns
      // OTHER domains' senders for a query with no hits — attaching those
      // would put another client's inboxes into this tag's campaigns.
      const inboxes = ((((await sr.json()) as { data?: { id: number; email?: string; emails_sent_count?: number }[] }).data) || [])
        .filter((i) => emailIsOnDomain(i.email, d.domain));
      if (inboxes.length === 0) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "no inboxes in Bison (stale mirror row)" });
        continue;
      }
      if (inboxes.some((i) => (Number(i.emails_sent_count) || 0) > 0)) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "already sending (mirror stale)" });
        continue;
      }
      const cr = await bisonFetch(d.instance, `/sender-emails/${inboxes[0].id}/campaigns`);
      if (cr.ok) {
        const attachedTo = (((await cr.json()) as { data?: { name?: string; status?: string }[] }).data) || [];
        const ownLive = attachedTo.some((c) => {
          const prefix = String(c.name || "").split(":")[0].trim().toUpperCase();
          return prefix === d.tag && !DEAD.has(String(c.status || "").toLowerCase());
        });
        if (ownLive) {
          results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "already attached to its client's live campaigns — graduation cron owns the ramp" });
          continue;
        }
      }

      if (dryRun) {
        results.push({
          instance: d.instance, domain: d.domain, tag: d.tag, action: "attached",
          detail: `DRY — would attach ${inboxes.length} inbox(es) to ${camps.length} campaign(s)`,
          campaigns: camps.map((c) => c.name), inboxes: inboxes.length,
        });
        attachedDomains++;
        continue;
      }

      // Attach every inbox to every live campaign of the tag.
      const ids = inboxes.map((i) => i.id);
      const okCamps: string[] = [];
      let failDetail = "";
      for (const c of camps) {
        const res = await bisonFetch(d.instance, `/campaigns/${c.id}/attach-sender-emails`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender_email_ids: ids }),
        });
        if (res.ok) okCamps.push(c.name);
        else failDetail += `${c.name}: HTTP ${res.status}; `;
      }

      if (okCamps.length > 0) {
        attachedDomains++;
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "attached", detail: `attached ${ids.length} inbox(es) to ${okCamps.length}/${camps.length} campaign(s)`, campaigns: okCamps, inboxes: ids.length });
        await logEvents([{
          instance: d.instance, domain: d.domain, clientTag: d.tag, eventType: "attached",
          detail: `orphan-attach: pre-tagged domain was in no campaign — attached ${ids.length} inbox(es) to ${okCamps.length} ${d.tag} campaign(s)${failDetail ? ` (failed: ${failDetail.trim()})` : ""}`,
          signals: { inboxes: ids.length, campaigns: okCamps },
        }]);
      } else {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "error", detail: `all attaches failed — ${failDetail.trim()}` });
        await logEvents([{
          instance: d.instance, domain: d.domain, clientTag: d.tag, eventType: "error",
          detail: `orphan-attach: could not attach to any ${d.tag} campaign — ${failDetail.trim()}`,
        }]);
      }
    }

    return NextResponse.json({
      dryRun,
      candidatesChecked: candidates.length,
      attached: results.filter((r) => r.action === "attached").length,
      skipped: results.filter((r) => r.action === "skip").length,
      errors: results.filter((r) => r.action === "error").length,
      results,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "orphan-attach failed" },
      { status: 500 },
    );
  }
}
