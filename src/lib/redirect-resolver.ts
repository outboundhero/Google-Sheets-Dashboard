// Total wall-clock budget for resolving ONE domain (across every hop and both
// schemes). Keeps a batch of these well under the 60s serverless limit.
const TOTAL_BUDGET_MS = 10000;
const PER_HOP_CAP_MS = 7000;
const MAX_HOPS = 6;
// A real browser UA — Cloudflare-fronted forwarding domains challenge/block
// obvious bot agents, which would hide the redirect entirely.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ResolveResult {
  domain: string;
  redirectUrl: string | null;
  error: string | null;
  /**
   * True when the domain answered but behind a bot challenge, so we learned
   * nothing about its redirect. Callers must treat this as UNKNOWN and leave
   * the stored value alone — writing null here is what made 735 domains read
   * as "no redirect" when the redirect was in fact set (CVJLOU, 2026-09-23).
   */
  blocked?: boolean;
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
function isBotChallenge(res: Response): boolean {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  const server = (res.headers.get("server") || "").toLowerCase();
  if ((res.status === 403 || res.status === 503) && server.includes("cloudflare")) return true;
  return res.status === 429;
}

async function walkRedirects(startUrl: string, deadline: number): Promise<{ url: string; blocked: boolean }> {
  let currentUrl = startUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break; // out of budget — stop with whatever we have
    const res = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(PER_HOP_CAP_MS, remaining)),
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
    // A challenge page is not an answer — the redirect may well be there, we
    // just were not allowed to see it.
    if (isBotChallenge(res)) return { url: currentUrl, blocked: true };
    break; // not a redirect — this is the final destination
  }
  return { url: currentUrl, blocked: false };
}

export async function resolveRedirect(rawDomain: string): Promise<ResolveResult> {
  const domain = rawDomain.trim().toLowerCase();
  const startHost = hostOf(`http://${domain}`);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let reachable = false;
  let blocked = false;
  let lastError = "Could not reach domain";

  for (const scheme of ["https", "http"] as const) {
    if (Date.now() >= deadline) break;
    try {
      const walk = await walkRedirects(`${scheme}://${domain}`, deadline);
      const finalHost = hostOf(walk.url);
      if (finalHost && startHost && finalHost !== startHost) {
        return { domain, redirectUrl: walk.url, error: null };
      }
      if (walk.blocked) blocked = true;
      else reachable = true; // answered for real, with no external redirect
    } catch (e) {
      lastError = e instanceof Error ? e.message : "fetch failed";
    }
  }

  // Answered for real on at least one scheme with no external redirect →
  // genuinely none.
  if (reachable) return { domain, redirectUrl: null, error: null };
  // Only a challenge page came back → we do not know. Say so; do not claim
  // "no redirect".
  if (blocked) {
    return { domain, redirectUrl: null, error: "blocked by bot protection", blocked: true };
  }
  return { domain, redirectUrl: null, error: lastError.slice(0, 200) };
}
