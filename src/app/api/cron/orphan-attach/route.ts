import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, senderSearchTerm, emailIsOnDomain } from "@/lib/bison";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { loadFirstCreated, effectiveAgeDays } from "@/lib/replacement/domain-age";
import { recordPipelineAlert, resolveAlertsForClients } from "@/lib/pipeline-alerts";

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
// Nick 2026-09-17 (JPDET): a client that has not launched must not be touched
// by this cron. Only campaigns that are genuinely running or deliberately
// paused get senders; draft/queued/launching are a human launch decision.
const ATTACHABLE = new Set(["active", "paused"]);
const ALERT_SOURCE = "orphan-attach";
const ALERT_STEP = "tagged-not-attached";
const YOUNG_CHECK_CAP = 40;
const SENDER_MAX_PAGES = 8;
const SCAN_BUDGET_MS = 200_000;  // leave room for the young check + summary before Vercel's 300 s    // 8 × 15 covers a 49-sender domain twice over    // live lookups per run for the under-age set

interface CampaignRow { id: number; instance: BisonInstanceSlug; client_tag: string | null; status: string; name: string }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";
    const cap = Math.max(1, Number(url.searchParams.get("limit") ?? RUN_CAP) || RUN_CAP);

    const startedAt = Date.now();
    const supabase = getSupabaseAdmin();
    const [handled, firstCreated] = await Promise.all([getHandledDomains(), loadFirstCreated()]);

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
      if (!ATTACHABLE.has(String(c.status || "").toLowerCase())) continue;
      const k = `${tag}:${c.instance}`;
      if (!attachable.has(k)) attachable.set(k, []);
      attachable.get(k)!.push(c);
    }

    // Candidate domains: client-tagged, warmed, not burnt, not leaving. Age is
    // the effective one (first-ever-seen beats the Bison upload date) — the
    // JPLV dozen were months-old re-uploads that read as 12 days old here.
    const nowMs = Date.now();
    interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null; domain_created_at: string | null }
    const tagged: (DomRow & { tag: string })[] = [];
    // Tagged but too young to attach: not this cron's job to launch them, but
    // silence is how JPLV sat unnoticed. They get a dashboard alert (no Slack).
    const youngTagged: (DomRow & { tag: string })[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, domain_created_at")
        .in("instance", ALL_INSTANCE_SLUGS)
        .order("domain", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const d of data as DomRow[]) {
        if (handled.has(`${d.instance}:${d.domain}`) || hasBurntTag(d.tags)) continue;
        const tag0 = (d.tags || []).map((t) => String(t).trim().toUpperCase()).find((t) => knownTags.has(t));
        if (tag0 && effectiveAgeDays(d.domain, d.domain_created_at, firstCreated, nowMs) < WARMUP_DAYS) {
          youngTagged.push({ ...d, tag: tag0 });
          continue;
        }
        const tag = (d.tags || []).map((t) => String(t).trim().toUpperCase()).find((t) => knownTags.has(t));
        if (tag) tagged.push({ ...d, tag });
      }
      if (data.length < 1000) break;
    }

    // Never-sent filter from the mirror's per-inbox sends (cheap pre-filter;
    // each survivor is re-verified live below).
    // Round-robin across client tags: the alphabetical first-N window starved
    // clients late in the alphabet (JPDET sat unattached behind CCG*/IJSD/JPCL
    // for a day, 2026-09-17). Take one domain per tag per pass until the window
    // is full, so every client gets a turn every run.
    const byTag = new Map<string, (DomRow & { tag: string })[]>();
    for (const d of tagged) {
      if (!byTag.has(d.tag)) byTag.set(d.tag, []);
      byTag.get(d.tag)!.push(d);
    }
    const roundRobin: (DomRow & { tag: string })[] = [];
    for (let i = 0; roundRobin.length < tagged.length; i++) {
      let took = false;
      for (const list of byTag.values()) if (i < list.length) { roundRobin.push(list[i]); took = true; }
      if (!took) break;
    }
    // The whole pool is a candidate. A fixed window of cap×3 was eaten by
    // domains that are attached but idle (draft/paused campaigns, 0 sends), so
    // four freshly launched clients got nothing for four days (2026-09-18 →
    // 21). The cap now bounds ATTACHES; a time budget bounds the scan.
    const candidates: (DomRow & { tag: string })[] = [];
    for (const d of roundRobin) {
      if (Date.now() - startedAt > SCAN_BUDGET_MS) break;
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
      if (Date.now() - startedAt > SCAN_BUDGET_MS) break;
      const camps = attachable.get(`${d.tag}:${d.instance}`) || [];
      if (camps.length === 0) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "no live campaign for this tag in this instance" });
        continue;
      }
      // Cheap first probe on one mirrored inbox: most idle-tagged domains are
      // already in their client's campaigns (draft/paused, 0 sends). Only a
      // domain that looks unattached pays for the full sender walk below.
      {
        const { data: one } = await supabase
          .from("deliverability_inboxes").select("id").eq("instance", d.instance).eq("domain", d.domain).limit(1);
        const firstId = (one?.[0] as { id: number } | undefined)?.id;
        if (firstId) {
          const pr = await bisonFetch(d.instance, `/sender-emails/${firstId}/campaigns`);
          if (pr.ok) {
            const on = (((await pr.json()) as { data?: { name?: string; status?: string }[] }).data) || [];
            const ownLive = on.some((c) => String(c.name || "").split(":")[0].trim().toUpperCase() === d.tag && !DEAD.has(String(c.status || "").toLowerCase()));
            if (ownLive) {
              results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "already attached to its client's live campaigns — graduation cron owns the ramp" });
              continue;
            }
          }
        }
      }

      // LIVE verification — ALL inboxes + current attachments. Bison caps
      // per_page at 15, so a single page attached 15 of a 49-sender domain and
      // called it done (buildingserviceexperts.info, 2026-09-17). Page through.
      type Sender = { id: number; email?: string; emails_sent_count?: number };
      const inboxes: Sender[] = [];
      let lookupFailed: number | null = null;
      for (let page = 1; page <= SENDER_MAX_PAGES; page++) {
        const sr = await bisonFetch(d.instance, `/sender-emails?search=${encodeURIComponent(senderSearchTerm(d.domain))}&page=${page}&per_page=15`);
        if (!sr.ok) { lookupFailed = sr.status; break; }
        const rows = (((await sr.json()) as { data?: Sender[] }).data) || [];
        // Exact-domain filter is load-bearing: the newer Bison on FR/OC returns
        // OTHER domains' senders for a query with no hits — attaching those
        // would put another client's inboxes into this tag's campaigns.
        inboxes.push(...rows.filter((i) => emailIsOnDomain(i.email, d.domain)));
        if (rows.length < 15) break;
      }
      if (lookupFailed !== null) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "error", detail: `Bison inbox lookup HTTP ${lookupFailed}` });
        continue;
      }
      if (inboxes.length === 0) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "no inboxes in Bison (stale mirror row)" });
        continue;
      }
      if (inboxes.some((i) => (Number(i.emails_sent_count) || 0) > 0)) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "already sending (mirror stale)" });
        continue;
      }
      // "Already attached" is judged on first, middle and last sender, not one:
      // a re-upload can leave the newest senders outside while the rest are in.
      // Attach is idempotent, so a mixed domain simply gets every id re-sent.
      const probe = [inboxes[0], inboxes[Math.floor(inboxes.length / 2)], inboxes[inboxes.length - 1]]
        .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
      let allOnOwnLive = true;
      for (const s of probe) {
        const cr = await bisonFetch(d.instance, `/sender-emails/${s.id}/campaigns`);
        if (!cr.ok) { allOnOwnLive = false; break; }
        const attachedTo = (((await cr.json()) as { data?: { name?: string; status?: string }[] }).data) || [];
        const ownLive = attachedTo.some((c) => {
          const prefix = String(c.name || "").split(":")[0].trim().toUpperCase();
          return prefix === d.tag && !DEAD.has(String(c.status || "").toLowerCase());
        });
        if (!ownLive) { allOnOwnLive = false; break; }
      }
      if (allOnOwnLive) {
        results.push({ instance: d.instance, domain: d.domain, tag: d.tag, action: "skip", detail: "already attached to its client's live campaigns — graduation cron owns the ramp" });
        continue;
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

    // Under-age tagged domains in no live campaign of their client → one open
    // alert per client tag on the dashboard (silent: the daily digest / a human
    // decides whether to launch early). Cleared when the set empties.
    // Sample up to 3 domains per (tag, instance) group — a per-domain cap let
    // three big groups exhaust the budget and the fourth was never looked at
    // (and then wrongly cleared). Only groups actually probed can be resolved.
    const youngGroups = new Map<string, (DomRow & { tag: string })[]>(); // `${tag}:${instance}`
    for (const d of youngTagged) {
      if ((attachable.get(`${d.tag}:${d.instance}`) || []).length === 0) continue;
      const k = `${d.tag}:${d.instance}`;
      if (!youngGroups.has(k)) youngGroups.set(k, []);
      youngGroups.get(k)!.push(d);
    }
    const unattachedYoung = new Map<string, string[]>(); // tag → domains
    const probedTags = new Set<string>();
    let youngChecked = 0;
    for (const [k, group] of youngGroups) {
      if (youngChecked >= YOUNG_CHECK_CAP) break;
      const tag = k.split(":")[0];
      let anyOutside = false;
      let probes = 0;
      for (const d of group) {
        if (probes >= 3) break;
        const { data } = await supabase
          .from("deliverability_inboxes")
          .select("id, emails_sent_count")
          .eq("instance", d.instance)
          .eq("domain", d.domain)
          .limit(1000);
        const rows = (data || []) as { id: number; emails_sent_count: number | null }[];
        if (rows.length === 0 || rows.some((r) => (r.emails_sent_count ?? 0) > 0)) continue;
        probes++; youngChecked++;
        const cr = await bisonFetch(d.instance, `/sender-emails/${rows[0].id}/campaigns`);
        if (!cr.ok) continue;
        const attachedTo = (((await cr.json()) as { data?: { name?: string; status?: string }[] }).data) || [];
        const ownLive = attachedTo.some((c) => String(c.name || "").split(":")[0].trim().toUpperCase() === tag && !DEAD.has(String(c.status || "").toLowerCase()));
        if (!ownLive) { anyOutside = true; break; }
      }
      if (probes === 0) continue;
      probedTags.add(tag);
      if (anyOutside) {
        if (!unattachedYoung.has(tag)) unattachedYoung.set(tag, []);
        unattachedYoung.get(tag)!.push(...group.map((d) => `${d.instance}:${d.domain}`));
      }
    }
    if (!dryRun) {
      for (const [tag, doms] of unattachedYoung) {
        await recordPipelineAlert({
          source: ALERT_SOURCE, clientTag: tag, step: ALERT_STEP, silent: true,
          reason: `${doms.length} ${tag}-tagged domain(s) under 21 days old are in none of ${tag}'s live campaigns (0 sends). Attach early or wait for warmup.`,
          domains: doms.map((x) => x.split(":")[1]),
        });
      }
      const clearTags = [...probedTags].filter((t) => !unattachedYoung.has(t));
      if (clearTags.length > 0) await resolveAlertsForClients(ALERT_SOURCE, clearTags);
    }

    if (!dryRun) {
      const skipReasons: Record<string, number> = {};
      for (const r of results) if (r.action === "skip") skipReasons[r.detail.slice(0, 40)] = (skipReasons[r.detail.slice(0, 40)] || 0) + 1;
      // "proposed" is the run-level note type nothing aggregates — the daily
      // Slack report and the dashboard widget count skipped/attached/removed,
      // not this. Audit trail only.
      await logEvents([{
        eventType: "proposed",
        detail: `orphan-attach run: pool ${tagged.length} · candidates ${candidates.length} · attached ${attachedDomains} · skipped ${results.filter((r) => r.action === "skip").length} · errors ${results.filter((r) => r.action === "error").length} · ${Math.round((Date.now() - startedAt) / 1000)}s`,
        signals: { kind: "orphan_attach_run", pool: tagged.length, candidates: candidates.length, attached: attachedDomains, skipReasons, budgetHit: Date.now() - startedAt > SCAN_BUDGET_MS },
      }]).catch(() => undefined);
    }

    return NextResponse.json({
      dryRun,
      youngTaggedUnattached: Object.fromEntries(unattachedYoung),
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
