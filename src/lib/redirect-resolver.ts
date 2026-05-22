const PER_DOMAIN_TIMEOUT_MS = 8000;
const MAX_HOPS = 6;
// A real browser UA — Cloudflare-fronted forwarding domains challenge/block
// obvious bot agents, which would hide the redirect entirely.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ResolveResult {
  domain: string;
  redirectUrl: string | null;
  error: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Walk the redirect chain one hop at a time with redirect: "manual", reading the
 * Location header at each step. This captures the real redirect target even when
 * the destination later blocks bots (Cloudflare 403 / challenge) — the answer is
 * already in the first hop's Location header, so we never need to load the
 * (possibly blocked) destination.
 */
async function walkRedirects(startUrl: string): Promise<string> {
  let currentUrl = startUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PER_DOMAIN_TIMEOUT_MS),
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      try {
        currentUrl = new URL(loc, currentUrl).toString();
      } catch {
        break;
      }
      continue;
    }
    break; // not a redirect — this is the final destination
  }
  return currentUrl;
}

export async function resolveRedirect(rawDomain: string): Promise<ResolveResult> {
  const domain = rawDomain.trim().toLowerCase();
  const startHost = hostOf(`http://${domain}`);
  let reachable = false;
  let lastError = "Could not reach domain";

  for (const scheme of ["https", "http"] as const) {
    try {
      const finalUrl = await walkRedirects(`${scheme}://${domain}`);
      const finalHost = hostOf(finalUrl);
      if (finalHost && startHost && finalHost !== startHost) {
        return { domain, redirectUrl: finalUrl, error: null };
      }
      reachable = true; // reachable but no external redirect on this scheme
    } catch (e) {
      lastError = e instanceof Error ? e.message : "fetch failed";
    }
  }

  // Reachable on at least one scheme with no external redirect → genuinely none.
  if (reachable) return { domain, redirectUrl: null, error: null };
  return { domain, redirectUrl: null, error: lastError.slice(0, 200) };
}
