import { NextResponse } from "next/server";
import {
  getDuplicateDomains, getPendingDeletions, scheduleDeletions, cancelDeletion,
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
    await scheduleDeletions((body.targets || []) as { instance: string; domain: string }[]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
