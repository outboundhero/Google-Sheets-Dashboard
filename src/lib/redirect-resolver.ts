const PER_DOMAIN_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; LeadSyncRedirectCheck/1.0; +https://leadsync.outboundhero.co)";

export interface ResolveResult {
  domain: string;
  redirectUrl: string | null;
  error: string | null;
}

async function tryScheme(domain: string, scheme: "http" | "https"): Promise<string | null> {
  const startUrl = `${scheme}://${domain}`;
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
}

export async function resolveRedirect(rawDomain: string): Promise<ResolveResult> {
  const domain = rawDomain.trim().toLowerCase();
  try {
    const httpResult = await tryScheme(domain, "http");
    return { domain, redirectUrl: httpResult, error: null };
  } catch {
    try {
      const httpsResult = await tryScheme(domain, "https");
      return { domain, redirectUrl: httpsResult, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      return { domain, redirectUrl: null, error: msg.slice(0, 200) };
    }
  }
}
