// Shared by the onboarding endpoints' RUN paths (/api/external/onboarding-*).
// The dry runs only read; a run tags domains, changes redirects or emails a
// client, so it gets two things the read feeds don't have: its own secret, and
// a lock so two runs can never work on the same thing at once.
import { timingSafeEqual } from "crypto";
import { Redis } from "@upstash/redis";

/**
 * Why this request may not RUN, or null when it may.
 *
 * Runs are refused unless ONBOARDING_RUN_SECRET is set (at least 24
 * characters) and the caller sends the same value in x-onboarding-run-secret.
 * There is deliberately no fallback: the feed token (EXTERNAL_API_TOKEN) has
 * one, sits in both repos, and is shared with read-only feeds — it must never
 * be enough to move domains or email a client.
 */
export function runSecretProblem(request: Request): string | null {
  const secret = (process.env.ONBOARDING_RUN_SECRET || "").trim();
  if (secret.length < 24) return "runs are switched off: ONBOARDING_RUN_SECRET is not set";
  const given = Buffer.from(request.headers.get("x-onboarding-run-secret") || "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return "the run secret is missing or wrong";
  return null;
}

function redisOrNull(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export type Locked<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Run `fn` while holding a named lock. If the lock is taken — or there is no
 * Redis to hold one in — `fn` is NOT run and the reason comes back: a run that
 * can't be made exclusive doesn't happen. The lock expires on its own after
 * `ttlSeconds` (longer than the function can live), so a crashed run can't
 * block for good, and it is only released by whoever took it.
 */
export async function withLock<T>(name: string, holder: string, ttlSeconds: number, fn: () => Promise<T>): Promise<Locked<T>> {
  const redis = redisOrNull();
  if (!redis) return { ok: false, reason: "no lock store is configured (Redis), so the run can't be made exclusive" };
  const key = `onboarding-lock:${name}`;
  const token = `${holder}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let got: unknown;
  try {
    got = await redis.set(key, token, { nx: true, ex: ttlSeconds });
  } catch (e) {
    return { ok: false, reason: `the lock store didn't answer (${e instanceof Error ? e.message : "error"})` };
  }
  if (got !== "OK") {
    const current = await redis.get<string>(key).catch(() => null);
    return { ok: false, reason: `another run is working on ${name} right now${current ? ` (${String(current).split(":")[0]})` : ""} — try again when it has finished` };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    // Only our own lock: after the expiry someone else may hold the key.
    const current = await redis.get<string>(key).catch(() => null);
    if (current === token) await redis.del(key).catch(() => undefined);
  }
}

// ── Live progress of an onboarding batch ─────────────────────────────────────
// Reply Router's checklist shows what a batch is doing while it runs — the
// runner's steps (tag, redirect, each campaign, the sheet, the whitelist
// queue), then the checks and the daily limit — so whoever pressed Run can see
// it working. Best-effort: a write that fails is skipped, and nothing in the
// run waits on or depends on it. Kept an hour after the batch.

export interface BatchProgress {
  clientTag: string;
  instance: string;
  domains: string[];
  startedAt: string;
  updatedAt: string;
  /** running = the runner's steps; checking = the checks and daily limit after them; then done, or problems. */
  phase: "running" | "checking" | "done" | "problems";
  steps: { label: string; state: string; note?: string }[];
  problems?: string[];
}

const progressKey = (clientTag: string) => `onboarding-progress:${clientTag}`;

/** A writer for one batch's progress: update() never throws or waits; flush() waits for the writes queued so far. */
export function batchProgress(base: { clientTag: string; instance: string; domains: string[] }): {
  update: (patch: Partial<Pick<BatchProgress, "phase" | "steps" | "problems">>) => void;
  flush: () => Promise<void>;
} {
  const redis = redisOrNull();
  let current: BatchProgress = { ...base, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "running", steps: [] };
  // One write at a time, in order — a slow early write must not land after a later one.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    update(patch) {
      current = { ...current, ...patch, updatedAt: new Date().toISOString() };
      if (!redis) return;
      const snapshot = current;
      chain = chain.then(() => redis.set(progressKey(base.clientTag), snapshot, { ex: 3600 })).catch(() => undefined);
    },
    // Never more than 3 s: a slow store must not hold up the run's answer.
    flush: () => Promise.race([chain.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, 3000))]),
  };
}

export async function getBatchProgress(clientTag: string): Promise<BatchProgress | null> {
  const redis = redisOrNull();
  if (!redis) return null;
  try {
    const raw = await redis.get<unknown>(progressKey(clientTag));
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as BatchProgress | null;
  } catch {
    return null;
  }
}
