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

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
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
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && (parsed as { error?: string }).error) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new Error(`Inboxing ${method} ${path}: ${msg}`);
  }
  return (parsed ?? {}) as T;
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
