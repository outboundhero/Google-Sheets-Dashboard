// Reserve warm-up forecast (Spencer's Loom: "the next 10 domains complete
// warm-up on July 27") — READ-ONLY. Lists every UNTAGGED (reserve) domain still
// inside the 21-day warm-up window and buckets them by the PST date they finish,
// so it's always known when the next replacements become possible.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import { pstDateString } from "@/lib/date-utils";

const WARMUP_DAYS = 21; // same completion rule as the replacement plan

interface DomRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
  domain_created_at: string | null;
  outlook_count: number | null;
  google_count: number | null;
  blacklisted: boolean | null;
  spamhaus_dbl: boolean | null;
}

export interface WarmingDomain {
  instance: BisonInstanceSlug;
  domain: string;
  provider: "outlook" | "google" | "mixed" | "unknown";
  readyDate: string;      // PST date warm-up completes (created + 21d)
  daysLeft: number;
  pullable: boolean;      // will be usable as a replacement (pure provider, non-.info, clean)
}

export interface ReadyBucket {
  date: string;           // PST date
  daysFromNow: number;
  total: number;
  pullable: number;
  byInstance: Record<string, number>;
  domains: WarmingDomain[];
}

export interface WarmupForecast {
  today: string;
  warmupDays: number;
  readyNow: number;        // untagged domains already ≥ 21d (current reserve)
  warmingTotal: number;    // untagged domains still warming
  pullableTotal: number;
  buckets: ReadyBucket[];  // soonest first
}

export async function buildWarmupForecast(): Promise<WarmupForecast> {
  const supabase = getSupabaseAdmin();
  const today = pstDateString(new Date());
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  // known client tags (redirects ∪ campaigns) — a domain carrying one is
  // assigned to a client, not reserve. Same convention as detection/plan.
  const knownTags = new Set<string>();
  const [{ data: redir }, { data: camps }] = await Promise.all([
    supabase.from("client_redirects").select("client_tag"),
    supabase.from("campaigns").select("client_tag"),
  ]);
  for (const r of (redir || []) as { client_tag: string | null }[]) if (r.client_tag) knownTags.add(r.client_tag.toUpperCase());
  for (const c of (camps || []) as { client_tag: string | null }[]) if (c.client_tag) knownTags.add(c.client_tag.toUpperCase());
  const isAssigned = (tags: string[] | null): boolean =>
    (tags || []).some((t) => knownTags.has(String(t).trim().toUpperCase()));

  const rows: DomRow[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags,domain_created_at,outlook_count,google_count,blacklisted,spamhaus_dbl")
      .in("instance", ALL_INSTANCE_SLUGS)
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as DomRow[]));
    if (data.length < 1000) break;
    off += 1000;
  }

  let readyNow = 0;
  const warming: WarmingDomain[] = [];
  for (const d of rows) {
    if (isAssigned(d.tags)) continue;                 // reserve only
    if (!d.domain_created_at) continue;               // unknown age → can't forecast
    const createdMs = new Date(d.domain_created_at).getTime();
    const ageDays = Math.floor((todayMs - createdMs) / 86_400_000);
    if (ageDays >= WARMUP_DAYS) { readyNow++; continue; }

    const o = d.outlook_count ?? 0, g = d.google_count ?? 0;
    const provider = o > 0 && g > 0 ? "mixed" : o > 0 ? "outlook" : g > 0 ? "google" : "unknown";
    const readyMs = createdMs + WARMUP_DAYS * 86_400_000;
    warming.push({
      instance: d.instance,
      domain: d.domain,
      provider,
      readyDate: pstDateString(new Date(readyMs)),
      daysLeft: Math.max(0, WARMUP_DAYS - ageDays),
      pullable:
        (provider === "outlook" || provider === "google") &&
        !d.domain.toLowerCase().endsWith(".info") &&
        d.blacklisted !== true && d.spamhaus_dbl !== true,
    });
  }

  const byDate = new Map<string, WarmingDomain[]>();
  for (const w of warming) {
    if (!byDate.has(w.readyDate)) byDate.set(w.readyDate, []);
    byDate.get(w.readyDate)!.push(w);
  }
  const buckets: ReadyBucket[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, domains]) => {
      const byInstance: Record<string, number> = {};
      for (const w of domains) byInstance[w.instance] = (byInstance[w.instance] || 0) + 1;
      return {
        date,
        daysFromNow: Math.round((Date.parse(`${date}T00:00:00Z`) - todayMs) / 86_400_000),
        total: domains.length,
        pullable: domains.filter((w) => w.pullable).length,
        byInstance,
        domains: domains.sort((x, y) => x.instance.localeCompare(y.instance) || x.domain.localeCompare(y.domain)),
      };
    });

  return {
    today,
    warmupDays: WARMUP_DAYS,
    readyNow,
    warmingTotal: warming.length,
    pullableTotal: warming.filter((w) => w.pullable).length,
    buckets,
  };
}
