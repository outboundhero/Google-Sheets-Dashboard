import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

// TEMPORARY diagnostic (2026-09-07) — times ONE sender-emails search on an
// instance from prod, so we can see whether facilityreach/outboundclean
// searches are slow/throttled at Bison or only inside the executor's load.
// Delete once the deletion-queue investigation closes.
export const maxDuration = 120;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const instance = resolveInstance(p.get("instance"));
  const domain = (p.get("domain") || "example.com").toLowerCase();
  const perPage = p.get("per_page") || "15";
  const t0 = Date.now();
  try {
    const res = await bisonFetch(instance, `/sender-emails?search=${encodeURIComponent(domain)}&page=1&per_page=${perPage}`, {
      signal: AbortSignal.timeout(100_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let total: unknown = null;
    try {
      const j = JSON.parse(text);
      const payload = Array.isArray(j) ? j[0] : j;
      total = payload?.meta?.total ?? (Array.isArray(payload?.data) ? payload.data.length : null);
    } catch { /* non-JSON body */ }
    return NextResponse.json({
      instance, domain, ms, status: res.status, ok: res.ok, total,
      retryAfter: res.headers.get("retry-after"),
      rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
      rateLimitLimit: res.headers.get("x-ratelimit-limit"),
      bodyHead: res.ok ? undefined : text.slice(0, 200),
    });
  } catch (e) {
    return NextResponse.json({ instance, domain, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
  }
}
