import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

// TEMPORARY diagnostic (2026-09-07) — times ONE sender-emails query on an
// instance from prod and shows WHAT came back, so we can see why the
// facilityreach/outboundclean searches return thousands of rows for a single
// domain (fuzzy matching) and find a query form that is exact.
// Delete once the deletion-queue investigation closes.
export const maxDuration = 120;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const instance = resolveInstance(p.get("instance"));
  const domain = (p.get("domain") || "example.com").toLowerCase();
  // ?raw= overrides the whole query string after /sender-emails? (already encoded)
  const raw = p.get("raw");
  const perPage = p.get("per_page") || "15";
  const qs = raw ?? `search=${encodeURIComponent(domain)}&page=1&per_page=${perPage}`;
  const t0 = Date.now();
  try {
    const res = await bisonFetch(instance, `/sender-emails?${qs}`, { signal: AbortSignal.timeout(100_000) });
    const ms = Date.now() - t0;
    const text = await res.text();
    let total: unknown = null;
    let sample: string[] = [];
    let exactOnPage = 0;
    let pageRows = 0;
    try {
      const j = JSON.parse(text);
      const payload = Array.isArray(j) ? j[0] : j;
      const data: { email?: string }[] = Array.isArray(payload?.data) ? payload.data : [];
      total = payload?.meta?.total ?? data.length;
      pageRows = data.length;
      sample = data.slice(0, 8).map((s) => String(s.email || ""));
      exactOnPage = data.filter((s) => String(s.email || "").split("@")[1]?.toLowerCase() === domain).length;
    } catch { /* non-JSON body */ }
    return NextResponse.json({
      instance, domain, query: qs, ms, status: res.status, ok: res.ok, total, pageRows, exactOnPage, sample,
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
      bodyHead: res.ok ? undefined : text.slice(0, 200),
    });
  } catch (e) {
    return NextResponse.json({ instance, domain, query: qs, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
  }
}
