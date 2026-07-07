export type BisonInstanceSlug =
  | "outboundhero"
  | "cleaningoutbound"
  | "facilityreach"
  | "outboundclean";

export type BisonGroup = 1 | 2;
export type BisonTier = "b2b" | "b2c";

export interface BisonInstance {
  slug: BisonInstanceSlug;
  label: string;
  group: BisonGroup;
  tier: BisonTier;
  baseUrl: string;
  apiKeyEnv: string;
}

export const BISON_INSTANCES: Record<BisonInstanceSlug, BisonInstance> = {
  outboundhero: {
    slug: "outboundhero",
    label: "OutboundHero – B2B #1",
    group: 1,
    tier: "b2b",
    baseUrl: "https://app.outboundhero.co/api",
    apiKeyEnv: "OUTBOUNDHERO_API_KEY",
  },
  cleaningoutbound: {
    slug: "cleaningoutbound",
    label: "OutboundHero – B2C #1",
    group: 1,
    tier: "b2c",
    baseUrl: "https://personal.cleaningoutbound.com/api",
    apiKeyEnv: "CLEANINGOUTBOUND_API_KEY",
  },
  facilityreach: {
    slug: "facilityreach",
    label: "OutboundHero – B2B #2",
    group: 2,
    tier: "b2b",
    baseUrl: "https://app.facilityreach.com/api",
    apiKeyEnv: "FACILITYREACH_API_KEY",
  },
  outboundclean: {
    slug: "outboundclean",
    label: "OutboundHero – B2C #2",
    group: 2,
    tier: "b2c",
    baseUrl: "https://personal.outboundclean.com/api",
    apiKeyEnv: "OUTBOUNDCLEAN_API_KEY",
  },
};

export const ALL_INSTANCE_SLUGS: BisonInstanceSlug[] = [
  "outboundhero",
  "cleaningoutbound",
  "facilityreach",
  "outboundclean",
];

export const DEFAULT_INSTANCE: BisonInstanceSlug = "outboundhero";
export const DEFAULT_GROUP: BisonGroup = 1;

/** Compact per-instance labels for dense UI (chips, table cells). */
export const INSTANCE_SHORT_LABELS: Record<BisonInstanceSlug, string> = {
  outboundhero: "B2B1·OH",
  cleaningoutbound: "B2C1·CO",
  facilityreach: "B2B2·FR",
  outboundclean: "B2C2·OC",
};

export function isInstanceSlug(v: unknown): v is BisonInstanceSlug {
  return (
    v === "outboundhero" ||
    v === "cleaningoutbound" ||
    v === "facilityreach" ||
    v === "outboundclean"
  );
}

export function getInstance(slug: string): BisonInstance {
  if (!isInstanceSlug(slug)) {
    throw new Error(`Unknown Bison instance: ${slug}`);
  }
  return BISON_INSTANCES[slug];
}

export function instancesInGroup(group: BisonGroup): BisonInstance[] {
  return ALL_INSTANCE_SLUGS
    .map((s) => BISON_INSTANCES[s])
    .filter((i) => i.group === group);
}

export function parseGroup(v: unknown): BisonGroup | null {
  if (v === 1 || v === "1") return 1;
  if (v === 2 || v === "2") return 2;
  return null;
}

export function parseTier(v: unknown): BisonTier | null {
  if (v === "b2b" || v === "b2c") return v;
  return null;
}
