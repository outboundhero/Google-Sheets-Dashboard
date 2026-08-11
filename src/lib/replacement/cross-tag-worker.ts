// Auto wrong-client campaign cleanup (Spencer Aug-11: "make the remove from
// wrong campaign automation work properly & allow it to run automatically
// every 72 hours").
//
// A full audit + removal is far too big for one serverless invocation, so an
// HOURLY cron advances a cycle state machine held in Redis, exactly like the
// deliverability sync's cursor passes:
//   idle   → (nextCycleAt reached) snapshot the domain list, phase=audit
//   audit  → AUDIT_SLICES_PER_RUN × 50-domain chunks per run through the
//            cross-tag-audit route (handler-import, same code path as the UI)
//   remove → REMOVE_PER_RUN unique wrong campaigns per run through the
//            cross-tag-remove route; failures recorded, never re-looped forever
//   done   → clearDomains for fully-cleaned rows, Slack summary,
//            phase=idle with nextCycleAt = now + 72h
// Every handler call retries once on transient failure. Kill switch:
// CROSS_TAG_AUTO_DISABLED=1 makes every run a no-op.
import { Redis } from "@upstash/redis";
import { postSlackMessage } from "@/lib/slack";

const CYCLE_HOURS = 72;
const AUDIT_CHUNK = 50;          // domains per audit call (matches the UI)
const AUDIT_SLICES_PER_RUN = 4;  // 200 domains per hourly run
const REMOVE_PER_RUN = 12;       // unique campaigns per hourly run (one route call)

const STATE_KEY = "cron:crosstag:state";

const SLACK_CHANNEL =
  process.env.SLACK_OUTBOUND_CHANNEL_ID ||
  process.env.SLACK_LEAD_SYNC_CHANNEL_ID ||
  undefined;

interface DomainRef { instance: string; domain: string }
interface WrongCampaign { id: number; name: string; status: string; clientTag: string; instance: string }
interface FlaggedDomain { instance: string; domain: string; clientTag: string; wrongCampaigns: WrongCampaign[] }

interface CycleState {
  phase: "idle" | "audit" | "remove";
  cycleStartedAt: string;
  nextCycleAt: string;
  domains: DomainRef[];
  cursor: number;
  flaggedFound: number;
  auditFailedChunks: number;
  processedCampaignKeys: string[];
  failedCampaignKeys: string[];
  removedTotal: number;
  failedCampaignNames: string[];
}

const idleState = (nextCycleAt: string): CycleState => ({
  phase: "idle", cycleStartedAt: "", nextCycleAt, domains: [], cursor: 0,
  flaggedFound: 0, auditFailedChunks: 0, processedCampaignKeys: [], failedCampaignKeys: [],
  removedTotal: 0, failedCampaignNames: [],
});

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function callHandler(
  handler: (req: Request) => Promise<Response>,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await handler(new Request(url, init));
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && data && !data.error) return { ok: true, data };
      if (res.status < 500) return { ok: false, data };
    } catch { /* transient — retry once */ }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 5000));
  }
  return { ok: false, data: null };
}

export interface WorkerResult {
  disabled?: boolean;
  phase: string;
  note: string;
  cursor?: number;
  total?: number;
  flaggedFound?: number;
  campaignsDone?: number;
  campaignsFailed?: number;
}

export async function runCrossTagCycle(opts: { force?: boolean } = {}): Promise<WorkerResult> {
  if (process.env.CROSS_TAG_AUTO_DISABLED === "1") {
    return { disabled: true, phase: "disabled", note: "CROSS_TAG_AUTO_DISABLED=1" };
  }
  const redis = getRedis();
  if (!redis) return { phase: "error", note: "Redis not configured — cycle state unavailable" };

  const raw = await redis.get<CycleState>(STATE_KEY);
  let state: CycleState = raw && typeof raw === "object" ? raw : idleState(new Date(0).toISOString());
  const save = () => redis.set(STATE_KEY, state);

  const { GET: auditGET, POST: auditPOST } = await import("@/app/api/replacement/cross-tag-audit/route");
  const { POST: removePOST } = await import("@/app/api/replacement/cross-tag-remove/route");

  // ── idle: wait out the 72h, then snapshot the domain list and start ──
  if (state.phase === "idle") {
    if (!opts.force && new Date(state.nextCycleAt).getTime() > Date.now()) {
      return { phase: "idle", note: `next cycle at ${state.nextCycleAt}` };
    }
    const list = await callHandler(auditGET, "http://internal/api/replacement/cross-tag-audit?list=domains");
    const domains = ((list.data?.domains as DomainRef[] | undefined) || []);
    if (!list.ok || domains.length === 0) {
      return { phase: "idle", note: "could not load domain list — will retry next hour" };
    }
    state = { ...idleState(state.nextCycleAt), phase: "audit", cycleStartedAt: new Date().toISOString(), domains, cursor: 0 };
    await save();
    // fall through and do the first audit slices in this same run
  }

  // ── audit: advance the cursor a bounded number of chunks ──
  if (state.phase === "audit") {
    for (let s = 0; s < AUDIT_SLICES_PER_RUN && state.cursor < state.domains.length; s++) {
      const chunk = state.domains.slice(state.cursor, state.cursor + AUDIT_CHUNK);
      const r = await callHandler(auditPOST, "http://internal/api/replacement/cross-tag-audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: chunk, reset: state.cursor === 0 }),
      });
      if (r.ok) state.flaggedFound += Number(r.data?.flaggedCount) || 0;
      else state.auditFailedChunks++;
      state.cursor += chunk.length;
      await save();
    }
    if (state.cursor >= state.domains.length) {
      state.phase = "remove";
      state.domains = [];   // snapshot no longer needed — keep the state small
      await save();
    }
    return {
      phase: state.phase, cursor: state.cursor, total: state.domains.length || undefined,
      flaggedFound: state.flaggedFound,
      note: state.phase === "audit" ? "audit in progress" : "audit complete — removal starts next run",
    };
  }

  // ── remove: work through the unique wrong campaigns, a batch per run ──
  const flaggedRes = await callHandler(auditGET, "http://internal/api/replacement/cross-tag-audit");
  const flagged = ((flaggedRes.data?.flagged as FlaggedDomain[] | undefined) || []);
  const jobMap = new Map<string, { instance: string; id: number; name: string; status: string; domains: string[] }>();
  for (const f of flagged) {
    for (const c of f.wrongCampaigns) {
      const k = `${f.instance}:${c.id}`;
      let j = jobMap.get(k);
      if (!j) { j = { instance: f.instance, id: c.id, name: c.name, status: c.status, domains: [] }; jobMap.set(k, j); }
      j.domains.push(f.domain);
    }
  }
  const done = new Set(state.processedCampaignKeys);
  const remaining = [...jobMap.entries()].filter(([k]) => !done.has(k)).sort((a, b) => a[0].localeCompare(b[0]));

  if (remaining.length > 0) {
    const batch = remaining.slice(0, REMOVE_PER_RUN);
    const r = await callHandler(removePOST, "http://internal/api/replacement/cross-tag-remove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaigns: batch.map(([, j]) => j) }),
    });
    if (r.ok) {
      state.removedTotal += Number(r.data?.removed) || 0;
      const results = (r.data?.results as { instance: string; campaignId: number; name: string; ok: boolean; error?: string }[] | undefined) || [];
      for (const res of results) {
        const k = `${res.instance}:${res.campaignId}`;
        state.processedCampaignKeys.push(k);
        if (!res.ok) { state.failedCampaignKeys.push(k); state.failedCampaignNames.push(res.name); }
      }
      // campaigns the route didn't report on still count as processed-but-failed
      for (const [k, j] of batch) {
        if (!state.processedCampaignKeys.includes(k)) {
          state.processedCampaignKeys.push(k); state.failedCampaignKeys.push(k); state.failedCampaignNames.push(j.name);
        }
      }
    } else {
      // whole batch failed even after retry — mark failed so the cycle can end
      for (const [k, j] of batch) {
        state.processedCampaignKeys.push(k); state.failedCampaignKeys.push(k); state.failedCampaignNames.push(j.name);
      }
    }
    await save();
    if (state.processedCampaignKeys.length < jobMap.size) {
      return {
        phase: "remove", campaignsDone: state.processedCampaignKeys.length, total: jobMap.size,
        campaignsFailed: state.failedCampaignKeys.length, note: "removal in progress",
      };
    }
  }

  // ── cycle complete: clear fully-cleaned domains, Slack summary, go idle ──
  const failedSet = new Set(state.failedCampaignKeys);
  const cleaned = flagged.filter((f) => f.wrongCampaigns.every((c) => !failedSet.has(`${f.instance}:${c.id}`)));
  for (let i = 0; i < cleaned.length; i += 500) {
    await callHandler(removePOST, "http://internal/api/replacement/cross-tag-remove", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clearDomains", domains: cleaned.slice(i, i + 500).map((f) => ({ instance: f.instance, domain: f.domain })) }),
    });
  }
  const summary =
    `🧹 Auto wrong-campaign cleanup finished (cycle started ${state.cycleStartedAt.slice(0, 16)}Z): ` +
    `*${state.flaggedFound}* domains flagged · *${jobMap.size}* campaigns cleaned · ` +
    `*${state.removedTotal.toLocaleString()}* inbox removals queued · ${cleaned.length} domains cleared` +
    (state.failedCampaignKeys.length ? ` · ⚠️ ${state.failedCampaignKeys.length} campaigns failed (${state.failedCampaignNames.slice(0, 5).join(", ")}${state.failedCampaignNames.length > 5 ? "…" : ""}) — still flagged on the dashboard` : "") +
    (state.auditFailedChunks ? ` · ${state.auditFailedChunks} audit chunks failed` : "") +
    `. Next cycle in ${CYCLE_HOURS}h.`;
  await postSlackMessage(summary, SLACK_CHANNEL).catch(() => {});

  const res: WorkerResult = {
    phase: "idle",
    campaignsDone: jobMap.size,
    campaignsFailed: state.failedCampaignKeys.length,
    flaggedFound: state.flaggedFound,
    note: `cycle complete — ${cleaned.length} domains cleared`,
  };
  state = idleState(new Date(Date.now() + CYCLE_HOURS * 3600_000).toISOString());
  await save();
  return res;
}

/** Current cycle state, for dry inspection. */
export async function getCrossTagCycleState(): Promise<CycleState | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<CycleState>(STATE_KEY);
  return raw && typeof raw === "object" ? raw : null;
}
