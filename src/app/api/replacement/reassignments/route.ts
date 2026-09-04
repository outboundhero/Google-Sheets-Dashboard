import { NextResponse } from "next/server";
import { startReassignments, cancelReassignment, listReassignments } from "@/lib/replacement/reassignments";

export const maxDuration = 120;

// GET  /api/replacement/reassignments            → { rows }
// POST /api/replacement/reassignments            { domains, fromTag, toTag } → start
// POST /api/replacement/reassignments?cancel=1   { instance, domain } → cancel (wind-down only)

export async function GET() {
  try {
    return NextResponse.json({ rows: await listReassignments() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const cancel = new URL(request.url).searchParams.get("cancel") === "1";
    const body = await request.json().catch(() => ({}));
    if (cancel) {
      const ok = await cancelReassignment(String(body?.instance || ""), String(body?.domain || ""));
      return NextResponse.json(ok ? { cancelled: true } : { error: "not cancellable (already past the wind-down)" }, { status: ok ? 200 : 400 });
    }
    const domains = Array.isArray(body?.domains) ? body.domains.map((d: unknown) => String(d)) : [];
    const fromTag = String(body?.fromTag || "");
    const toTag = String(body?.toTag || "");
    if (domains.length === 0 || !fromTag || !toTag) {
      return NextResponse.json({ error: "domains, fromTag and toTag are required" }, { status: 400 });
    }
    return NextResponse.json(await startReassignments(domains, fromTag, toTag));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
