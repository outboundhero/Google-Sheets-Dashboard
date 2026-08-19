import type {
  CreateOrderInput,
  ProviderStatusResult,
} from "@/types/inbox-order";
import {
  DEFAULT_INBOXING_ACCOUNT, INBOXING_ACCOUNT_ORDER, inboxingAccountConfigured, inboxingAuth,
  inboxingCloudflareCredential, inboxingRedirectType, type InboxingAccount,
} from "@/lib/inboxing-accounts";
import { asciiName } from "@/lib/inbox-order-aliases";

/** Accounts usable right now, default (legacy) account first. */
export function configuredInboxingAccounts(): InboxingAccount[] {
  return INBOXING_ACCOUNT_ORDER.slice()
    .sort((a, b) => Number(b === DEFAULT_INBOXING_ACCOUNT) - Number(a === DEFAULT_INBOXING_ACCOUNT))
    .filter(inboxingAccountConfigured);
}

// Read-only Inboxing calls (GET, redirect PATCH, DELETE, etc) only need the
// API key + base URL. The registrar + cloudflare credential IDs are used
// exclusively by createDomain(). Splitting these lets the provider-status
// cron work even on environments where the create-time credentials weren't
// configured (which was the root cause of ~2842/2902 rows failing on the
// first cron run — env() throwing before the API was ever hit).
function envRead(account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT) {
  return inboxingAuth(account);
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
  patient = false,
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT
): Promise<T> {
  const { key, base } = envRead(account);
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
  /** Account the domain actually lives on — differs from the requested one when adopted. */
  account?: InboxingAccount;
  /** True when Inboxing already held this domain and we adopted it instead of creating. */
  reused?: boolean;
}

export async function createDomain(
  input: CreateOrderInput,
  credentials?: { registrarCredentialId?: string | null; cloudflareCredentialId?: string | null },
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
): Promise<InboxingCreateOrderResult> {
  // Credentials are resolved per-domain (from the domain's Porkbun account) by
  // the caller; fall back to the legacy env vars if not supplied.
  const registrarId =
    credentials?.registrarCredentialId ||
    // Legacy single-registrar env — only valid for the account it belongs to.
    (account === DEFAULT_INBOXING_ACCOUNT ? process.env.INBOXING_REGISTRAR_CREDENTIAL_ID : undefined);
  const cloudflareId = credentials?.cloudflareCredentialId || inboxingCloudflareCredential(account);
  if (!registrarId || !cloudflareId) {
    throw new Error("Inboxing createDomain: missing registrar/cloudflare credential for this domain's Porkbun account");
  }
  const namesMap = new Map<string, { first_name: string; last_name: string; email_prefix?: string }>();
  for (const a of input.aliases) {
    const k = a.alias.toLowerCase();
    if (!namesMap.has(k)) {
      // Inboxing 400s the whole order on a non-letter in a sender name ("Only
      // letters numbers allowed"), so fold here too — the preview dialog can
      // hand us names an operator typed, which skip the generator's cleanup.
      namesMap.set(k, {
        first_name: asciiName(a.first_name) || a.first_name,
        last_name: asciiName(a.last_name) || a.last_name,
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
    // Spencer 2026-08-12: Cloudflare Domain Masking is the default on BOTH
    // accounts; jan-pro.com destinations stay a plain redirect.
    ...(input.redirectUrl
      ? { redirect_url: input.redirectUrl, redirect_type: inboxingRedirectType(input.redirectUrl) }
      : { redirect_type: "NONE" as const }),
    cloudflare_credential_id: cloudflareId,
    registrar_credential_id: registrarId,
  };
  let result: InboxingDomain;
  try {
    result = await call<InboxingDomain>("POST", "/domains", body, false, account);
  } catch (e) {
    // "Domain already exists" means Inboxing IS holding this domain — from an
    // earlier attempt in the same batch, or on the other login. Failing the row
    // just made an operator re-order it by hand (Nick Aug-13), so adopt the
    // existing record instead. Any other 4xx still fails loudly.
    if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
    const hit = await findDomainAnyAccount(input.domain);
    if (!hit) throw e;
    return {
      domainId: hit.id,
      account: hit.account,
      reused: true,
      raw: { id: hit.id, domain: hit.domain, status: "existing" },
    };
  }
  if (!result.id) {
    throw new Error("Inboxing createDomain: response missing id");
  }
  return { domainId: result.id, account, raw: result };
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

export async function getDomainStatus(domainId: string, account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): Promise<ProviderStatusResult> {
  const result = await call<InboxingStatus>("GET", `/domains/${encodeURIComponent(domainId)}/status`, undefined, false, account);
  return deriveStatus(result);
}

/** Raw Inboxing status incl. the latest upload job — for move diagnostics. */
export async function getDomainStatusRaw(
  domainId: string,
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
): Promise<{ status: string; setupStage: string | null; failureReason: string | null; latestJobStatus: string | null; csvAvailable: boolean | null }> {
  const r = await call<InboxingStatus>("GET", `/domains/${encodeURIComponent(domainId)}/status`, undefined, false, account);
  return {
    status: (r?.status || "").toLowerCase(),
    setupStage: r?.setup_stage || null,
    failureReason: r?.failure_reason || null,
    latestJobStatus: r?.latest_job?.status || null,
    csvAvailable: typeof r?.csv_available === "boolean" ? r.csv_available : null,
  };
}

export async function updateRedirect(
  domainId: string,
  redirectUrl: string | null,
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
  /** false → force a plain redirect. Cannot force masking ON: a destination
   *  that can't be framed (JAN-PRO) stays REGULAR whatever the caller asks. */
  mask = true,
): Promise<void> {
  const autoType = inboxingRedirectType(redirectUrl);
  const type = mask ? autoType : autoType === "MASKED" ? "REGULAR" : autoType;
  const body = redirectUrl
    ? { redirect_type: type, redirect_url: redirectUrl }
    : { redirect_type: "NONE" as const };
  await call("PUT", `/domains/${encodeURIComponent(domainId)}/redirect`, body, false, account);
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
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
): Promise<{ id: string; domain: string } | null> {
  const target = name.toLowerCase();
  const result = await call<{
    data?: Array<{ id: string; domain: string }>;
  }>("GET", `/domains?search=${encodeURIComponent(name)}&per_page=50`, undefined, false, account);
  for (const d of result.data || []) {
    if ((d.domain || "").toLowerCase() === target) {
      return { id: String(d.id), domain: d.domain };
    }
  }
  return null;
}

/**
 * Same lookup, but across every Inboxing account that has a key configured
 * (default account first). Domain-level callers — bulk change-redirect,
 * fix-na-redirects, the replacement move flow — only know a domain NAME, and
 * since Aug 2026 that domain may live on either login. Searching one account
 * would make every Regular-Tenants domain look like it doesn't exist.
 */
export async function findDomainAnyAccount(
  name: string,
): Promise<{ id: string; domain: string; account: InboxingAccount } | null> {
  for (const account of configuredInboxingAccounts()) {
    try {
      const hit = await findDomainByName(name, account);
      if (hit) return { ...hit, account };
    } catch {
      // key missing / account down — try the next one
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
export async function listDomainsWithLifecycle(account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): Promise<InboxingListedDomainWithLifecycle[]> {
  const out: InboxingListedDomainWithLifecycle[] = [];
  const perPage = 100;
  for (let page = 1; page < 500; page++) {
    const result = await call<{
      data?: Array<{ id: string | number; domain: string; status?: string }>;
    }>("GET", `/domains?per_page=${perPage}&page=${page}`, undefined, false, account);
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

export async function deleteDomain(domainId: string, account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): Promise<void> {
  await call("DELETE", `/domains/${encodeURIComponent(domainId)}`, undefined, false, account);
}

export interface InboxingSlots {
  remaining: number;
  total: number;
  used: number;
  canProvision: number;
}

export async function getSlots(account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): Promise<InboxingSlots> {
  const result = await call<{
    slots: { total: number; used: number; remaining: number };
    system: { can_provision: number };
  }>("GET", "/slots", undefined, false, account);
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
export async function setDomainTags(domainId: string, tags: string[], account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT): Promise<void> {
  if (tags.length > INBOXING_MAX_TAGS) {
    throw new Error(`Inboxing caps tags at ${INBOXING_MAX_TAGS} per domain (got ${tags.length})`);
  }
  await call("PUT", `/domains/${encodeURIComponent(domainId)}/tags`, { tags }, true, account);
}

export interface InboxingPlatformConnection {
  id: string;
  name: string;
  /** e.g. "emailbison", "instantly", "smartlead", "plusvibe" */
  platform: string;
  verificationStatus: string;
  verificationError: string | null;
}

/** Raw GET against Inboxing (no throw) — for discovering credential endpoints. */
export async function inboxingRawGet(path: string): Promise<{ status: number; body: unknown }> {
  const key = process.env.INBOXING_API_KEY;
  const base = process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2";
  if (!key) throw new Error("INBOXING_API_KEY missing");
  const res = await fetch(`${base}${path}`, { headers: { Accept: "application/json", "X-API-Key": key } });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 500); }
  return { status: res.status, body };
}

/** All configured sequencer connections (GET /platform-connections). */
export async function listPlatformConnections(
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
): Promise<InboxingPlatformConnection[]> {
  const result = await call<{
    data?: Array<{
      id: string;
      name?: string;
      platform?: string;
      verification_status?: string;
      verification_error?: string | null;
    }>;
  }>("GET", "/platform-connections", undefined, false, account);
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
export interface InboxingEmailUploadResult {
  success: boolean;
  jobsCreated: number;
  matched: number;
  skipped: { no_domain?: number; not_in_csv?: number; already_uploaded?: number } | null;
  platform: string;
  connectionName: string;
  message: string;
}

/**
 * Upload specific email accounts to a sequencer platform connection
 * (POST /upload). Unlike the domain-based upload, this pushes individual
 * emails (max 100). Emails are matched to active domains with credentials;
 * unmatched ones come back under `skipped`. ASYNC — one job per matched email.
 */
export async function uploadEmailsToPlatform(
  emails: string[],
  platformConnectionId: string,
): Promise<InboxingEmailUploadResult> {
  const result = await call<{
    success?: boolean;
    jobs_created?: number;
    matched?: number;
    skipped?: { no_domain?: number; not_in_csv?: number; already_uploaded?: number };
    platform?: string;
    connection_name?: string;
    message?: string;
  }>("POST", `/upload`, {
    emails,
    platform_connection_id: platformConnectionId,
    enable_warmup: true,
    skip_verified: false,
    sync_tags: false,
  }, true);
  return {
    success: result.success ?? false,
    jobsCreated: result.jobs_created ?? 0,
    matched: result.matched ?? 0,
    skipped: result.skipped ?? null,
    platform: result.platform || "",
    connectionName: result.connection_name || "",
    message: result.message || "",
  };
}

export async function uploadDomainToPlatform(
  domainId: string,
  platformConnectionId: string,
  account: InboxingAccount = DEFAULT_INBOXING_ACCOUNT,
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
  }, true, account);
  return {
    jobsCreated: result.jobs_created ?? 0,
    connectionName: result.connection_name || "",
    message: result.message || "",
  };
}
