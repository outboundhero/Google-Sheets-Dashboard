// Resolves a domain's email provider from its MX records via DNS-over-HTTPS
// (Google `dns.google/resolve`). We use DoH instead of node:dns because Vercel
// serverless functions block raw UDP/53 to public resolvers, so a pinned
// dns.Resolver silently times out on every lookup. DoH is plain HTTPS and works.
// `provider: null` = inconclusive (network error) so callers never cache a wrong
// answer; "parked" = a definite "no mail records".

const DOH_URL = "https://dns.google/resolve";
const TOTAL_BUDGET_MS = 5000;

// "parked" = has DNS but no MX (no mailbox). "no-dns" = domain delegated but its
// authoritative nameservers don't serve a zone (DoH SERVFAIL/REFUSED/NXDOMAIN) —
// verified against authoritative NS, so there is genuinely no provider to find.
export type MxProvider = "google" | "outlook" | "zoho" | "porkbun" | "other" | "parked" | "no-dns";

export interface MxResult {
  domain: string;
  provider: MxProvider | null;
  hosts: string[];
  error: string | null;
}

function classify(hosts: string[]): MxProvider {
  if (hosts.length === 0) return "parked";
  const h = hosts.join(" ");
  if (/(^|\.)aspmx\.l\.google\.com|\.google\.com|googlemail\.com/.test(h)) return "google";
  if (/\.mail\.protection\.outlook\.com|\.olc\.protection\.outlook\.com|(^|\.)outlook\.com/.test(h)) return "outlook";
  if (/zoho/.test(h)) return "zoho";
  if (/(^|\.)porkbun\.com/.test(h)) return "porkbun"; // Porkbun email forwarding (fwd*.porkbun.com)
  return "other";
}

export async function resolveMxProvider(rawDomain: string): Promise<MxResult> {
  const domain = rawDomain.trim().toLowerCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOTAL_BUDGET_MS);
  try {
    const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
    const json = (await res.json()) as {
      Status?: number;
      Answer?: { type?: number; data?: string }[];
    };

    // Status 0 = NOERROR → read MX (parked if none). Any OTHER definitive DoH
    // status — SERVFAIL (2), NXDOMAIN (3), REFUSED (5), … — means the domain's
    // authoritative nameservers don't serve a working zone, so there is no mail
    // and no provider to detect (verified against the authoritative NS). Cache
    // it as "no-dns" so it isn't re-checked forever. Only network/timeout errors
    // (caught below) stay inconclusive and get retried.
    if (json.Status !== 0) {
      return { domain, provider: "no-dns", hosts: [], error: `DoH status ${json.Status}` };
    }

    const answers = Array.isArray(json.Answer) ? json.Answer : [];
    const hosts = answers
      .filter((a) => a.type === 15 && typeof a.data === "string") // type 15 = MX
      .map((a) => (a.data as string).trim().split(/\s+/).pop() || "")
      .map((h) => h.replace(/\.$/, "").toLowerCase())
      .filter(Boolean);
    // NOERROR with no MX answers ⇒ definitely no mail ⇒ parked.
    return { domain, provider: classify(hosts), hosts, error: null };
  } catch (e) {
    return {
      domain,
      provider: null,
      hosts: [],
      error: `MX lookup failed: ${e instanceof Error ? e.message : "unknown"}`.slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}
