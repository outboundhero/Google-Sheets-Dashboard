import type {
  CreateOrderInput,
  ProviderStatusResult,
} from "@/types/inbox-order";

// Read-only Inboxing calls (GET, redirect PATCH, DELETE, etc) only need the
// API key + base URL. The registrar + cloudflare credential IDs are used
// exclusively by createDomain(). Splitting these lets the provider-status
// cron work even on environments where the create-time credentials weren't
// configured (which was the root cause of ~2842/2902 rows failing on the
// first cron run — env() throwing before the API was ever hit).
function envRead() {
  const key = process.env.INBOXING_API_KEY;
  const base = process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2";
  if (!key) {
    throw new Error("Inboxing env missing (INBOXING_API_KEY)");
  }
  return { key, base };
}

function env() {
  const readEnv = envRead();
  const registrarId = process.env.INBOXING_REGISTRAR_CREDENTIAL_ID;
  const cloudflareId = process.env.INBOXING_CLOUDFLARE_CREDENTIAL_ID;
  if (!registrarId || !cloudflareId) {
    throw new Error(
      "Inboxing env missing (INBOXING_REGISTRAR_CREDENTIAL_ID / INBOXING_CLOUDFLARE_CREDENTIAL_ID)"
    );
  }
  return { ...readEnv, registrarId, cloudflareId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry-aware transport. Inboxing rate-limits aggressively on the search
// endpoint; a bulk provider-status pass without retry gets ~98% of requests
// 429'd. We honor Retry-After when present, otherwise back off exponentially
// with jitter, up to 5 attempts on 429 / 5xx. Non-retryable statuses (400,
// 401, 403, 404) return immediately.
async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  // Bulk-write ops set patient=true: Inboxing's rate window is per-minute,
  // and the default exponential backoff (caps at 15s) can burn every attempt
  // inside one throttled window. Patient mode waits 15s, 25s, 35s… instead.
  patient = false
): Promise<T> {
  const { key, base } = envRead();
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      "X-API-Key": key,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const MAX_ATTEMPTS = patient ? 6 : 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
    }
    if (res.ok) return (parsed ?? {}) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(ra) && ra > 0
        ? ra * 1000 + 500
        : patient
          ? 15_000 + attempt * 10_000
          : Math.min(15_000, 800 * 2 ** attempt);
      await sleep(waitMs + Math.floor(Math.random() * 400));
      continue;
    }
    const msg =
      (parsed && typeof parsed === "object" && (parsed as { error?: string }).error) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new Error(`Inboxing ${method} ${path}: ${msg}`);
  }
  throw new Error(`Inboxing ${method} ${path}: exhausted retries`);
}

interface InboxingDomain {
  id: string;
  domain: string;
  status: string;
  mailbox_count?: number;
  nameservers?: string[];
  created_at?: string;
}

export interface InboxingCreateOrderResult {
  domainId: string;
  raw: InboxingDomain;
}

export async function createDomain(input: CreateOrderInput): Promise<InboxingCreateOrderResult> {
  const { registrarId, cloudflareId } = env();
  const namesMap = new Map<string, { first_name: string; last_name: string; email_prefix?: string }>();
  for (const a of input.aliases) {
    const k = a.alias.toLowerCase();
    if (!namesMap.has(k)) {
      namesMap.set(k, {
        first_name: a.first_name,
        last_name: a.last_name,
        email_prefix: a.alias,
      });
    }
  }
  // Inboxing allows max 99 names per /domains request — cap defensively.
  const names = Array.from(namesMap.values()).slice(0, 99);
  const body = {
    domain: input.domain,
    names,
    user_count: 49,
    ...(input.redirectUrl
      ? { redirect_url: input.redirectUrl, redirect_type: "REGULAR" as const }
      : {}),
    cloudflare_credential_id: cloudflareId,
    registrar_credential_id: registrarId,
  };
  const result = await call<InboxingDomain>("POST", "/domains", body);
  if (!result.id) {
    throw new Error("Inboxing createDomain: response missing id");
  }
  return { domainId: result.id, raw: result };
}

interface InboxingStatus {
  id: string;
  domain: string;
  status: string;
  setup_stage?: string;
  failure_reason?: string;
  csv_available?: boolean;
  latest_job?: {
    status?: string;
  };
}

function deriveStatus(raw: InboxingStatus | null): ProviderStatusResult {
  if (!raw) return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
  const norm = (raw.status || "").toLowerCase();
  const stage = raw.setup_stage || null;
  if (norm === "active") {
    return { status: "active", rawStatus: norm, setupStage: stage, failureReason: null, completed: true };
  }
  if (norm === "failed") {
    return {
      status: "failed",
      rawStatus: norm,
      setupStage: stage,
      failureReason: raw.failure_reason || null,
      completed: true,
    };
  }
  if (norm === "deleting" || norm === "deleted") {
    return { status: norm === "deleted" ? "deleted" : "deleting", rawStatus: norm, setupStage: stage, failureReason: null, completed: norm === "deleted" };
  }
  return { status: "pending", rawStatus: norm, setupStage: stage, failureReason: null, completed: false };
}

export async function getDomainStatus(domainId: string): Promise<ProviderStatusResult> {
  const result = await call<InboxingStatus>("GET", `/domains/${encodeURIComponent(domainId)}/status`);
  return deriveStatus(result);
}

/** Raw Inboxing status incl. the latest upload job — for move diagnostics. */
export async function getDomainStatusRaw(
  domainId: string,
): Promise<{ status: string; setupStage: string | null; failureReason: string | null; latestJobStatus: string | null; csvAvailable: boolean | null }> {
  const r = await call<InboxingStatus>("GET", `/domains/${encodeURIComponent(domainId)}/status`);
  return {
    status: (r?.status || "").toLowerCase(),
    setupStage: r?.setup_stage || null,
    failureReason: r?.failure_reason || null,
    latestJobStatus: r?.latest_job?.status || null,
    csvAvailable: typeof r?.csv_available === "boolean" ? r.csv_available : null,
  };
}

export async function updateRedirect(domainId: string, redirectUrl: string | null): Promise<void> {
  const body = redirectUrl
    ? { redirect_type: "REGULAR" as const, redirect_url: redirectUrl }
    : { redirect_type: "NONE" as const };
  await call("PUT", `/domains/${encodeURIComponent(domainId)}/redirect`, body);
}

/**
 * Look up a domain on Inboxing by name. Uses GET /domains?search=<name>
 * (paginated). Returns the matched domain or null. Used by the bulk
 * change-redirect route to resolve a domain name → UUID when we don't have
 * a cached inbox_orders.provider_domain_id (the PUT redirect endpoint only
 * accepts the UUID, unlike GET which accepts UUID or name).
 */
export async function findDomainByName(
  name: string,
): Promise<{ id: string; domain: string } | null> {
  const target = name.toLowerCase();
  const result = await call<{
    data?: Array<{ id: string; domain: string }>;
  }>("GET", `/domains?search=${encodeURIComponent(name)}&per_page=50`);
  for (const d of result.data || []) {
    if ((d.domain || "").toLowerCase() === target) {
      return { id: String(d.id), domain: d.domain };
    }
  }
  return null;
}

export interface InboxingListedDomainWithLifecycle {
  id: string;
  name: string;
  /** Raw status string from the API — "active" | "failed" | "deleting" | "deleted" | "pending" | ... */
  status: string;
}

/**
 * List every domain visible to this API key on Inboxing, paginating through
 * all pages. Each row carries the raw lifecycle `status` field which lets
 * the provider-status cron determine active vs canceled without a per-domain
 * GET /domains/{id}/status call. Mirrors milkbox.listDomainsWithLifecycle().
 *
 * Trades 2 × N per-domain calls (findDomainByName + getDomainStatus) for
 * ~ceil(N / per_page) paginated list calls. On our fleet that's ~60 calls
 * instead of ~5800 — well within Inboxing's rate ceiling with the retry
 * helper doing its job on the occasional 429.
 */
export async function listDomainsWithLifecycle(): Promise<InboxingListedDomainWithLifecycle[]> {
  const out: InboxingListedDomainWithLifecycle[] = [];
  const perPage = 100;
  for (let page = 1; page < 500; page++) {
    const result = await call<{
      data?: Array<{ id: string | number; domain: string; status?: string }>;
    }>("GET", `/domains?per_page=${perPage}&page=${page}`);
    const rows = result.data || [];
    for (const d of rows) {
      if (d?.id === undefined || !d?.domain) continue;
      out.push({
        id: String(d.id),
        name: d.domain,
        status: typeof d.status === "string" ? d.status : "",
      });
    }
    // Terminate when the page returns fewer than per_page rows (or empty).
    if (rows.length < perPage) break;
  }
  return out;
}

export async function deleteDomain(domainId: string): Promise<void> {
  await call("DELETE", `/domains/${encodeURIComponent(domainId)}`);
}

export interface InboxingSlots {
  remaining: number;
  total: number;
  used: number;
  canProvision: number;
}

export async function getSlots(): Promise<InboxingSlots> {
  const result = await call<{
    slots: { total: number; used: number; remaining: number };
    system: { can_provision: number };
  }>("GET", "/slots");
  return {
    total: result.slots.total,
    used: result.slots.used,
    remaining: result.slots.remaining,
    canProvision: result.system.can_provision,
  };
}

// ── Tag sync + platform upload (move-domains workflow) ─────────────────────

/** Inboxing caps a domain at 10 tags (PUT /domains/{id}/tags rejects more). */
export const INBOXING_MAX_TAGS = 10;

/** Replace ALL tags on an Inboxing domain (PUT /domains/{id}/tags). */
export async function setDomainTags(domainId: string, tags: string[]): Promise<void> {
  if (tags.length > INBOXING_MAX_TAGS) {
    throw new Error(`Inboxing caps tags at ${INBOXING_MAX_TAGS} per domain (got ${tags.length})`);
  }
  await call("PUT", `/domains/${encodeURIComponent(domainId)}/tags`, { tags }, true);
}

export interface InboxingPlatformConnection {
  id: string;
  name: string;
  /** e.g. "emailbison", "instantly", "smartlead", "plusvibe" */
  platform: string;
  verificationStatus: string;
  verificationError: string | null;
}

/** All configured sequencer connections (GET /platform-connections). */
export async function listPlatformConnections(): Promise<InboxingPlatformConnection[]> {
  const result = await call<{
    data?: Array<{
      id: string;
      name?: string;
      platform?: string;
      verification_status?: string;
      verification_error?: string | null;
    }>;
  }>("GET", "/platform-connections");
  return (result.data || []).map((c) => ({
    id: String(c.id),
    name: c.name || "",
    platform: (c.platform || "").toLowerCase(),
    verificationStatus: (c.verification_status || "").toLowerCase(),
    verificationError: c.verification_error ?? null,
  }));
}

export interface InboxingUploadResult {
  jobsCreated: number;
  connectionName: string;
  message: string;
}

/**
 * Upload a domain's mailboxes to a sequencer platform connection
 * (POST /domains/{id}/upload). ASYNC on Inboxing's side: one upload job per
 * mailbox, returns immediately with the job count — the accounts appear on
 * the platform as workers process the jobs. skip_verified makes re-runs
 * idempotent (already-uploaded emails on this connection are skipped);
 * sync_tags pushes the Inboxing domain tags onto the uploaded accounts.
 */
export async function uploadDomainToPlatform(
  domainId: string,
  platformConnectionId: string,
): Promise<InboxingUploadResult> {
  const result = await call<{
    success?: boolean;
    jobs_created?: number;
    connection_name?: string;
    message?: string;
  }>("POST", `/domains/${encodeURIComponent(domainId)}/upload`, {
    platform_connection_id: platformConnectionId,
    enable_warmup: true,
    skip_verified: true,
    sync_tags: true,
  }, true);
  return {
    jobsCreated: result.jobs_created ?? 0,
    connectionName: result.connection_name || "",
    message: result.message || "",
  };
}
