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
