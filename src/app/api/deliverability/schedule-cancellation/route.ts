import { NextResponse } from "next/server";
import { resolveInstances } from "@/lib/bison";
import {
  enqueueScheduledCancel, enqueueDeleteOnly, listScheduledCancellations,
  DEFAULT_CANCEL_GRACE_DAYS,
} from "@/lib/deliverability/scheduled-cancellations";

export const maxDuration = 300;

// POST /api/deliverability/schedule-cancellation
//   { domains, mode: "immediate" | "delayed", graceDays? }
// The staged wind-down (Spencer 2026-07-29). BOTH modes first, RIGHT NOW:
//   1. throttle the domains to 1/day  2. remove from all campaigns.
// Then:
//   • delayed  → queue the vendor-cancel for +graceDays (default 3); the
//                fire-scheduled-cancellations cron cancels, waits 10 min, and
//                deletes the Bison senders.
//   • immediate→ cancel at the vendor NOW, then queue ONLY the 10-min-later
//                Bison sender-delete.
// GET → the current pending queue.
export async function GET() {
  try {
    return NextResponse.json({ queue: await listScheduledCancellations() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instancesQuery = `instances=${resolveInstances(searchParams).join(",")}`;
    const body = (await request.json()) as { domains?: string[]; mode?: "immediate" | "delayed"; graceDays?: number };
    const domains = (body.domains || []).map((d) => d.trim().toLowerCase()).filter(Boolean);
    const mode = body.mode === "immediate" ? "immediate" : "delayed";
    const graceDays = Math.min(30, Math.max(1, Number(body.graceDays) || DEFAULT_CANCEL_GRACE_DAYS));
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });

    const steps: Record<string, unknown> = {};

    // 1) throttle to 1/day (stop sending right away)
    const [{ POST: limitsPOST }, { POST: removePOST }] = await Promise.all([
      import("@/app/api/deliverability/bulk-limits/route"),
      import("@/app/api/deliverability/remove-from-campaigns/route"),
    ]);
    const throttleRes = await limitsPOST(new Request("http://internal/api/deliverability/bulk-limits", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains, type: "daily", limit: 1 }),
    }));
    steps.throttle = await throttleRes.json().catch(() => ({}));

    // 2) remove from all campaigns (discover → remove)
    const discReq = () => new Request(`http://internal/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains, discover: true }),
    });
    const disc = await removePOST(discReq());
    const discData = (await disc.json().catch(() => ({}))) as { campaigns?: unknown[] };
    const campaigns = discData.campaigns || [];
    if (campaigns.length > 0) {
      const rm = await removePOST(new Request(`http://internal/api/deliverability/remove-from-campaigns?${instancesQuery}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains, campaigns }),
      }));
      steps.removeFromCampaigns = await rm.json().catch(() => ({}));
    } else {
      steps.removeFromCampaigns = { campaigns: 0 };
    }

    // 3) cancel timing
    if (mode === "delayed") {
      const queued = await enqueueScheduledCancel(domains, graceDays);
      steps.scheduledCancel = { queued, fireInDays: graceDays };
    } else {
      // immediate: cancel at vendor NOW, then queue the 10-min-later delete
      const { POST: cancelPOST } = await import("@/app/api/deliverability/cancel-domains/route");
      const cx = await cancelPOST(new Request("http://internal/api/deliverability/cancel-domains", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, domains }),
      }));
      steps.cancel = await cx.json().catch(() => ({}));
      steps.scheduledDelete = { queued: await enqueueDeleteOnly(domains) };
    }

    return NextResponse.json({ ok: true, mode, domains: domains.length, steps });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
