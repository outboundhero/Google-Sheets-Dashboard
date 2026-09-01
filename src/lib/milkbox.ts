import type {
  CreateOrderInput,
  ProviderStatusResult,
} from "@/types/inbox-order";

const BASE = "https://api.milkboxmail.com/api/v1";

// sequencer_id + domain_provider_id are UUID STRINGS per the MilkBox API — do
// NOT parseInt them. domain_provider_id is resolved per-domain (Porkbun account)
// by the caller; the legacy MILKBOX_DOMAIN_PROVIDER_ID is a single-account fallback.
function env() {
  const key = process.env.MILKBOX_API_KEY;
  if (!key) throw new Error("MilkBox env missing (MILKBOX_API_KEY)");
  // sequencer_id (per instance) + domain_provider_id (per Porkbun account) are
  // resolved by the caller; these are legacy single-value fallbacks.
  return {
    key,
    sequencerId: process.env.MILKBOX_SEQUENCER_ID || null,
    domainProviderId: process.env.MILKBOX_DOMAIN_PROVIDER_ID || null,
  };
}

async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const { key } = env();
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
  }
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const errorField = obj?.error;
    const details = obj?.details ?? obj?.errors;

    let summary: string;
    if (typeof errorField === "string") {
      summary = errorField;
    } else if (errorField && typeof errorField === "object" && "message" in errorField) {
      summary = String((errorField as { message?: unknown }).message ?? "");
    } else {
      summary = text.slice(0, 300) || `HTTP ${res.status}`;
    }

    const detailsStr =
      details === undefined || details === null
        ? ""
        : ` — ${typeof details === "string" ? details : JSON.stringify(details)}`;
    throw new Error(`MilkBox ${method} ${path}: ${summary}${detailsStr}`);
  }
  return (parsed ?? {}) as T;
}

/** Raw GET (no throw) — for discovering domain-provider / sequencer accounts. */
export async function milkboxRawGet(path: string): Promise<{ status: number; body: unknown }> {
  const key = process.env.MILKBOX_API_KEY;
  if (!key) throw new Error("MILKBOX_API_KEY missing");
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text.slice(0, 500); }
  return { status: res.status, body };
}

export interface MilkboxOrderEnvelope<T> {
  data: T;
  request_id?: string;
}

export interface MilkboxCreateOrderResult {
  orderId: string;
  raw: unknown;
}

export async function createOrder(
  input: CreateOrderInput,
  opts?: { domainProviderId?: string | null; sequencerId?: string | null },
): Promise<MilkboxCreateOrderResult> {
  const { sequencerId: legacySeq, domainProviderId: legacyProvider } = env();
  const sequencerId = opts?.sequencerId ?? legacySeq;
  const domainProviderId = opts?.domainProviderId ?? legacyProvider;
  if (!sequencerId) {
    throw new Error("MilkBox createOrder: no sequencer_id for this order's instance");
  }
  if (!domainProviderId) {
    throw new Error("MilkBox createOrder: no domain_provider_id for this domain's Porkbun account");
  }
  if (!input.companyName) {
    throw new Error("MilkBox createOrder: companyName is required");
  }
  // MilkBox derives mailbox aliases from email_senders names; we pass first/last from our aliases array.
  const uniqueSenders = new Map<string, { first_name: string; last_name: string }>();
  for (const a of input.aliases) {
    const k = `${a.first_name}|${a.last_name}`.toLowerCase();
    if (!uniqueSenders.has(k)) {
      uniqueSenders.set(k, { first_name: a.first_name, last_name: a.last_name });
    }
  }
  const email_senders = Array.from(uniqueSenders.values()).slice(0, Math.max(1, uniqueSenders.size));
  const body = {
    slots_type: "MICROSOFT" as const,
    sequencer_id: sequencerId,
    domain_provider_id: domainProviderId,
    company_name: input.companyName,
    email_senders,
    domains: [
      {
        // MilkBox's create spec lists redirect_url as part of the domain item
        // and doesn't document it as nullable, so a no-redirect order is
        // created with a transient placeholder and the strip-stock-redirects
        // cron removes it via the DOCUMENTED path right after (their PATCH
        // /redirect accepts null "to remove the redirect"). End state is the
        // same no-redirect Spencer asked for, without risking create-time
        // validation failures we can't test from here.
        name: input.domain,
        redirect_url: input.redirectUrl || `https://${input.domain}`,
        mailboxes: input.aliases.length,
      },
    ],
  };
  const idempotencyKey = `milkbox-order-${input.domain}-${Date.now()}`;
  const result = await call<MilkboxOrderEnvelope<{ id?: number | string; order_id?: number | string }>>(
    "POST",
    "/orders",
    { body, idempotencyKey }
  );
  const id = result.data?.id ?? result.data?.order_id;
  const orderId = id !== undefined && id !== null ? String(id) : "";
  if (!orderId) {
    throw new Error("MilkBox createOrder: response missing order id");
  }
  return { orderId, raw: result };
}

interface MilkboxProvisioning {
  status?: string;
  state?: string;
  stage?: string;
  failure_reason?: string;
  completed_at?: string | null;
  domain_id?: number | string;
}

function deriveStatus(raw: MilkboxProvisioning | null): ProviderStatusResult {
  if (!raw) {
    return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
  }
  const norm = (raw.status || raw.state || "").toLowerCase();
  const stage = raw.stage || null;
  if (norm === "completed" || norm === "active" || norm === "success" || norm === "done") {
    return { status: "active", rawStatus: norm, setupStage: stage, failureReason: null, completed: true };
  }
  if (norm === "failed" || norm === "error") {
    return {
      status: "failed",
      rawStatus: norm,
      setupStage: stage,
      failureReason: raw.failure_reason || null,
      completed: true,
    };
  }
  return { status: "pending", rawStatus: norm || null, setupStage: stage, failureReason: null, completed: false };
}

export interface MilkboxOrderStatusResult extends ProviderStatusResult {
  domainId: string | null;
}

export async function getOrderStatus(orderId: string): Promise<MilkboxOrderStatusResult> {
  const result = await call<MilkboxOrderEnvelope<MilkboxProvisioning | null>>(
    "GET",
    `/orders/${encodeURIComponent(orderId)}/provisioning`
  );
  const derived = deriveStatus(result.data);
  const domainIdRaw = result.data?.domain_id;
  const domainId = domainIdRaw !== undefined && domainIdRaw !== null ? String(domainIdRaw) : null;
  return { ...derived, domainId };
}

export interface MilkboxListedDomain {
  id: string;
  name: string;
}

/**
 * Extended lifecycle-aware shape returned by `listDomainsWithLifecycle()`.
 * `status` is the raw provider string (e.g. "ACTIVE", "PENDING"); `active`
 * mirrors the boolean flag in the API response. The provider-status cron
 * uses these to bucket into our "active" vs "canceled" domain classification.
 */
export interface MilkboxListedDomainWithLifecycle extends MilkboxListedDomain {
  status: string | null;
  active: boolean;
}

/**
 * List every domain on the MilkBox account. Cursor-paginated. Used by the
 * bulk change-redirect route to resolve a domain name → MilkBox UUID when
 * the domain isn't tracked in our inbox_orders cache (e.g. it was ordered
 * outside LeadSync).
 */
export async function listDomains(): Promise<MilkboxListedDomain[]> {
  const rows = await listDomainsWithLifecycle();
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Same walk as `listDomains()`, but preserves the `status` and `active`
 * fields the MilkBox API returns per row. Used by the provider-domain
 * status cron to detect canceled domains without a per-domain HTTP call —
 * a single list scan tells us the lifecycle state of every MilkBox domain
 * on the account.
 */
export async function listDomainsWithLifecycle(): Promise<MilkboxListedDomainWithLifecycle[]> {
  const all: MilkboxListedDomainWithLifecycle[] = [];
  let cursor: string | null = null;
  // Hard upper bound just in case the API never returns a null next_cursor.
  for (let safety = 0; safety < 500; safety++) {
    const path: string = cursor
      ? `/domains?cursor=${encodeURIComponent(cursor)}`
      : `/domains`;
    const result: {
      data?: Array<{ id: string | number; name: string; status?: string | null; active?: boolean }>;
      pagination?: { next_cursor?: string | null };
    } = await call("GET", path);
    for (const d of result.data || []) {
      if (d?.id === undefined || !d?.name) continue;
      all.push({
        id: String(d.id),
        name: d.name,
        status: typeof d.status === "string" ? d.status : null,
        // Treat missing `active` as true to avoid false-flagging historic
        // rows where the field isn't populated yet.
        active: d.active !== false,
      });
    }
    const next: string | null | undefined = result.pagination?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  return all;
}

export async function getDomain(domainId: string): Promise<{ id: number; name: string; redirect_url?: string | null } | null> {
  const result = await call<MilkboxOrderEnvelope<{ id: number; name: string; redirect_url?: string | null }>>(
    "GET",
    `/domains/${encodeURIComponent(domainId)}`
  );
  return result.data;
}

export interface MilkboxSwapResult {
  raw: unknown;
}

export async function swapDomain(domainId: string, newDomain: string): Promise<MilkboxSwapResult> {
  const { sequencerId, domainProviderId } = env();
  const body = {
    domain: newDomain,
    sequencer_id: sequencerId,
    domain_provider_id: domainProviderId,
  };
  const raw = await call("POST", `/domains/${encodeURIComponent(domainId)}/swap`, { body });
  return { raw };
}

export async function getSwapStatus(
  domainId: string
): Promise<{ done: boolean; newDomain: string | null }> {
  const result = await call<MilkboxOrderEnvelope<{ replacement_domain?: string; new_domain?: string } | null>>(
    "GET",
    `/domains/${encodeURIComponent(domainId)}/swap`
  );
  const data = result.data;
  if (!data) return { done: false, newDomain: null };
  const newDomain = data.new_domain || data.replacement_domain || null;
  return { done: !!newDomain, newDomain };
}

export async function updateRedirect(domainId: string, newRedirect: string | null): Promise<void> {
  await call("PATCH", `/domains/${encodeURIComponent(domainId)}/redirect`, {
    body: { redirect_url: newRedirect },
  });
}

export async function deleteDomain(domainId: string): Promise<void> {
  await call("DELETE", `/domains/${encodeURIComponent(domainId)}`);
}
