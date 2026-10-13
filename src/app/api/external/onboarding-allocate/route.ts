import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";
import { capFor, getClientTiers, type ClientTier } from "@/lib/replacement/client-tiers";
import { instancesInGroup, parseGroup, type BisonGroup, type BisonInstance } from "@/lib/bison-instances";
import { getGroupForClientTag } from "@/lib/client-tag-allocations";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { runExecution, type ExecStep } from "@/lib/replacement/execute-runner";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { logEvents } from "@/lib/replacement/store";
import { loadRedirectsByTag } from "@/lib/replacement/redirect-audit";
import { getConfig } from "@/lib/sheets-config";
import { POST as bulkLimits } from "@/app/api/deliverability/bulk-limits/route";
import { POST as attachDomains } from "@/app/api/deliverability/attach-domains-to-campaign/route";
import { runSecretProblem, withLock } from "@/lib/onboarding-run";

// POST /api/external/onboarding-allocate   (Bearer EXTERNAL_API_TOKEN, middleware-exempt)
//
// Reply Router's onboarding checklist ("Attach client tags / redirects / add to
// campaigns") asks which reserve domains a brand-new client would be given.
// The true-up fill deliberately leaves a client that is not sending yet alone
// (initial domains are manual until the onboarding automation — Nick
// 2026-09-22); this is that automation's LeadSync side.
//
// { dryRun: true } reports the plan and stops — nothing is tagged, redirected,
// attached or emailed.
//
// { dryRun: false } RUNS one batch for one instance. It is off by default and
// refused unless BOTH hold: ONBOARDING_ALLOCATE_ENABLED=1 is set, and the
// caller carries the run secret (src/lib/onboarding-run.ts — its own secret,
// no fallback; the feed token alone can never move a domain).
//
// A run takes a lock on the instance first and builds its plan INSIDE the
// lock, so two batches — for the same client or for two clients of a group —
// can never be working from the same list of spare domains. It then refuses
// unless everything a new client needs is already in place, because each of
// these, found out half-way, would leave domains tagged but not usable:
//   • the tag is in the Client Tracker (it has a tier);
//   • LeadSync knows the client's website. That is what makes a tag a CLIENT
//     here (true-up: knownTags) — without it the client's new domains would
//     still count as spare and could be handed to someone else — and it is
//     the redirect the daily redirect check enforces, so it is the one used;
//   • the client has a tracked sheet (its Domains tab is written to);
//   • the group matches the allocation sheet (a failed read refuses);
//   • every domain is one the plan would give right now, the batch keeps the
//     client at or under its tier cap, and every campaign is the client's.
// The batch goes to the same execution runner the true-up fill uses (tag →
// redirect → attach → client sheet → whitelist queue). What it reports is then
// CHECKED rather than trusted: every step must be done (a "degraded" or
// "skipped" step is not a success), the domains must show the tag, every
// campaign must have matched senders, and the daily limit must have reached
// every sender. The daily limit is applied to ALL of the client's domains on
// the instance, before and after the batch, so a batch that was cut off
// earlier is put right by the next one. At most MAX_BATCH domains a call.
//
// Same stock rules as the true-up, by construction: candidates come from
// computeTrueUp().reserveLeft — untagged, at least 21 days old, not Burnt, not
// blacklisted — i.e. what is still unspent AFTER every live client's fill has
// earmarked its share. Caps are the tier caps (client-tiers.ts).
//
// Stricter than the true-up, because this plan is acted on for a client nobody
// has seen run yet:
//   • the client's own domains are counted from a full read of the group's
//     instances, whatever the capitals of the tag — a failed read stops the
//     plan (read as "none yet", it would hand a full tier to a client that
//     already holds one);
//   • a candidate carrying ANY Client Tracker tag, or the client's own, is set
//     aside (the true-up only knows clients with a website or campaigns).
//
// Body:  { clientTag, group: 1 | 2, tier?: "0.5" | "1" | "2", dryRun: true }
//        tier defaults to the Client Tracker's, else "1" (same default as
//        normalizeTier — the low cap, so a missing tier never over-allocates).
// 200:   { dryRun, clientTag, group, tier, tierSource, generatedFor,
//          allocationGroup, groupMismatch, groupReadFailed,
//          inTracker, knownRedirect, sheetTag, runBlockers,
//          instances: [{ instance, label, side, cap, alreadyTagged, need,
//                        reserveAvailable, setAside, picking, short, note }] }
//        allocationGroup = the group the allocation sheet has this tag in
//        (null if it isn't there yet); groupMismatch = it differs from `group`.
//        runBlockers = why a run would be refused right now (empty = it wouldn't).
//
// Run:   { clientTag, group, tier?, dryRun: false, instance, domains[],
//          redirectUrl, campaignIds[], dailyLimit? (default 3) }
// 200:   { ok, clientTag, instance, added, steps: [{ label, state, note }],
//          limit: { updated, failed, total } | { error },
//          checks: { tagged, attach: [{ campaignId, matched, problem? }] },
//          problems: [...] }

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const maxDuration = 300;

const TIERS: readonly ClientTier[] = ["0.5", "1", "2"];
/** Domains per run call (≈ 49 inboxes each) — keeps a call inside the budget. */
const MAX_BATCH = 5;
const MAX_CAMPAIGNS = 6;
const DEFAULT_DAILY_LIMIT = 3;
/** Longer than the function can live, so a lock always outlasts its run. */
const LOCK_SECONDS = 330;
/** The true-up's reasons for leaving a client that isn't sending yet to "manual" — true of every new client, and exactly what this route is for. */
const NOT_LIVE_YET = /no live campaign|not live yet|initial fill is manual/i;

interface Body {
  clientTag?: string;
  group?: unknown;
  tier?: unknown;
  dryRun?: boolean;
  instance?: string;
  domains?: unknown;
  redirectUrl?: unknown;
  campaignIds?: unknown;
  dailyLimit?: unknown;
}

interface Side {
  instance: string;
  label: string;
  side: string;
  cap: number;
  alreadyTagged: number;
  need: number;
  reserveAvailable: number;
  setAside: number;
  picking: string[];
  short: number;
  note: string | null;
}

interface Plan {
  tier: ClientTier;
  tierSource: string;
  generatedFor: string;
  allocationGroup: BisonGroup | null;
  groupReadFailed: boolean;
  inTracker: boolean;
  knownRedirect: string | null;
  sheetTag: string | null;
  runBlockers: string[];
  sides: Side[];
  /** instance → the client's own domains there (any capitals of the tag). */
  own: Map<string, string[]>;
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
const hasTag = (tags: string[] | null, upper: string) => (tags || []).some((t) => String(t).trim().toUpperCase() === upper);

/** Same site? Compared the way a person would: no scheme, no "www.", no trailing slash, any capitals in the host. */
function siteKey(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

async function buildPlan(clientTag: string, group: BisonGroup, instances: BisonInstance[], askedTier: ClientTier | null): Promise<Plan> {
  const supabase = getSupabaseAdmin();
  // One read at a time on purpose: the true-up pages every domain row, and
  // stacking the other reads on top of it is what tips a busy database into
  // a statement timeout.
  const tiers = await getClientTiers();

  // Every domain of the group's instances, with its tags: who already holds
  // what, read strictly. Tags are compared without regard to capitals — the
  // tag is written the way Email Bison has it, which need not be all capitals.
  const tagsOf = new Map<string, string[] | null>(); // `${instance}:${domain}`
  const own = new Map<string, string[]>();
  for (let off = 0; ; off += 1000) {
    const page = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags")
      .in("instance", instances.map((i) => i.slug))
      .order("instance")
      .order("domain")
      .range(off, off + 999);
    if (page.error) throw new Error(`could not read the group's domains: ${page.error.message}`);
    const rows = (page.data || []) as { instance: string; domain: string; tags: string[] | null }[];
    for (const r of rows) {
      tagsOf.set(`${r.instance}:${r.domain}`, r.tags);
      // A row can turn up on two pages if the table changes between them — each domain counts once.
      if (hasTag(r.tags, clientTag) && !(own.get(r.instance) ?? []).includes(r.domain)) own.set(r.instance, [...(own.get(r.instance) ?? []), r.domain]);
    }
    if (rows.length < 1000) break;
  }

  // The group: null means "not on the allocation sheet yet"; a failed read is
  // kept apart from that, so a run can refuse instead of assuming.
  let allocationGroup: BisonGroup | null = null;
  let groupReadFailed = false;
  try {
    allocationGroup = await getGroupForClientTag(clientTag);
  } catch {
    groupReadFailed = true;
  }

  const knownRedirect = (await loadRedirectsByTag()).get(clientTag) ?? null;

  // The sheet send-to-sheet would write to — the same lookup it does.
  const config = await getConfig();
  const tracked =
    config.sheets.find((s) => s.clientTag === clientTag) ??
    config.sheets.find((s) => (s.clientTag || "").split(":")[0].trim().toUpperCase() === clientTag);
  const sheetTag = tracked?.clientTag ?? null;

  const trueUp = await computeTrueUp();
  const trackerTier = tiers.get(clientTag) ?? null;
  const tier: ClientTier = askedTier ?? trackerTier ?? "1";
  const tierSource = askedTier ? "request" : trackerTier ? "client tracker" : "default";

  const sides: Side[] = [];
  for (const inst of instances) {
    const cap = capFor(inst.tier, tier);
    const alreadyTagged = (own.get(inst.slug) ?? []).length;
    const need = Math.max(0, cap - alreadyTagged);
    // New launches take Outlook stock — the tiers are sold as Outlook domains.
    const pool = trueUp.reserveLeft[`${inst.slug}:outlook`] ?? [];
    // Look a little past what is needed, so set-aside domains can be replaced.
    const candidates = pool.slice(0, need + 40);
    // Not spare after all: it carries a Client Tracker tag (a client the
    // true-up doesn't know yet), or this client's own.
    const spoken = new Set(
      candidates.filter((d) => {
        const tags = tagsOf.get(`${inst.slug}:${d}`) ?? null;
        return hasTag(tags, clientTag) || (tags || []).some((t) => tiers.has(String(t).trim().toUpperCase()));
      }),
    );
    const picking = candidates.filter((d) => !spoken.has(d)).slice(0, need);
    // What the true-up itself says about this tag here, when it has a view —
    // except that it leaves a client that isn't sending yet alone, which is
    // every new client and no reason to stop here.
    const row = trueUp.rows.find((r) => r.clientTag === clientTag && r.instance === inst.slug);
    const skip = trueUp.skipped.find((s) => s.clientTag === clientTag && s.instance === inst.slug);
    const said = skip?.reason ?? (row?.blockers.length ? row.blockers.join(", ") : null);
    sides.push({
      instance: inst.slug,
      label: inst.label,
      side: inst.tier,
      cap,
      alreadyTagged,
      need,
      reserveAvailable: pool.length - spoken.size,
      setAside: spoken.size,
      picking,
      short: need - picking.length,
      note: said && !NOT_LIVE_YET.test(said) ? said : null,
    });
  }

  const inTracker = tiers.has(clientTag);
  const runBlockers: string[] = [];
  if (!inTracker) runBlockers.push(`${clientTag} isn't in the Client Tracker — add it there, with its tier, before allocating`);
  if (!knownRedirect) runBlockers.push(`LeadSync has no website for ${clientTag} (the Client Tracker's Website column) — until it does, the client's new domains would still count as spare`);
  if (!sheetTag) runBlockers.push(`${clientTag} has no tracked sheet in LeadSync — its domains are written to that sheet's Domains tab`);
  if (groupReadFailed) runBlockers.push("the allocation sheet couldn't be read, so the group can't be confirmed");
  else if (allocationGroup !== null && allocationGroup !== group) runBlockers.push(`the allocation sheet has ${clientTag} in group ${allocationGroup}, not group ${group}`);

  return { tier, tierSource, generatedFor: trueUp.generatedFor, allocationGroup, groupReadFailed, inTracker, knownRedirect, sheetTag, runBlockers, sides, own };
}

/** Set the daily limit on every sender of these domains (one bulk call per instance). */
async function applyDailyLimit(slug: string, domains: string[], dailyLimit: number): Promise<{ updated?: number; failed?: number; total?: number; error?: string }> {
  if (domains.length === 0) return { updated: 0, failed: 0, total: 0 };
  try {
    const res = await bulkLimits(new Request(`http://internal/api/deliverability/bulk-limits?instance=${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains, type: "daily", limit: dailyLimit }),
    }));
    const j = (await res.json().catch(() => ({}))) as { updated?: number; failed?: number; total?: number; error?: string };
    return res.ok ? { updated: j.updated ?? 0, failed: j.failed ?? 0, total: j.total ?? 0 } : { error: j.error || `HTTP ${res.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "daily limit failed" };
  }
}

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    // Anything that is not an explicit dry run or an explicit run is refused.
    if (body.dryRun !== true && body.dryRun !== false) return bad("dryRun must be true (plan) or false (run)");
    const run = body.dryRun === false;
    if (run) {
      if (process.env.ONBOARDING_ALLOCATE_ENABLED !== "1") {
        return bad("allocation is switched off (ONBOARDING_ALLOCATE_ENABLED is not set) — only { dryRun: true } works", 403);
      }
      const secret = runSecretProblem(request);
      if (secret) return bad(secret, 403);
    }
    const clientTag = (typeof body.clientTag === "string" ? body.clientTag : "").trim().toUpperCase();
    const group = parseGroup(body.group);
    if (!clientTag || /[\/:&,\s]/.test(clientTag) || !group) return bad("clientTag (one client tag) and group (1 or 2) are required");
    const askedTier = body.tier == null || body.tier === "" ? null : String(body.tier).trim();
    if (askedTier !== null && !TIERS.includes(askedTier as ClientTier)) return bad('tier must be "0.5", "1" or "2"');

    const instances = instancesInGroup(group);

    if (!run) {
      const p = await buildPlan(clientTag, group, instances, askedTier as ClientTier | null);
      return NextResponse.json({
        dryRun: true,
        clientTag,
        group,
        tier: p.tier,
        tierSource: p.tierSource,
        generatedFor: p.generatedFor,
        allocationGroup: p.allocationGroup,
        groupMismatch: p.allocationGroup !== null && p.allocationGroup !== group,
        groupReadFailed: p.groupReadFailed,
        inTracker: p.inTracker,
        knownRedirect: p.knownRedirect,
        sheetTag: p.sheetTag,
        runBlockers: p.runBlockers,
        instances: p.sides,
      });
    }

    // A run's inputs are checked before any read, so a malformed call costs nothing.
    const inst = instances.find((i) => i.slug === (typeof body.instance === "string" ? body.instance : "").trim());
    if (!inst) return bad(`instance must be one of group ${group}'s: ${instances.map((i) => i.slug).join(", ")}`);
    const slug = inst.slug;
    const domains = Array.isArray(body.domains)
      ? [...new Set(body.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))]
      : [];
    if (domains.length === 0 || domains.length > MAX_BATCH) return bad(`domains: 1 to ${MAX_BATCH} per call`);
    const askedSite = typeof body.redirectUrl === "string" ? siteKey(body.redirectUrl) : null;
    if (!askedSite || !/^https:\/\//i.test(String(body.redirectUrl).trim())) return bad("redirectUrl must be a full https:// URL");
    const campaignIds = Array.isArray(body.campaignIds)
      ? [...new Set(body.campaignIds.filter((c) => typeof c === "number" && Number.isInteger(c) && c > 0) as number[])]
      : [];
    if (campaignIds.length === 0 || campaignIds.length > MAX_CAMPAIGNS || campaignIds.length !== (Array.isArray(body.campaignIds) ? body.campaignIds.length : 0)) {
      return bad(`campaignIds: 1 to ${MAX_CAMPAIGNS} different campaign ids (whole numbers)`);
    }
    const dailyLimit = body.dailyLimit == null ? DEFAULT_DAILY_LIMIT : body.dailyLimit;
    if (typeof dailyLimit !== "number" || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 50) return bad("dailyLimit must be a whole number from 1 to 50");

    // One batch at a time per instance. The plan is built INSIDE the lock: the
    // spare list is sorted, so two plans built side by side offer the same
    // first domains — and the second batch would tag what the first just took.
    const outcome = await withLock(`allocate:${slug}`, clientTag, LOCK_SECONDS, async () => {
      const p = await buildPlan(clientTag, group, instances, askedTier as ClientTier | null);
      if (p.runBlockers.length > 0) return bad(p.runBlockers.join("; "), 409);
      const side = p.sides.find((s) => s.instance === slug)!;
      const redirectUrl = p.knownRedirect!;
      if (siteKey(redirectUrl) !== askedSite) {
        return bad(`the redirect asked for (${String(body.redirectUrl)}) isn't the website LeadSync has for ${clientTag} (${redirectUrl}) — make the Client Tracker and the onboarding form agree first`, 409);
      }
      if (side.alreadyTagged + domains.length > side.cap) {
        return bad(`${clientTag} has ${side.alreadyTagged} of ${side.cap} domains on ${slug}; adding ${domains.length} would go over the tier cap`, 409);
      }
      const offered = new Set(side.picking);
      const gone = domains.filter((d) => !offered.has(d));
      if (gone.length > 0) {
        return bad(`not among the domains the plan would give on ${slug} right now: ${gone.join(", ")} — ask for a new plan`, 409);
      }
      // Every campaign must be this client's, on this instance.
      const targetCampaigns: { id: number; name: string }[] = [];
      for (const id of campaignIds) {
        let name: string | undefined;
        let found = false;
        try {
          const res = await bisonFetch(inst.slug, `/campaigns/${id}`, { signal: AbortSignal.timeout(20_000) });
          const j = (await res.json().catch(() => null)) as { data?: { name?: string } } | null;
          name = j?.data?.name;
          found = res.ok && !!name;
        } catch {
          return bad(`campaign ${id} couldn't be read on ${slug} (Email Bison didn't answer) — nothing was changed`, 409);
        }
        if (!found || !name) return bad(`campaign ${id} was not found on ${slug}`, 409);
        if (!name.trim().toUpperCase().startsWith(`${clientTag}:`)) return bad(`campaign ${id} ("${name}") is not one of ${clientTag}'s`, 409);
        targetCampaigns.push({ id, name });
      }

      // Put right what an earlier batch may have left: a batch cut off after
      // tagging never reached its daily limit, and the plan won't offer its
      // domains again. Cheap (one bulk call) and the same value every time.
      const before = p.own.get(slug) ?? [];
      const catchUp = await applyDailyLimit(slug, before, dailyLimit);

      // Marker first, so a run that dies mid-way still leaves a trace (same
      // contract as the true-up fill).
      await logEvents([{
        instance: inst.slug,
        clientTag,
        eventType: "proposed",
        detail: `onboarding: adding ${domains.length} domain(s) to a new client (${side.alreadyTagged} of ${side.cap} before)`,
      }]).catch(() => {});

      let steps: ExecStep[] = [];
      const { ok } = await runExecution(
        { clientTag, instance: slug, instancesQuery: `instances=${slug}`, redirectUrl, targetCampaigns, replacementDomains: [...domains], removeDomains: [] },
        (s) => { steps = s; },
        { fetchImpl: internalFetch },
      );

      // ── Checked, not trusted ───────────────────────────────────────────────
      // The runner's "ok" only means no step FAILED: a degraded step, a step
      // skipped by the churn guard, a tag call that found no inboxes and an
      // attach that matched nothing all pass it.
      const problems: string[] = [];
      for (const s of steps) if (s.state !== "done") problems.push(`${s.label} — ${s.state}${s.note ? ` (${s.note})` : ""}`);
      if (steps.length === 0) problems.push("the runner did nothing");

      // The domains must now show the client's tag.
      const supabase = getSupabaseAdmin();
      const now = await supabase.from("deliverability_domains").select("domain, tags").eq("instance", slug).in("domain", domains);
      const tagged = now.error ? 0 : ((now.data || []) as { domain: string; tags: string[] | null }[]).filter((r) => hasTag(r.tags, clientTag)).length;
      if (now.error) problems.push(`the tags couldn't be read back (${now.error.message})`);
      else if (tagged !== domains.length) problems.push(`${tagged} of ${domains.length} domains show the ${clientTag} tag`);

      // Every campaign must have had senders to attach. Asking again is safe:
      // the route only attaches what isn't attached yet.
      const attach: { campaignId: number; matched: number; problem?: string }[] = [];
      if (tagged > 0) {
        for (const c of targetCampaigns) {
          try {
            const res = await attachDomains(new Request(`http://internal/api/deliverability/attach-domains-to-campaign?instance=${slug}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ campaign_id: c.id, domains }),
            }));
            const j = (await res.json().catch(() => ({}))) as { total_matched?: number; failed?: number; campaign_missing?: boolean; error?: string };
            const matched = j.total_matched ?? 0;
            const problem = !res.ok ? j.error || `HTTP ${res.status}`
              : j.campaign_missing ? "the campaign no longer exists"
              : matched === 0 ? "no sender matched — nothing could be attached"
              : (j.failed ?? 0) > 0 ? `${j.failed} sender(s) not attached` : undefined;
            attach.push({ campaignId: c.id, matched, ...(problem ? { problem } : {}) });
            if (problem) problems.push(`"${c.name}": ${problem}`);
          } catch (e) {
            const problem = e instanceof Error ? e.message : "attach check failed";
            attach.push({ campaignId: c.id, matched: 0, problem });
            problems.push(`"${c.name}": ${problem}`);
          }
        }
      }

      // Daily limit — for every domain the client holds here, this batch
      // included, and only once something was actually tagged for it.
      let limit: { updated?: number; failed?: number; total?: number; error?: string } = { error: "skipped — the batch was not tagged" };
      if (tagged > 0) {
        limit = await applyDailyLimit(slug, [...new Set([...before, ...domains])], dailyLimit);
        if (limit.error) problems.push(`daily limit: ${limit.error}`);
        else if (!limit.total) problems.push("daily limit: no sender was found to set it on");
        else if (limit.failed || limit.updated !== limit.total) problems.push(`daily limit: set on ${limit.updated ?? 0} of ${limit.total} senders`);
      } else {
        problems.push("daily limit: not set — the batch was not tagged");
      }
      if (catchUp.error || catchUp.failed) problems.push(`daily limit on the domains ${clientTag} already had: ${catchUp.error ?? `${catchUp.failed} sender(s) not set`}`);

      if (problems.length > 0) {
        await logEvents([{ instance: inst.slug, clientTag, eventType: "error", detail: `onboarding batch incomplete — ${problems.join("; ").slice(0, 900)}` }]).catch(() => {});
      }
      return NextResponse.json({
        ok: ok && problems.length === 0,
        clientTag,
        instance: slug,
        added: tagged,
        steps: steps.map((s) => ({ label: s.label, state: s.state, note: s.note })),
        limit,
        checks: { tagged, attach },
        problems,
      });
    });
    return outcome.ok ? outcome.value : bad(outcome.reason, 409);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
