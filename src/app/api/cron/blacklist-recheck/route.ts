import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { checkBlacklist } from "@/lib/blacklist-resolver";
import { checkSpamhausDbl } from "@/lib/spamhaus-dbl-resolver";

export const maxDuration = 300;

// GET /api/cron/blacklist-recheck — hourly: keep SURBL/Spamhaus verdicts
// fresh WITHOUT anyone clicking the Check buttons.
//
// Vicky 2026-08-27: "does our checker delist domains already marked
// blacklisted?" — it does (a clean re-check writes false), but nothing ever
// re-ran it: 763 of 896 'listed' verdicts were >30 days old and 1,492
// domains had never been checked. Spencer's requirements doc (§13) wants
// checks no older than 30 days.
//
// Priority per run (SURBL_BATCH domains): (1) LISTED domains with a stale
// verdict — that's where delisting shows and where money/decisions hang
// (the 77 Burnt-tagged, the SURBL-listed reserves); (2) never-checked;
// (3) oldest verdicts. Spamhaus rides along for the same rows. Inconclusive
// results (DNS error / rate limit) leave the stored value untouched.

const SURBL_BATCH = 250;
const CONCURRENT = 15;
const STALE_DAYS = 7;

interface Row { instance: string; domain: string; blacklisted: boolean | null; blacklist_checked_at: string | null }

export async function GET(request: Request) {
  try {
    const dryRun = new URL(request.url).searchParams.get("dry") === "1";
    const supabase = getSupabaseAdmin();

    const rows: Row[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, blacklisted, blacklist_checked_at")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as Row[]));
      if (data.length < 1000) break;
    }

    const now = Date.now();
    const ageDays = (ts: string | null) => (ts ? (now - new Date(ts).getTime()) / 86_400_000 : Infinity);
    const prio = (r: Row) => {
      const a = ageDays(r.blacklist_checked_at);
      if (r.blacklisted === true && a > STALE_DAYS) return 0;  // listed + stale → delisting check
      if (r.blacklisted === null || !r.blacklist_checked_at) return 1; // never checked
      if (a > 30) return 2;                                     // doc §13: ≤30d
      return 3;                                                 // fresh enough
    };

    // One check per DOMAIN name (DNS doesn't care about instance); the write
    // fans back out to every instance row of that domain.
    const byDomain = new Map<string, Row[]>();
    for (const r of rows) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
    const ordered = [...byDomain.entries()]
      .map(([domain, rs]) => ({ domain, rs, p: Math.min(...rs.map(prio)), age: Math.max(...rs.map((r) => ageDays(r.blacklist_checked_at) === Infinity ? 9999 : ageDays(r.blacklist_checked_at))) }))
      .filter((x) => x.p < 3)
      .sort((a, b) => a.p - b.p || b.age - a.age)
      .slice(0, SURBL_BATCH);

    if (dryRun) {
      const byPrio: Record<number, number> = {};
      for (const x of ordered) byPrio[x.p] = (byPrio[x.p] || 0) + 1;
      return NextResponse.json({ dryRun, wouldCheck: ordered.length, byPriority: byPrio, sample: ordered.slice(0, 8).map((x) => x.domain) });
    }

    let delisted = 0, newlyListed = 0, inconclusive = 0;
    const upserts: { instance: string; domain: string; blacklisted?: boolean; blacklist_checked_at?: string; spamhaus_dbl?: boolean; spamhaus_checked_at?: string }[] = [];
    const started = Date.now();
    for (let i = 0; i < ordered.length; i += CONCURRENT) {
      if (Date.now() - started > 240_000) break; // bank what's done; next hour continues
      const batch = ordered.slice(i, i + CONCURRENT);
      const surbl = await Promise.allSettled(batch.map((x) => checkBlacklist(x.domain)));
      const spam = await Promise.allSettled(batch.map((x) => checkSpamhausDbl(x.domain)));
      const nowIso = new Date().toISOString();
      for (let j = 0; j < batch.length; j++) {
        const x = batch[j];
        const s = surbl[j].status === "fulfilled" ? (surbl[j] as PromiseFulfilledResult<{ blacklisted: boolean | null }>).value : null;
        const p = spam[j].status === "fulfilled" ? (spam[j] as PromiseFulfilledResult<{ blacklisted: boolean | null }>).value : null;
        for (const r of x.rs) {
          const u: (typeof upserts)[number] = { instance: r.instance, domain: r.domain };
          if (s && s.blacklisted !== null) {
            u.blacklisted = s.blacklisted; u.blacklist_checked_at = nowIso;
            if (r.blacklisted === true && s.blacklisted === false) delisted++;
            if (r.blacklisted !== true && s.blacklisted === true) newlyListed++;
          } else inconclusive++;
          if (p && p.blacklisted !== null) { u.spamhaus_dbl = p.blacklisted; u.spamhaus_checked_at = nowIso; }
          if (u.blacklisted !== undefined || u.spamhaus_dbl !== undefined) upserts.push(u);
        }
      }
    }

    for (let i = 0; i < upserts.length; i += 200) {
      const { error } = await supabase
        .from("deliverability_domains")
        .upsert(upserts.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    return NextResponse.json({ checked: ordered.length, delisted, newlyListed, inconclusive, rowsWritten: upserts.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "blacklist-recheck failed" }, { status: 500 });
  }
}
