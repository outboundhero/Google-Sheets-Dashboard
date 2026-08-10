// Shared execution runner for the replacement queue. Runs ONE client's plan by
// reusing the proven deliverability endpoints, emitting step updates as it goes.
// Confirm-first lives in the UI; this just executes after confirmation. Burnt
// domains are removed from campaigns (reversible) + scheduled for the 5-day
// vendor-delete grace — nothing is deleted at a provider here.

export interface ExecuteInputs {
  clientTag: string;
  instance: string;
  instancesQuery: string;          // e.g. "instances=facilityreach"
  redirectUrl: string | null;
  targetCampaigns: { id: number; name: string }[];
  replacementDomains: string[];    // reserves to add (zero-blocker replace rows only)
  removeDomains: string[];         // all burnt domains to remove from campaigns
  /**
   * Cross-instance donor reserves (Nick Aug-10): these replacementDomains live
   * on a DONOR instance and must be MOVED onto `instance` (Inboxing move,
   * verify-all) before tagging. Verified moves schedule the donor copy's 24h
   * auto-delete; failed/partial moves drop out of the run and are flagged.
   */
  crossMoves?: { domain: string; fromInstance: string; platformConnectionId: string }[];
}

// "degraded" = the call succeeded but some inboxes couldn't be attached (e.g.
// disconnected accounts, or rate-limits that survived retries). NOT silently
// "done" — it's flagged and surfaced on the main dashboard so the automation
// never reports success on a partial attach.
export type StepState = "queued" | "running" | "done" | "failed" | "skipped" | "degraded";
export interface ExecStep { key: string; label: string; state: StepState; note?: string }

// Everything needed to re-run ONE failed step later, stored in the error
// event's signals. The dashboard Retry card replays it against the same
// deliverability endpoints (Slack only notifies — retry lives in LeadSync).
export interface RetryPayload {
  step: "tag" | "redirect" | "attach" | "sheet" | "whitelist" | "remove";
  instance: string;
  clientTag: string;
  domains: string[];
  tagNames?: string[];       // tag
  newUrl?: string;           // redirect
  campaignId?: number;       // attach
  campaignName?: string;     // attach
  instancesQuery?: string;   // remove
}

const RETRY = 3;
// Retry-until-complete (Spencer 2026-07-27 Loom): rate-limited tag/attach calls
// are re-run — only the still-failing subset — until everything landed or the
// failures are permanent (disconnected accounts). Bounded so a hard outage
// can't loop forever: up to MAX_PASSES with 5s→30s backoff (~4 min worst case).
const MAX_PASSES = 10;
const RETRYABLE_RE = /rate.?limit|429|too many|server error|5\d\d|network|timeout|retryable/i;
const backoff = (pass: number) => Math.min(5000 * 2 ** pass, 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callJson(url: string, body: unknown, retries = RETRY): Promise<{ ok: boolean; data: unknown; error?: string }> {
  let lastErr = "";
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { lastErr = "non-JSON response"; if (i < retries - 1) { await sleep(800 * (i + 1)); continue; } return { ok: false, data: null, error: lastErr }; }
      if (res.ok) return { ok: true, data };
      lastErr = (data as { error?: string })?.error || `HTTP ${res.status}`;
      if (i < retries - 1) { await sleep(800 * (i + 1)); continue; }
      return { ok: false, data, error: lastErr };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "request failed";
      if (i < retries - 1) { await sleep(800 * (i + 1)); continue; }
    }
  }
  return { ok: false, data: null, error: lastErr };
}

const record = (payload: unknown) =>
  fetch("/api/replacement/record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});

/** Run the execution for one client. `emit` is called with a fresh steps array
 *  on every change. Resolves with ok=false if any step failed. */
export async function runExecution(inp: ExecuteInputs, emit: (steps: ExecStep[]) => void): Promise<{ ok: boolean }> {
  const { clientTag, instance, instancesQuery, redirectUrl, targetCampaigns, replacementDomains, removeDomains } = inp;

  // Churn blackout (Spencer 2026-08-06): never run replacement within 5 days of
  // a client's churn date (or after it). Single chokepoint — blocks every path.
  try {
    const g = await fetch(`/api/replacement/churn-guard?clientTag=${encodeURIComponent(clientTag)}`);
    const guard = (await g.json().catch(() => null)) as { blocked?: boolean; reason?: string } | null;
    if (guard?.blocked) {
      const blocked: ExecStep = {
        key: "churn-blackout",
        label: `Skipped — ${clientTag} ${guard.reason || "within churn blackout"}`,
        state: "skipped",
        note: "Replacement blocked: within 5 days of churn date.",
      };
      emit([blocked]);
      record({ events: [{ instance, clientTag, eventType: "skipped", detail: `churn blackout — ${guard.reason || "within 5d of churn"}` }] });
      return { ok: true };
    }
  } catch {
    // Fail open: a transient guard error shouldn't block a legitimate run.
  }

  const steps: ExecStep[] = [];
  let ok = true;
  const setStep = (key: string, patch: Partial<ExecStep>) => {
    const i = steps.findIndex((s) => s.key === key);
    if (i >= 0) steps[i] = { ...steps[i], ...patch };
    if (patch.state === "failed") ok = false;
    emit([...steps]);
  };

  const crossMoves = inp.crossMoves || [];
  const addRepl = replacementDomains.length > 0;
  if (crossMoves.length > 0) {
    steps.push({ key: "crossmove", label: `Move ${crossMoves.length} donor reserve(s) → this instance (verify all inboxes)`, state: "queued" });
  }
  if (addRepl) {
    steps.push({ key: "tag", label: `Tag ${replacementDomains.length} reserve domain(s) → ${clientTag}`, state: "queued" });
    steps.push({ key: "redirect", label: `Set redirect → ${redirectUrl ? redirectUrl.replace(/^https?:\/\//, "") : "(none)"}`, state: redirectUrl ? "queued" : "skipped" });
    for (const c of targetCampaigns) steps.push({ key: `attach:${c.id}`, label: `Attach to "${c.name}"`, state: "queued" });
    steps.push({ key: "sheet", label: "Add to client domains sheet", state: "queued" });
    steps.push({ key: "whitelist", label: "Queue whitelist email (6:30am PST)", state: "queued" });
  }
  if (removeDomains.length > 0) {
    steps.push({ key: "discover", label: `Find campaigns for ${removeDomains.length} burnt domain(s)`, state: "queued" });
    steps.push({ key: "remove", label: "Remove burnt domains from campaigns", state: "queued" });
    steps.push({ key: "schedule", label: "Schedule vendor cancellation (+5 days)", state: "queued" });
  }
  emit([...steps]);

  // ── CROSS-INSTANCE DONOR MOVES (before anything touches the target) ──
  // Move donor reserves onto this instance via the proven Inboxing move flow
  // (submit → poll-verify). Domains whose move doesn't FULLY verify are dropped
  // from this run (never tagged/attached half-moved); verified ones get the
  // donor copy's 24h auto-delete scheduled + partials flagged via move-finalize.
  if (crossMoves.length > 0) {
    setStep("crossmove", { state: "running" });
    const connId = crossMoves[0].platformConnectionId;
    let inflight: { domain: string; sourceInstance: string; expected: number }[] = [];
    const verified: { domain: string; fromInstance: string }[] = [];
    const failedMoves: string[] = [];
    const sub = await callJson("/api/deliverability/move-domains", {
      mode: "submit", dryRun: false,
      domains: crossMoves.map((m) => m.domain),
      targetInstance: instance, platformConnectionId: connId,
    });
    const subData = (sub.data || {}) as { results?: { domain: string; status: string; sourceInstance?: string; expected?: number; error?: string }[] };
    if (!sub.ok) {
      failedMoves.push(...crossMoves.map((m) => m.domain));
    } else {
      for (const r of subData.results || []) {
        const src = crossMoves.find((m) => m.domain === r.domain)?.fromInstance || r.sourceInstance || "";
        if (r.status === "uploading") inflight.push({ domain: r.domain, sourceInstance: src, expected: r.expected ?? 1 });
        else if (r.status === "done") verified.push({ domain: r.domain, fromInstance: src });
        else failedMoves.push(r.domain);
      }
    }
    const moveDeadline = Date.now() + 10 * 60 * 1000;
    while (inflight.length > 0 && Date.now() < moveDeadline) {
      await sleep(12_000);
      const pr = await callJson("/api/deliverability/move-domains", { mode: "poll", dryRun: false, inflight, targetInstance: instance });
      const prData = (pr.data || {}) as { results?: { domain: string; status: string }[] };
      if (pr.ok && Array.isArray(prData.results)) {
        const still: typeof inflight = [];
        for (const r of prData.results) {
          const f = inflight.find((x) => x.domain === r.domain);
          if (!f) continue;
          if (r.status === "done") verified.push({ domain: f.domain, fromInstance: f.sourceInstance });
          else still.push(f);
        }
        inflight = still;
      }
      setStep("crossmove", { state: "running", note: `${verified.length} landed · ${inflight.length} uploading` });
    }
    // Anything still in-flight at the deadline = NOT verified → drop from run.
    failedMoves.push(...inflight.map((f) => f.domain));
    // Schedule the donor copies' 24h auto-delete + flag partials (Slack + panel).
    if (verified.length > 0 || inflight.length > 0) {
      await callJson("/api/deliverability/move-finalize", {
        schedule: verified.map((v) => ({ instance: v.fromInstance, domain: v.domain })),
        partials: inflight.map((f) => ({ domain: f.domain, sourceInstance: f.sourceInstance })),
        targetInstance: instance,
      });
    }
    // Drop unverified donors from the replacement list — never half-run them.
    for (const dom of failedMoves) {
      const i = replacementDomains.indexOf(dom);
      if (i >= 0) replacementDomains.splice(i, 1);
    }
    if (failedMoves.length === 0) {
      setStep("crossmove", { state: "done", note: `${verified.length} moved + verified` });
    } else if (verified.length > 0) {
      setStep("crossmove", { state: "degraded", note: `${verified.length} verified · ${failedMoves.length} dropped (move incomplete — retry later)` });
      record({ events: [{ instance, clientTag, eventType: "error", detail: `Donor move incomplete — dropped: ${failedMoves.join(", ")}` }] });
    } else {
      setStep("crossmove", { state: "failed", note: "no donor move verified — replacements dropped" });
      record({ events: [{ instance, clientTag, eventType: "error", detail: `Donor move failed for all ${crossMoves.length} domain(s)` }] });
    }
  }

  // ── ADD REPLACEMENTS ──
  if (addRepl && replacementDomains.length === 0) {
    // every replacement was a donor whose move failed — skip the add chain
    for (const k of ["tag", "redirect", "sheet", "whitelist", ...targetCampaigns.map((c) => `attach:${c.id}`)]) {
      setStep(k, { state: "skipped", note: "no replacement domains left (donor move failed)" });
    }
  }
  if (addRepl && replacementDomains.length > 0) {
    setStep("tag", { state: "running" });
    type TagData = {
      inboxesAffected?: number; failed?: number; total?: number;
      failedInboxes?: { email: string; domain: string; reason: string }[];
    };
    // Retry-until-complete: re-run bulk-tags on the still-failing domains while
    // the failures look transient (rate limit / 5xx / network). Re-tagging an
    // already-tagged inbox is idempotent, so retrying by domain is safe.
    let tagOk = false;
    let tagErr: string | undefined;
    let tagFails: NonNullable<TagData["failedInboxes"]> = [];
    let tagTotal = 0;
    let tagDomains = replacementDomains;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const res = await callJson("/api/deliverability/bulk-tags", { action: "add", tagNames: [clientTag], domains: tagDomains });
      if (!res.ok) { tagOk = false; tagErr = res.error; break; }
      tagOk = true;
      const d = (res.data || {}) as TagData;
      if (pass === 0) tagTotal = d.total ?? 0;
      tagFails = d.failedInboxes ?? [];
      if (tagFails.length === 0) break;
      const retryable = tagFails.filter((f) => RETRYABLE_RE.test(f.reason));
      if (retryable.length === 0 || pass === MAX_PASSES - 1) break;   // permanent fails / out of passes
      tagDomains = [...new Set(retryable.map((f) => f.domain))];
      setStep("tag", { state: "running", note: `pass ${pass + 2}: retrying ${retryable.length} rate-limited inbox(es)…` });
      await sleep(backoff(pass));
    }
    const tagRetry: RetryPayload = { step: "tag", instance, clientTag, domains: replacementDomains, tagNames: [clientTag] };
    if (!tagOk) {
      setStep("tag", { state: "failed", note: tagErr });
      record({ events: [{ instance, clientTag, eventType: "error", detail: `Tag failed: ${tagErr}`, signals: { kind: "tag_failed", retry: tagRetry } }] });
    } else if (tagFails.length > 0) {
      // partial tag survives all retries → degraded (never silently "done")
      const note = `${Math.max(0, tagTotal - tagFails.length)}/${tagTotal || "?"} inboxes tagged · ${tagFails.length} failed`;
      setStep("tag", { state: "degraded", note });
      record({ events: [{
        instance, clientTag, eventType: "error",
        detail: `Tag incomplete — ${note}`,
        signals: { kind: "tag_incomplete", failed: tagFails.length, total: tagTotal, sample: tagFails.slice(0, 8), retry: tagRetry },
      }] });
    } else {
      setStep("tag", { state: "done" });
      record({ events: [{ instance, clientTag, eventType: "tagged", detail: `tagged ${replacementDomains.length} domain(s)${tagTotal ? ` (${tagTotal} inboxes)` : ""}` }] });
    }

    if (redirectUrl) {
      setStep("redirect", { state: "running" });
      const rRes = await callJson("/api/deliverability/change-redirect", { dryRun: false, domains: replacementDomains, newUrl: redirectUrl });
      setStep("redirect", { state: rRes.ok ? "done" : "failed", note: rRes.ok ? undefined : rRes.error });
      record({ events: [{
        instance, clientTag, eventType: rRes.ok ? "redirect_set" : "error", detail: rRes.ok ? redirectUrl : rRes.error,
        signals: rRes.ok ? null : { kind: "redirect_failed", retry: { step: "redirect", instance, clientTag, domains: replacementDomains, newUrl: redirectUrl } satisfies RetryPayload },
      }] });
    }

    type AttachData = {
      newly_attached?: number; failed?: number; rateLimited?: number;
      failedInboxes?: { email: string; domain: string; reason: string; retryable?: boolean }[];
    };
    for (const c of targetCampaigns) {
      setStep(`attach:${c.id}`, { state: "running" });
      let aRes = await callJson(`/api/deliverability/attach-domains-to-campaign?instance=${instance}`, { campaign_id: c.id, domains: replacementDomains });
      let d = (aRes.data || {}) as AttachData;

      // Retry-until-complete for rate-limit / transient skips. The route backs
      // off internally and filters already-attached server-side, so re-posting
      // the full list only re-attempts what's still missing — keeps going until
      // everything attached or only permanent (disconnected) skips remain.
      for (let pass = 0; aRes.ok && (d.rateLimited ?? 0) > 0 && pass < MAX_PASSES - 1; pass++) {
        setStep(`attach:${c.id}`, { state: "running", note: `pass ${pass + 2}: retrying ${d.rateLimited} rate-limited…` });
        await sleep(backoff(pass));
        const retry = await callJson(`/api/deliverability/attach-domains-to-campaign?instance=${instance}`, { campaign_id: c.id, domains: replacementDomains });
        if (!retry.ok) break;
        aRes = retry; d = (retry.data || {}) as AttachData;
      }

      const attachRetry: RetryPayload = { step: "attach", instance, clientTag, domains: replacementDomains, campaignId: c.id, campaignName: c.name };
      // report the outcome — server defers an 8h re-attach when the campaign is
      // queued/launching (Bison ignores adds then), or on failure/rate-limits
      fetch("/api/replacement/attach-queue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance, campaignId: c.id, campaignName: c.name, clientTag, domains: replacementDomains, ok: aRes.ok, remainingRateLimited: d.rateLimited ?? 0 }),
      }).catch(() => {});
      if (!aRes.ok) {
        setStep(`attach:${c.id}`, { state: "failed", note: aRes.error });
        record({ events: [{ instance, clientTag, eventType: "error", detail: `${c.name}: ${aRes.error}`, signals: { kind: "attach_failed", retry: attachRetry } }] });
        continue;
      }

      const failed = d.failed ?? 0;
      const newly = d.newly_attached ?? 0;
      if (failed > 0) {
        // Partial attach — flag it. Distinguish rate-limited (retryable) from
        // disconnected (permanent) so the dashboard shows the right cause.
        const retr = d.rateLimited ?? 0;
        const disc = failed - retr;
        const parts = [retr ? `${retr} rate-limited` : "", disc ? `${disc} disconnected` : ""].filter(Boolean).join(", ");
        setStep(`attach:${c.id}`, { state: "degraded", note: `${newly} attached · ${failed} skipped (${parts})` });
        record({ events: [{
          instance, clientTag, eventType: "error",
          detail: `Attach incomplete — "${c.name}": ${newly} attached, ${failed} skipped (${parts})`,
          signals: { kind: "attach_incomplete", campaign: c.name, campaignId: c.id, newlyAttached: newly, failed, rateLimited: retr, sample: (d.failedInboxes || []).slice(0, 8), retry: attachRetry },
        }] });
      } else {
        setStep(`attach:${c.id}`, { state: "done" });
        record({ events: [{ instance, clientTag, eventType: "attached", detail: `${c.name}${newly ? ` (+${newly})` : ""}` }] });
      }
    }

    setStep("sheet", { state: "running" });
    const sRes = await callJson("/api/deliverability/send-to-sheet", { domains: replacementDomains, clientTag });
    setStep("sheet", { state: sRes.ok ? "done" : "failed", note: sRes.ok ? undefined : sRes.error });
    if (!sRes.ok) record({ events: [{ instance, clientTag, eventType: "error", detail: `Sheet append failed: ${sRes.error}`, signals: { kind: "sheet_failed", retry: { step: "sheet", instance, clientTag, domains: replacementDomains } satisfies RetryPayload } }] });

    setStep("whitelist", { state: "running" });
    const wRes = await callJson("/api/deliverability/whitelist/queue", { domains: replacementDomains, clientTag });
    setStep("whitelist", { state: wRes.ok ? "done" : "failed", note: wRes.ok ? undefined : wRes.error });
    if (!wRes.ok) record({ events: [{ instance, clientTag, eventType: "error", detail: `Whitelist queue failed: ${wRes.error}`, signals: { kind: "whitelist_failed", retry: { step: "whitelist", instance, clientTag, domains: replacementDomains } satisfies RetryPayload } }] });

    record({ lifecycle: replacementDomains.map((d) => ({ instance, domain: d, state: "assigned" as const, clientTag })) });
  }

  // ── REMOVE BURNT ──
  if (removeDomains.length > 0) {
    setStep("discover", { state: "running" });
    const dRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, discover: true });
    const campaigns = ((dRes.data as { campaigns?: unknown[] })?.campaigns) || [];
    setStep("discover", { state: dRes.ok ? "done" : "failed", note: dRes.ok ? `${campaigns.length} campaign(s)` : dRes.error });

    const removeRetry: RetryPayload = { step: "remove", instance, clientTag, domains: removeDomains, instancesQuery };
    if (!dRes.ok) {
      record({ events: [{ instance, clientTag, eventType: "error", detail: `Campaign discovery failed: ${dRes.error}`, signals: { kind: "remove_failed", retry: removeRetry } }] });
    }
    if (dRes.ok && campaigns.length > 0) {
      setStep("remove", { state: "running" });
      const rmRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, campaigns });
      setStep("remove", { state: rmRes.ok ? "done" : "failed", note: rmRes.ok ? undefined : rmRes.error });
      if (!rmRes.ok) record({ events: [{ instance, clientTag, eventType: "error", detail: `Remove from campaigns failed: ${rmRes.error}`, signals: { kind: "remove_failed", retry: removeRetry } }] });
    } else {
      setStep("remove", { state: "skipped", note: "no campaigns to remove from" });
    }

    setStep("schedule", { state: "running" });
    await record({
      events: removeDomains.map((d) => ({ instance, domain: d, clientTag, eventType: "removed" as const, detail: "removed from campaigns; vendor-delete scheduled +5d" })),
      lifecycle: removeDomains.map((d) => ({ instance, domain: d, state: "removed" as const, clientTag })),
      cancellations: removeDomains.map((d) => ({ instance, domain: d, clientTag, reason: "burnt — replaced" })),
    });
    setStep("schedule", { state: "done", note: "vendor delete in 5 days (not yet fired)" });
  }

  // Slack notification for any failed/degraded step (retry lives in LeadSync —
  // the "Failed steps" card replays the stored payloads; Slack only alerts).
  const failures = steps.filter((s) => s.state === "failed" || s.state === "degraded");
  if (failures.length > 0) {
    fetch("/api/replacement/notify-failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientTag, instance, steps: failures.map((s) => ({ label: s.label, state: s.state, note: s.note })) }),
    }).catch(() => {});
  }

  return { ok };
}
