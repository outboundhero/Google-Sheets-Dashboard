import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getSupabaseAdmin } from "@/lib/supabase";
import { createDomain, setAutoRenew } from "@/lib/porkbun";
import { appendToSecondaryDomainColumn } from "@/lib/google-sheets-secondary-domain";

// Drains `porkbun_buy_queue`: buys at most 20 domains per 8-hour window on the
// outboundhero Porkbun account (via porkbun.ts, which is hard-locked to that
// account). Runs on a cron; the 8h gate — not the cron cadence — decides when a
// batch actually fires, so a multi-day backlog empties 20-at-a-time regardless
// of whether any browser tab is open.

const WINDOW_MS = 8 * 60 * 60 * 1000;
const MAX_PER_BATCH = 20;
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
    // (2) 8h window gate — a new batch may start only if the most recent
    //     successful purchase is ≥8h old (or none exists).
    const { data: lastRows } = await supabase
      .from("porkbun_buy_queue")
      .select("purchased_at")
      .eq("status", "registered")
      .order("purchased_at", { ascending: false })
      .limit(1);
    const lastPurchasedAt = lastRows?.[0]?.purchased_at ? new Date(lastRows[0].purchased_at).getTime() : null;
    if (lastPurchasedAt && Date.now() - lastPurchasedAt < WINDOW_MS) {
      return NextResponse.json({
        skipped: "window",
        nextEligibleAt: new Date(lastPurchasedAt + WINDOW_MS).toISOString(),
      });
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
