// Resolves a domain's email provider from its MX records via DNS-over-HTTPS
// (Google `dns.google/resolve`). We use DoH instead of node:dns because Vercel
// serverless functions block raw UDP/53 to public resolvers, so a pinned
// dns.Resolver silently times out on every lookup. DoH is plain HTTPS and works.
// `provider: null` = inconclusive (network error) so callers never cache a wrong
// answer; "parked" = a definite "no mail records".

const DOH_URL = "https://dns.google/resolve";
const TOTAL_BUDGET_MS = 5000;

export type MxProvider = "google" | "outlook" | "zoho" | "other" | "parked";

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

    // Status: 0 = NOERROR, 3 = NXDOMAIN (domain has no records at all).
    if (json.Status === 3) return { domain, provider: "parked", hosts: [], error: null };
    if (json.Status !== 0) return { domain, provider: null, hosts: [], error: `DoH status ${json.Status}` };

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
