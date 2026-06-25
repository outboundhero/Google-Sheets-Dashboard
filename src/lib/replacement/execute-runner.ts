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
}

// "degraded" = the call succeeded but some inboxes couldn't be attached (e.g.
// disconnected accounts, or rate-limits that survived retries). NOT silently
// "done" — it's flagged and surfaced on the main dashboard so the automation
// never reports success on a partial attach.
export type StepState = "queued" | "running" | "done" | "failed" | "skipped" | "degraded";
export interface ExecStep { key: string; label: string; state: StepState; note?: string }

const RETRY = 3;
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
  const steps: ExecStep[] = [];
  let ok = true;
  const setStep = (key: string, patch: Partial<ExecStep>) => {
    const i = steps.findIndex((s) => s.key === key);
    if (i >= 0) steps[i] = { ...steps[i], ...patch };
    if (patch.state === "failed") ok = false;
    emit([...steps]);
  };

  const addRepl = replacementDomains.length > 0;
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

  // ── ADD REPLACEMENTS ──
  if (addRepl) {
    setStep("tag", { state: "running" });
    const tagRes = await callJson("/api/deliverability/bulk-tags", { action: "add", tagNames: [clientTag], domains: replacementDomains });
    setStep("tag", { state: tagRes.ok ? "done" : "failed", note: tagRes.ok ? undefined : tagRes.error });
    record({ events: [{ instance, clientTag, eventType: tagRes.ok ? "tagged" : "error", detail: tagRes.ok ? `tagged ${replacementDomains.length}` : tagRes.error }] });

    if (redirectUrl) {
      setStep("redirect", { state: "running" });
      const rRes = await callJson("/api/deliverability/change-redirect", { dryRun: false, domains: replacementDomains, newUrl: redirectUrl });
      setStep("redirect", { state: rRes.ok ? "done" : "failed", note: rRes.ok ? undefined : rRes.error });
      record({ events: [{ instance, clientTag, eventType: rRes.ok ? "redirect_set" : "error", detail: rRes.ok ? redirectUrl : rRes.error }] });
    }

    type AttachData = {
      newly_attached?: number; failed?: number; rateLimited?: number;
      failedInboxes?: { email: string; domain: string; reason: string; retryable?: boolean }[];
    };
    for (const c of targetCampaigns) {
      setStep(`attach:${c.id}`, { state: "running" });
      let aRes = await callJson(`/api/deliverability/attach-domains-to-campaign?instance=${instance}`, { campaign_id: c.id, domains: replacementDomains });
      let d = (aRes.data || {}) as AttachData;

      // Auto-retry once more for rate-limit / transient skips. The route already
      // backs off internally; this re-attempts whatever's still unattached
      // (already-attached are filtered server-side) — critical in unattended mode
      // where nobody is watching to click "retry".
      if (aRes.ok && (d.rateLimited ?? 0) > 0) {
        await sleep(4000);
        const retry = await callJson(`/api/deliverability/attach-domains-to-campaign?instance=${instance}`, { campaign_id: c.id, domains: replacementDomains });
        if (retry.ok) { aRes = retry; d = (retry.data || {}) as AttachData; }
      }

      if (!aRes.ok) {
        setStep(`attach:${c.id}`, { state: "failed", note: aRes.error });
        record({ events: [{ instance, clientTag, eventType: "error", detail: `${c.name}: ${aRes.error}` }] });
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
          signals: { kind: "attach_incomplete", campaign: c.name, campaignId: c.id, newlyAttached: newly, failed, rateLimited: retr, sample: (d.failedInboxes || []).slice(0, 8) },
        }] });
      } else {
        setStep(`attach:${c.id}`, { state: "done" });
        record({ events: [{ instance, clientTag, eventType: "attached", detail: `${c.name}${newly ? ` (+${newly})` : ""}` }] });
      }
    }

    setStep("sheet", { state: "running" });
    const sRes = await callJson("/api/deliverability/send-to-sheet", { domains: replacementDomains, clientTag });
    setStep("sheet", { state: sRes.ok ? "done" : "failed", note: sRes.ok ? undefined : sRes.error });

    setStep("whitelist", { state: "running" });
    const wRes = await callJson("/api/deliverability/whitelist/queue", { domains: replacementDomains, clientTag });
    setStep("whitelist", { state: wRes.ok ? "done" : "failed", note: wRes.ok ? undefined : wRes.error });

    record({ lifecycle: replacementDomains.map((d) => ({ instance, domain: d, state: "assigned" as const, clientTag })) });
  }

  // ── REMOVE BURNT ──
  if (removeDomains.length > 0) {
    setStep("discover", { state: "running" });
    const dRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, discover: true });
    const campaigns = ((dRes.data as { campaigns?: unknown[] })?.campaigns) || [];
    setStep("discover", { state: dRes.ok ? "done" : "failed", note: dRes.ok ? `${campaigns.length} campaign(s)` : dRes.error });

    if (dRes.ok && campaigns.length > 0) {
      setStep("remove", { state: "running" });
      const rmRes = await callJson(`/api/deliverability/remove-from-campaigns?${instancesQuery}`, { domains: removeDomains, campaigns });
      setStep("remove", { state: rmRes.ok ? "done" : "failed", note: rmRes.ok ? undefined : rmRes.error });
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

  return { ok };
}
