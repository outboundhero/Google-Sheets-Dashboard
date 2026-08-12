import { NextResponse } from "next/server";
import {
  getDuplicateDomains, getPendingDeletions, scheduleDeletions, cancelDeletion, forceDeletionsNow,
} from "@/lib/replacement/duplicate-domains";

export const maxDuration = 60;

// GET /api/replacement/duplicate-domains → { duplicates, pending }. Admin-only.
export async function GET() {
  try {
    const [duplicates, pending] = await Promise.all([getDuplicateDomains(), getPendingDeletions()]);
    return NextResponse.json({ duplicates, pending });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

// POST — schedule a (domain,instance) for deletion after the grace period, or
// cancel one. The campaign-sender removal itself is driven by the FE via
// /api/deliverability/remove-from-campaigns; this records the post-removal
// delete intent that a future cron fires.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.action === "cancel") {
      await cancelDeletion(body.instance, body.domain);
      return NextResponse.json({ ok: true });
    }
    // Drop the remaining grace on pending rows (all, or the given targets) so
    // the next executor pass fires them.
    if (body.action === "forceNow") {
      const moved = await forceDeletionsNow(body.targets as { instance: string; domain: string }[] | undefined);
      return NextResponse.json({ ok: true, moved });
    }
    // graceDays: 0 = delete immediately (no grace) — the card's
    // "delete immediately" option; omitted keeps the default 3-day grace.
    const graceDays = typeof body.graceDays === "number" && body.graceDays >= 0 ? body.graceDays : undefined;
    await scheduleDeletions((body.targets || []) as { instance: string; domain: string }[], { graceDays });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
