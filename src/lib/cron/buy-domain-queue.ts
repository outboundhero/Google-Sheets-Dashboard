import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createDomain, setAutoRenew } from "@/lib/porkbun";
import { appendToSecondaryDomainColumn } from "@/lib/google-sheets-secondary-domain";

// Drains `porkbun_buy_queue` as a DRIP, not batches — Ramon @ Inboxing's
// anti-SURBL guidance (Spencer, 2026-07-31, supersedes the 7/23 batch spec):
//   • ONE domain at a time, the next 2–10 minutes later (random each time);
//   • once per ~20-domain window, a random ~2-hour pause lands somewhere in
//     the middle so the cadence never looks scripted;
//   • ≈20 domains over ≈4 hours, never a synchronized bulk burst.
// The cron fires every 5 minutes; a Redis-stored next-purchase-at gate — not
// the cron cadence — decides whether THIS tick buys. One purchase per tick.
const GAP_MIN_MS = 2 * 60 * 1000;
const GAP_MAX_MS = 10 * 60 * 1000;
const PAUSE_MS = 2 * 60 * 60 * 1000;      // the long random rest
const PAUSE_WINDOW = 20;                   // one pause somewhere in every ~20 buys
const nextGapMs = () => GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
const DRIP_NEXT_KEY = "cron:porkbun-buy:next-at";
const DRIP_COUNT_KEY = "cron:porkbun-buy:window-count";
const DRIP_PAUSEAT_KEY = "cron:porkbun-buy:pause-at";
const MAX_PER_BATCH = 1;                   // drip = exactly one per eligible tick
const TICK_MS = 10_500;        // Porkbun create limit is ~1/10s
const DEADLINE_MS = 270_000;   // stop before the route's maxDuration=300
const LOCK_KEY = "cron:porkbun-buy:lock";
const LOCK_TTL_S = 320;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function is429(msg: string): boolean {
  return /429|rate.?limit|too many/i.test(msg);
}
function isTaken(msg: string): boolean {
  return /already|not available|unavailable|taken|registered/i.test(msg);
}

interface QueueRow {
  id: string;
  domain: string;
  real_price_usd: number | string | null;
  requested_at: string;
}

export async function runBuyQueue(): Promise<NextResponse> {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();
  const redis = getRedis();
  const runId = crypto.randomUUID();

  // (1) Overlap guard.
  let haveLock = false;
  if (redis) {
    const got = await redis.set(LOCK_KEY, runId, { nx: true, ex: LOCK_TTL_S });
    if (!got) return NextResponse.json({ skipped: "locked" });
    haveLock = true;
  }

  try {
    // (2) Drip gate — buy only when the randomized next-purchase-at has
    //     passed. Redis holds the schedule; without Redis, fall back to a
    //     conservative fixed 10-min gap off the last DB purchase.
    if (redis) {
      const nextAt = await redis.get<string>(DRIP_NEXT_KEY);
      if (nextAt && Date.now() < new Date(nextAt).getTime()) {
        return NextResponse.json({ skipped: "drip-wait", nextEligibleAt: nextAt });
      }
    } else {
      const { data: lastRows } = await supabase
        .from("porkbun_buy_queue")
        .select("purchased_at")
        .eq("status", "registered")
        .order("purchased_at", { ascending: false })
        .limit(1);
      const last = lastRows?.[0]?.purchased_at ? new Date(lastRows[0].purchased_at).getTime() : null;
      if (last && Date.now() - last < GAP_MAX_MS) {
        return NextResponse.json({ skipped: "drip-wait", nextEligibleAt: new Date(last + GAP_MAX_MS).toISOString() });
      }
    }

    // (3) Claim a batch of the oldest queued rows.
    const { data: claimable } = await supabase
      .from("porkbun_buy_queue")
      .select("id")
      .eq("status", "queued")
      .order("requested_at", { ascending: true })
      .limit(MAX_PER_BATCH);
    const ids = (claimable || []).map((r) => r.id as string);
    if (ids.length === 0) return NextResponse.json({ skipped: "empty" });

    const batchId = crypto.randomUUID();
    const { data: claimed } = await supabase
      .from("porkbun_buy_queue")
      .update({ status: "buying", batch_id: batchId, updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "queued")
      .select("id, domain, real_price_usd, requested_at");
    const rows = (claimed || []) as QueueRow[];
    rows.sort((a, b) => new Date(a.requested_at).getTime() - new Date(b.requested_at).getTime());

    let registered = 0, skipped = 0, failed = 0;
    const bought: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Wall-clock guard: return any not-yet-attempted rows to the queue.
      if (Date.now() - t0 > DEADLINE_MS) {
        const remaining = rows.slice(i).map((r) => r.id);
        await supabase.from("porkbun_buy_queue")
          .update({ status: "queued", batch_id: null, updated_at: new Date().toISOString() })
          .in("id", remaining);
        break;
      }
      if (i > 0) await delay(TICK_MS);

      const price = typeof row.real_price_usd === "number" ? row.real_price_usd : parseFloat(String(row.real_price_usd || "0"));
      if (!Number.isFinite(price) || price <= 0) {
        await supabase.from("porkbun_buy_queue")
          .update({ status: "skipped", last_error: "no stored price", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        skipped++;
        continue;
      }

      try {
        await createDomain(row.domain, price);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "createDomain failed";
        if (is429(msg)) {
          // Back off: return this + all remaining rows to the queue and stop.
          const remaining = rows.slice(i).map((r) => r.id);
          await supabase.from("porkbun_buy_queue")
            .update({ status: "queued", batch_id: null, last_error: "429 backoff", updated_at: new Date().toISOString() })
            .in("id", remaining);
          break;
        }
        const status = isTaken(msg) ? "skipped" : "failed";
        if (status === "skipped") skipped++; else failed++;
        await supabase.from("porkbun_buy_queue")
          .update({ status, last_error: msg.slice(0, 500), updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      // Registered on Porkbun.
      const nowIso = new Date().toISOString();
      registered++;
      bought.push(row.domain);
      await supabase.from("porkbun_buy_queue")
        .update({ status: "registered", purchased_at: nowIso, last_error: null, updated_at: nowIso })
        .eq("id", row.id);
      await supabase.from("porkbun_domains").upsert(
        { domain: row.domain, registered: true, registered_at: nowIso, available: true, price_usd: price },
        { onConflict: "domain" }
      );
      // Surface it in All Domains / Purchased immediately (renewal ≈ +1yr,
      // corrected exactly on the next Porkbun refresh).
      const renewIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from("domain_inventory").upsert(
        {
          domain: row.domain,
          source: "porkbun_outboundhero",
          manual: false,
          tld: `.${row.domain.split(".").pop()}`,
          porkbun_status: "ACTIVE",
          expire_date: renewIso,
          auto_renew: false,
          last_synced_at: nowIso,
        },
        { onConflict: "domain" }
      );

      // Auto-renew OFF (non-fatal).
      try {
        await setAutoRenew(row.domain, false);
        await supabase.from("porkbun_buy_queue").update({ auto_renew_disabled: true }).eq("id", row.id);
        await supabase.from("porkbun_domains").update({ auto_renew_disabled: true }).eq("domain", row.domain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "auto-renew failed";
        await supabase.from("porkbun_buy_queue").update({ last_error: `autorenew: ${msg}`.slice(0, 500) }).eq("id", row.id);
      }

      // Append to the Secondary Domain sheet (non-fatal, deduped by the helper).
      try {
        await appendToSecondaryDomainColumn([row.domain]);
        await supabase.from("porkbun_buy_queue").update({ appended_to_sheet: true }).eq("id", row.id);
        await supabase.from("porkbun_domains").update({ appended_to_sheet: true }).eq("domain", row.domain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "sheet append failed";
        await supabase.from("porkbun_buy_queue").update({ last_error: `sheet: ${msg}`.slice(0, 500) }).eq("id", row.id);
      }
    }

    // (5) Schedule the next drip slot (Ramon's cadence). Counted on real
    //     purchases; skips/failures retry on a short gap without advancing
    //     the pause window.
    if (redis) {
      let gap = nextGapMs();
      let windowNote = "gap";
      if (registered > 0) {
        const count = ((await redis.get<number>(DRIP_COUNT_KEY)) ?? 0) + registered;
        let pauseAt = await redis.get<number>(DRIP_PAUSEAT_KEY);
        if (pauseAt == null) {
          pauseAt = 3 + Math.floor(Math.random() * 15); // somewhere mid-window
          await redis.set(DRIP_PAUSEAT_KEY, pauseAt);
        }
        if (count >= PAUSE_WINDOW) {
          await redis.set(DRIP_COUNT_KEY, 0);
          await redis.del(DRIP_PAUSEAT_KEY);
        } else {
          await redis.set(DRIP_COUNT_KEY, count);
          if (count === pauseAt) {
            gap = PAUSE_MS + Math.random() * 10 * 60 * 1000; // the random ~2h rest
            windowNote = "long-pause";
          }
        }
      }
      const nextAt = new Date(Date.now() + gap).toISOString();
      await redis.set(DRIP_NEXT_KEY, nextAt);
      return NextResponse.json({ batchId, attempted: rows.length, registered, skipped, failed, bought, nextEligibleAt: nextAt, windowNote });
    }
    return NextResponse.json({ batchId, attempted: rows.length, registered, skipped, failed, bought });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (haveLock && redis) {
      // Release only if we still own it.
      const cur = await redis.get(LOCK_KEY);
      if (cur === runId) await redis.del(LOCK_KEY);
    }
  }
}
