// Bison reads/writes used by Turbo + throttle. A client's accounts are the
// senders carrying the client's tag — `GET /sender-emails?tag_ids[]=<id>`
// filters server-side (verified 2026-10-02: JPPH on facilityreach → 988 of
// 60,157 senders), so we never walk the whole instance.
//
// The sender list does NOT carry the warm-up limit (only daily_limit +
// warmup_enabled); it comes from `GET /warmup/sender-emails` with the same
// tag filter. deliverability_inboxes.warmup_daily_limit is null fleet-wide for
// the same reason, so the snapshot always reads Bison, never the mirror.
import { bisonFetch } from "@/lib/bison";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAGE_PACE_MS = 120;

export interface ClientSender {
  instance: BisonInstanceSlug;
  id: number;
  email: string;
  domain: string;
  status: string;
  dailyLimit: number;
  warmupEnabled: boolean;
  emailsSent: number;
}

interface BisonTag { id: number; name: string }

/** Tag id for `name` on each instance that has it (case-insensitive). */
export async function resolveClientTagIds(name: string): Promise<Map<BisonInstanceSlug, number>> {
  const want = name.trim().toLowerCase();
  const out = new Map<BisonInstanceSlug, number>();
  await Promise.all(
    ALL_INSTANCE_SLUGS.map(async (instance) => {
      try {
        const res = await bisonFetch(instance, `/tags`);
        if (!res.ok) return;
        const json = await res.json();
        const hit = ((json?.data || []) as BisonTag[]).find((t) => t?.name?.trim().toLowerCase() === want);
        if (hit) out.set(instance, hit.id);
      } catch {
        // an instance that can't be reached simply contributes no accounts
      }
    }),
  );
  return out;
}

async function walkCursor<T>(instance: BisonInstanceSlug, basePath: string): Promise<T[]> {
  const sep = basePath.includes("?") ? "&" : "?";
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 2000; page++) {
    const qs = cursor ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}` : "pagination_type=cursor";
    const res = await bisonFetch(instance, `${basePath}${sep}${qs}`);
    if (!res.ok) throw new Error(`Bison ${instance} ${res.status} on ${basePath.split("?")[0]}`);
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    rows.push(...((payload?.data || []) as T[]));
    cursor = payload?.meta?.next_cursor ?? null;
    if (!cursor) break;
    await delay(PAGE_PACE_MS);
  }
  return rows;
}

const looksDisconnected = (status: string) =>
  /disconnect|reconnection|login failed|auth failed/i.test(status);

/** Every sender tagged `tagId` on `instance`, disconnected ones left out —
 *  nothing to gain from changing limits on an account that can't send. */
export async function listClientSenders(instance: BisonInstanceSlug, tagId: number): Promise<ClientSender[]> {
  const raw = await walkCursor<{
    id: number; email: string; status: string; daily_limit: number;
    warmup_enabled: boolean; emails_sent_count: number;
  }>(instance, `/sender-emails?tag_ids[]=${tagId}`);
  return raw
    .filter((s) => !looksDisconnected(String(s.status || "")))
    .map((s) => ({
      instance,
      id: s.id,
      email: s.email,
      domain: String(s.email || "").split("@")[1]?.toLowerCase() ?? "",
      status: String(s.status || ""),
      dailyLimit: Number(s.daily_limit ?? 0),
      warmupEnabled: Boolean(s.warmup_enabled),
      emailsSent: Number(s.emails_sent_count ?? 0),
    }));
}

/** sender id → warm-up daily limit for every sender tagged `tagId`. */
export async function listClientWarmupLimits(instance: BisonInstanceSlug, tagId: number): Promise<Map<number, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await walkCursor<{ id: number; warmup_daily_limit?: number }>(
    instance,
    `/warmup/sender-emails?start_date=${today}&end_date=${today}&tag_ids[]=${tagId}`,
  );
  const out = new Map<number, number>();
  for (const r of raw) if (typeof r.warmup_daily_limit === "number") out.set(r.id, r.warmup_daily_limit);
  return out;
}

export type LimitKind = "daily" | "warmup";

const ENDPOINT: Record<LimitKind, string> = {
  daily: `/sender-emails/daily-limits/bulk`,
  warmup: `/warmup/sender-emails/update-daily-warmup-limits`,
};

/** Set one limit on a set of senders. Batched 50, with the same 422
 *  sub-batch → single-id fallback the manual Daily Limit button uses, so one
 *  dead id doesn't fail the batch. Returns the ids that did NOT take it. */
export async function setLimit(
  instance: BisonInstanceSlug,
  kind: LimitKind,
  ids: number[],
  limit: number,
): Promise<{ ok: number[]; failed: number[] }> {
  const ok: number[] = [];
  const failed: number[] = [];
  const patch = async (batch: number[]) => {
    const res = await bisonFetch(instance, ENDPOINT[kind], {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_email_ids: batch, daily_limit: limit }),
    });
    return res.status;
  };
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const status = await patch(batch);
      if (status >= 200 && status < 300) { ok.push(...batch); }
      else if (status === 422) {
        for (let j = 0; j < batch.length; j += 10) {
          const sub = batch.slice(j, j + 10);
          const s2 = await patch(sub).catch(() => 0);
          if (s2 >= 200 && s2 < 300) { ok.push(...sub); continue; }
          for (const id of sub) {
            const s3 = await patch([id]).catch(() => 0);
            (s3 >= 200 && s3 < 300 ? ok : failed).push(id);
          }
          await delay(150);
        }
      } else failed.push(...batch);
    } catch {
      failed.push(...batch);
    }
    if (i + 50 < ids.length) await delay(250);
  }
  return { ok, failed };
}
