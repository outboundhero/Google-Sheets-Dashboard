import { NextResponse } from "next/server";
import { getSkips, addSkips, removeSkips } from "@/lib/replacement/skips";

export const maxDuration = 30;

// GET /api/replacement/skips → { skips: SkipRow[] }
export async function GET() {
  try {
    return NextResponse.json({ skips: await getSkips() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

// POST { action: "add" | "remove", entries: [{instance, domain, reason?}] }
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "add" | "remove";
      entries?: { instance: string; domain: string; reason?: string | null }[];
    };
    const entries = (body.entries || []).filter((e) => e.instance && e.domain);
    if (entries.length === 0) return NextResponse.json({ error: "entries required" }, { status: 400 });
    if (body.action === "remove") {
      const n = await removeSkips(entries);
      return NextResponse.json({ ok: true, removed: n });
    }
    const n = await addSkips(entries);
    return NextResponse.json({ ok: true, added: n });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
