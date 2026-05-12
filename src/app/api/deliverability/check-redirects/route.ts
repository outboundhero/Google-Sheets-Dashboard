import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const CONCURRENT = 20;
const PER_DOMAIN_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; LeadSyncRedirectCheck/1.0; +https://leadsync.outboundhero.co)";

export const maxDuration = 60;

interface CheckResult {
  domain: string;
  redirectUrl: string | null;
  error: string | null;
}

async function resolveRedirect(domain: string): Promise<CheckResult> {
  const cleaned = domain.trim().toLowerCase();
  const tryUrl = async (scheme: "http" | "https"): Promise<string | null> => {
    const startUrl = `${scheme}://${cleaned}`;
    const res = await fetch(startUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PER_DOMAIN_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    });
    const finalUrl = res.url || startUrl;
    let startHost: string;
    let finalHost: string;
    try {
      startHost = new URL(startUrl).hostname.replace(/^www\./, "");
      finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
    if (startHost === finalHost) return null; // no external redirect
    return finalUrl;
  };

  try {
    const httpResult = await tryUrl("http");
    if (httpResult) return { domain: cleaned, redirectUrl: httpResult, error: null };
    return { domain: cleaned, redirectUrl: null, error: null };
  } catch {
    // Fall back to https if http failed entirely (DNS, connection refused, etc.)
    try {
      const httpsResult = await tryUrl("https");
      return { domain: cleaned, redirectUrl: httpsResult, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      return { domain: cleaned, redirectUrl: null, error: msg.slice(0, 200) };
    }
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const normalized: string[] = [];
    for (const d of raw) {
      if (typeof d !== "string") continue;
      const v = d.trim().toLowerCase();
      if (v) normalized.push(v);
    }
    const domains: string[] = Array.from(new Set<string>(normalized));
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains array required" }, { status: 400 });
    }

    const results: CheckResult[] = [];
    for (let i = 0; i < domains.length; i += CONCURRENT) {
      const batch = domains.slice(i, i + CONCURRENT);
      const settled = await Promise.allSettled(batch.map((d) => resolveRedirect(d)));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status === "fulfilled") results.push(r.value);
        else results.push({ domain: batch[j], redirectUrl: null, error: "unknown" });
      }
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const rows = results.map((r) => ({
      domain: r.domain,
      redirect_url: r.redirectUrl,
      redirect_checked_at: now,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200);
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(slice, { onConflict: "domain", ignoreDuplicates: false });
      if (error) console.error("[check-redirects] upsert failed:", error.message);
    }

    return NextResponse.json({ results, checked: results.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
