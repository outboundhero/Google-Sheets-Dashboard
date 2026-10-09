import { NextResponse } from "next/server";
import { postSlackMessage } from "@/lib/slack";
import { pipelineAlertChannel } from "@/lib/pipeline-alerts";
import { getSendingModeSettings } from "@/lib/sending-mode/config";
import { continueApply, endWindow, listOpenWindows } from "@/lib/sending-mode/windows";
import { evaluateAllClients, runThrottlePass, saveClientStatuses } from "@/lib/sending-mode/status";
import { THROTTLE_HOUR_UTC } from "@/lib/sending-mode/throttle-preview";

export const maxDuration = 300;

// GET /api/cron/sending-mode — hourly. The scheduled job the spec's "automatic
// revert — must not fail" rests on, plus the daily throttle check:
//
//   every run   finish any window still applying · retry any revert that
//               hasn't verified (up to MAX_REVERT_ATTEMPTS, then alert) ·
//               expire Turbo windows past ends_at · refresh QL pace for every
//               client · close windows for clients that churned, paused or
//               went inactive
//   17:00 UTC   the throttle pass (an hour after the MRL pacing cron, after
//               the hourly lead sync) — or any run with ?throttle=1
//
// ?dry=1 reports what it would do without touching Bison.
// The throttle pass only reports until SENDING_MODE_THROTTLE_ENABLED=true —
// it changes limits with nobody clicking, so it stays off until Nick signs off
// on the thresholds. Turbo is a manual button and isn't gated.
// Slack is muted until SENDING_MODE_SLACK_ENABLED=true (log rows always write).

const BUDGET_MS = 240_000;

export async function GET(request: Request) {
  const t0 = Date.now();
  const deadline = t0 + BUDGET_MS;
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const forceThrottle = url.searchParams.get("throttle") === "1";
  const perWindowBudget = () => Math.max(20_000, deadline - Date.now());

  const summary: Record<string, unknown> = { dry };
  try {
    const settings = await getSendingModeSettings();
    const open = await listOpenWindows();
    const now = new Date();

    // 1) Unfinished work first — a half-applied or half-reverted window is
    //    the one thing that must never sit for a day.
    const continued: unknown[] = [];
    for (const w of open) {
      if (Date.now() > deadline) break;
      if (w.status === "applying") {
        if (dry) { continued.push({ id: w.id, client: w.client_tag, would: "continue apply" }); continue; }
        const r = await continueApply(w.id, perWindowBudget());
        continued.push({ id: w.id, client: w.client_tag, kind: w.kind, ...r });
      } else if (w.status === "reverting") {
        if (dry) { continued.push({ id: w.id, client: w.client_tag, would: "retry revert" }); continue; }
        const r = await endWindow(w.id, w.end_reason ?? "retry", { budgetMs: perWindowBudget() });
        continued.push({ id: w.id, client: w.client_tag, kind: w.kind, ...r });
      }
    }
    summary.continued = continued;

    // 2) Turbo windows that have run their course.
    const expired: unknown[] = [];
    for (const w of open) {
      if (w.status !== "active" || w.kind !== "turbo" || !w.ends_at) continue;
      if (new Date(w.ends_at) > now) continue;
      if (Date.now() > deadline) break;
      if (dry) { expired.push({ id: w.id, client: w.client_tag, would: "expire" }); continue; }
      const r = await endWindow(w.id, "expired", { budgetMs: perWindowBudget() });
      expired.push({ id: w.id, client: w.client_tag, ...r });
    }
    summary.expired = expired;

    // 3) Pace for everyone (also what the tab reads).
    const rows = await evaluateAllClients(settings, now);
    if (!dry) await saveClientStatuses(rows);
    summary.evaluated = rows.filter((r) => r.gone === null).length;
    summary.byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      if (r.gone) return acc;
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    // 4) Clients that should no longer be boosted or throttled.
    const goneByTag = new Map(rows.filter((r) => r.gone).map((r) => [r.clientTag, r]));
    const closed: unknown[] = [];
    for (const w of await listOpenWindows()) {
      if (w.status !== "active") continue;
      const g = goneByTag.get(w.client_tag.toUpperCase());
      if (!g) continue;
      if (Date.now() > deadline) break;
      if (dry) { closed.push({ id: w.id, client: w.client_tag, would: `close (${g.gone})` }); continue; }
      const r = await endWindow(w.id, g.gone!, { budgetMs: perWindowBudget(), paceAtEnd: g.pace, qlsAtEnd: g.qlsDelivered });
      closed.push({ id: w.id, client: w.client_tag, kind: w.kind, reason: g.gone, ...r });
    }
    summary.closedForGoneClients = closed;

    // 5) Daily throttle pass.
    const throttleDue = forceThrottle || now.getUTCHours() === THROTTLE_HOUR_UTC;
    if (throttleDue) {
      const throttleEnabled = process.env.SENDING_MODE_THROTTLE_ENABLED === "true";
      const throttleDry = dry || !throttleEnabled;
      const r = await runThrottlePass(rows, settings, { dry: throttleDry, budgetMs: perWindowBudget(), deadline });
      summary.throttle = {
        enabled: throttleEnabled,
        throttled: r.throttled,
        released: r.released,
        errors: r.errors,
        wouldThrottle: r.decisions.filter((d) => d.action === "throttle").map((d) => `${d.clientTag} (${d.reason})`),
        wouldRelease: r.decisions.filter((d) => d.action === "release").map((d) => `${d.clientTag} (${d.reason})`),
      };
      if (!throttleDry && process.env.SENDING_MODE_SLACK_ENABLED === "true" && (r.throttled.length || r.released.length)) {
        const lines = [
          ...r.throttled.map((t) => `• throttled *${t.clientTag}* — ${t.accounts} account(s)${t.failed ? `, ${t.failed} failed` : ""}`),
          ...r.released.map((t) => `• released *${t.clientTag}* — ${t.reverted} restored (${t.reason})${t.failed ? `, ${t.failed} failed` : ""}`),
        ];
        await postSlackMessage([":level_slider: *Auto-throttle*", ...lines].join("\n"), pipelineAlertChannel()).catch(() => undefined);
      }
    } else summary.throttle = `skipped — runs at ${THROTTLE_HOUR_UTC}:00 UTC or with ?throttle=1`;

    summary.durationMs = Date.now() - t0;
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : "sending-mode cron failed";
    console.error("[cron/sending-mode]", message);
    return NextResponse.json({ ok: false, error: message, ...summary }, { status: 500 });
  }
}
