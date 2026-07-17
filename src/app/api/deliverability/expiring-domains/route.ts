import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  porkbunAccounts,
  listExpiringDomains,
  getRenewalPricing,
  type PorkbunDomainRow,
} from "@/lib/porkbun-domains";

// GET /api/deliverability/expiring-domains (admin-only)
//
// Domains ≤ 10 days from expiring across both Porkbun accounts, with est.
// renewal (pricing/get) and provider linkage (Inboxing/MilkBox/ScaledMail)
// resolved from ONE deliverability_domains tag lookup — no per-domain API call.
// Cached ~30 min in Redis (?fresh=1 bypasses).
export const maxDuration = 60;

const WITHIN_DAYS = 10;
const CACHE_KEY = "expiring-domains:v1";
const CACHE_TTL_S = 1800;

type Provider = "inboxing" | "milkbox" | "scaledmail" | null;

interface ExpiringDomain {
  account: string;
  domain: string;
  tld: string;
  expireDate: string;
  daysLeft: number;
  autoRenew: boolean;
  estRenewal: number | null;
  provider: Provider;
}

interface AccountInfo { label: string; ok: boolean; error?: string }

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Same classification the cancel-domains route uses (by tag-name substring).
function detectProvider(tags: string[]): Provider {
  const lower = tags.map((t) => (t || "").toLowerCase());
  if (lower.some((t) => t.includes("milkbox"))) return "milkbox";
  if (lower.some((t) => t.includes("scaledmail") || t.includes("scaled mail"))) return "scaledmail";
  if (lower.some((t) => t.includes("inboxing"))) return "inboxing";
  return null;
}

// One indexed Supabase read → provider per domain (tags unioned across instances).
async function resolveProviders(domains: string[]): Promise<Map<string, Provider>> {
  const supabase = getSupabaseAdmin();
  const tagsByDomain = new Map<string, string[]>();
  for (let i = 0; i < domains.length; i += 200) {
    const batch = domains.slice(i, i + 200);
    const { data } = await supabase
      .from("deliverability_domains")
      .select("domain, tags")
      .in("domain", batch);
    for (const r of (data || []) as { domain: string; tags: string[] | null }[]) {
      const arr = tagsByDomain.get(r.domain) || [];
      if (Array.isArray(r.tags)) arr.push(...r.tags);
      tagsByDomain.set(r.domain, arr);
    }
  }
  const out = new Map<string, Provider>();
  for (const [domain, tags] of tagsByDomain) out.set(domain, detectProvider(tags));
  return out;
}

function daysUntil(expireDate: string): number {
  const exp = new Date(expireDate.replace(" ", "T")).getTime();
  return Math.ceil((exp - Date.now()) / 86_400_000);
}

async function crawl(): Promise<{ domains: ExpiringDomain[]; accounts: AccountInfo[] }> {
  const accts = porkbunAccounts();
  const pricingP = getRenewalPricing().catch(() => new Map<string, number>());
  const results = await Promise.allSettled(accts.map((a) => listExpiringDomains(a, WITHIN_DAYS)));
  const pricing = await pricingP;

  const accounts: AccountInfo[] = [];
  const raw: { acct: string; r: PorkbunDomainRow }[] = [];
  results.forEach((res, i) => {
    const label = accts[i].label;
    if (res.status === "fulfilled") {
      accounts.push({ label, ok: true });
      for (const r of res.value) raw.push({ acct: label, r });
    } else {
      accounts.push({ label, ok: false, error: res.reason instanceof Error ? res.reason.message : "failed" });
    }
  });

  // Only ACTIVE domains genuinely expiring in the next 10 days (drop AUCTION/EXPIRED).
  const kept = raw
    .filter(({ r }) => (r.status || "").toUpperCase() === "ACTIVE")
    .map(({ acct, r }) => ({ acct, r, daysLeft: daysUntil(r.expireDate) }))
    .filter((x) => x.daysLeft >= 0 && x.daysLeft <= WITHIN_DAYS);

  const providers = await resolveProviders([...new Set(kept.map((x) => x.r.domain))]);

  const domains: ExpiringDomain[] = kept.map(({ acct, r, daysLeft }) => {
    const tld = (r.tld || r.domain.split(".").pop() || "").toLowerCase();
    return {
      account: acct,
      domain: r.domain,
      tld,
      expireDate: r.expireDate,
      daysLeft,
      autoRenew: r.autoRenew === 1,
      estRenewal: pricing.get(tld) ?? null,
      provider: providers.get(r.domain) ?? null,
    };
  });
  domains.sort((a, b) => a.daysLeft - b.daysLeft || a.domain.localeCompare(b.domain));
  return { domains, accounts };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fresh = searchParams.get("fresh") === "1";
  const redis = getRedis();

  if (!fresh && redis) {
    const cached = await redis.get<{ domains: ExpiringDomain[]; accounts: AccountInfo[] }>(CACHE_KEY);
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  const payload = await crawl();
  if (redis && payload.accounts.every((a) => a.ok)) {
    await redis.set(CACHE_KEY, payload, { ex: CACHE_TTL_S });
  }
  return NextResponse.json({ ...payload, cached: false });
}
