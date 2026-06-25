import { NextResponse } from "next/server";
import { auditRedirects, recordRedirectDecision } from "@/lib/replacement/redirect-audit";

export const maxDuration = 60;

// GET /api/replacement/redirect-audit — read-only. Compares every assigned
// domain's redirect to the Client Tracker website; returns wrong/missing/
// multi-tag issues (excluding already-decided ones). Admin-only via middleware.
export async function GET() {
  try {
    return NextResponse.json(await auditRedirects());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

// POST /api/replacement/redirect-audit — record approve(fix)/disapprove(ignore)
// decisions so resolved domains stop re-appearing. Body: { decisions: [{instance,
// domain, decision, expectedUrl?}] }. The actual redirect change is done by the
// caller via /api/deliverability/change-redirect (proven path); this just logs.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      decisions?: { instance: string; domain: string; decision: "fixed" | "ignored"; expectedUrl?: string | null }[];
    };
    await recordRedirectDecision(body.decisions || []);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
