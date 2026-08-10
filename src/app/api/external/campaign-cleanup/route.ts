import { NextResponse } from "next/server";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug } from "@/lib/bison-instances";

// TEMP: token-guarded cleanup for the Phase-2 duplication live test — deletes the
// throwaway "Copy of…" draft(s) the test creates. DELETE THIS ROUTE after.
export const maxDuration = 30;
const TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { targets?: { instance: string; id: number }[] };
  const out = [];
  for (const t of body.targets || []) {
    if (!isInstanceSlug(t.instance) || !t.id) { out.push({ ...t, status: "bad" }); continue; }
    try {
      const res = await bisonFetch(t.instance, `/campaigns/${t.id}`, { method: "DELETE" });
      out.push({ ...t, status: res.status });
    } catch (e) { out.push({ ...t, status: "err", error: e instanceof Error ? e.message : "x" }); }
  }
  return NextResponse.json({ results: out });
}
