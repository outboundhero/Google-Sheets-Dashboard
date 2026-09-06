import {
  ALL_INSTANCE_SLUGS,
  BISON_INSTANCES,
  DEFAULT_INSTANCE,
  isInstanceSlug,
  type BisonInstanceSlug,
} from "./bison-instances";

export function resolveInstance(value: unknown): BisonInstanceSlug {
  return isInstanceSlug(value) ? value : DEFAULT_INSTANCE;
}

/**
 * Parse `?instances=<csv>` (multi) or `?instance=<slug>` (single) from a URL.
 * Returns a non-empty list of instance slugs. If both/neither are present or invalid,
 * defaults to `[DEFAULT_INSTANCE]` so back-compat callers still get OutboundHero data.
 */
export function resolveInstances(searchParams: URLSearchParams): BisonInstanceSlug[] {
  const csv = searchParams.get("instances");
  if (csv) {
    const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
    const valid = parts.filter(isInstanceSlug);
    if (valid.length > 0) return [...new Set(valid)];
  }
  const single = searchParams.get("instance");
  if (single && isInstanceSlug(single)) return [single];
  return [DEFAULT_INSTANCE];
}

export { ALL_INSTANCE_SLUGS };

export function bisonHeaders(instance: BisonInstanceSlug): { Authorization: string } {
  const inst = BISON_INSTANCES[instance];
  const key = process.env[inst.apiKeyEnv];
  if (!key) {
    throw new Error(
      `Missing env var ${inst.apiKeyEnv} for Bison instance ${instance}`,
    );
  }
  return { Authorization: `Bearer ${key}` };
}

export async function bisonFetch(
  instance: BisonInstanceSlug,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const inst = BISON_INSTANCES[instance];
  const url = path.startsWith("http") ? path : `${inst.baseUrl}${path}`;
  return fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      ...bisonHeaders(instance),
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Query term for GET /sender-emails?search= that stays EXACT on every instance.
 *
 * facilityreach and outboundclean run a newer Bison whose search falls back to
 * fuzzy "did-you-mean" matching when a dotted query has no substring hits: an
 * EMPTY domain like crystalfacilityclean.com returned 9,868 unrelated senders
 * (2026-09-06), so every verify-by-search paged forever. The bare label (no
 * TLD) never trips that fallback and still substring-matches the real senders
 * (plus name-cousins such as commercialcareplusclean.info for
 * commercialcareplus) — callers MUST keep filtering by exact email domain.
 */
export function senderSearchTerm(domain: string): string {
  const d = domain.trim().toLowerCase();
  const label = d.split(".")[0];
  return label.length >= 4 ? label : d;
}

/** True when `email` belongs exactly to `domain` (case-insensitive). */
export function emailIsOnDomain(email: string | null | undefined, domain: string): boolean {
  return String(email || "").split("@")[1]?.toLowerCase() === domain.trim().toLowerCase();
}
