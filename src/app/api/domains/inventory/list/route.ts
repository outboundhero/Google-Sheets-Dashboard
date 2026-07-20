import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { assembleInventory, type InventoryRow, type InventoryCounts } from "@/lib/domain-inventory";

// GET /api/domains/inventory/list  (admin-only via middleware)
// Merged inventory (both Porkbun accounts + manual) with in-use + provider.
// Cached ~10 min in Redis (?fresh=1 bypasses).
export const maxDuration = 60;

const CACHE_KEY = "domain-inventory:v1";
const CACHE_TTL_S = 600;

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fresh = searchParams.get("fresh") === "1";
    const redis = getRedis();

    if (!fresh && redis) {
      const cached = await redis.get<{ rows: InventoryRow[]; counts: InventoryCounts; generatedAt: string }>(CACHE_KEY);
      if (cached) return NextResponse.json({ ...cached, cached: true });
    }

    const { rows, counts } = await assembleInventory();
    const payload = { rows, counts, generatedAt: new Date().toISOString() };
    if (redis) await redis.set(CACHE_KEY, payload, { ex: CACHE_TTL_S });
    return NextResponse.json({ ...payload, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
