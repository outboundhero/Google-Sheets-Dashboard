import type {
  CreateOrderInput,
  ProviderStatusResult,
} from "@/types/inbox-order";

const BASE = "https://api.milkboxmail.com/api/v1";

function env() {
  const key = process.env.MILKBOX_API_KEY;
  const sequencerId = process.env.MILKBOX_SEQUENCER_ID;
  const domainProviderId = process.env.MILKBOX_DOMAIN_PROVIDER_ID;
  if (!key || !sequencerId || !domainProviderId) {
    throw new Error(
      "MilkBox env missing (MILKBOX_API_KEY / MILKBOX_SEQUENCER_ID / MILKBOX_DOMAIN_PROVIDER_ID)"
    );
  }
  return {
    key,
    sequencerId: parseInt(sequencerId, 10),
    domainProviderId: parseInt(domainProviderId, 10),
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
    const msg =
      (parsed &&
        typeof parsed === "object" &&
        ((parsed as { error?: { message?: string } | string }).error)) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    const flat = typeof msg === "string" ? msg : (msg as { message?: string }).message || JSON.stringify(msg);
    throw new Error(`MilkBox ${method} ${path}: ${flat}`);
  }
  return (parsed ?? {}) as T;
}

export interface MilkboxOrderEnvelope<T> {
  data: T;
  request_id?: string;
}

export interface MilkboxCreateOrderResult {
  orderId: string;
  raw: unknown;
}

export async function createOrder(input: CreateOrderInput): Promise<MilkboxCreateOrderResult> {
  const { sequencerId, domainProviderId } = env();
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
    type: "AUTOMATED" as const,
    slots_type: "MICROSOFT" as const,
    sequencer_id: sequencerId,
    domain_provider_id: domainProviderId,
    company_name: input.companyName,
    email_senders,
    domains: [
      {
        name: input.domain,
        redirect_url: input.redirectUrl,
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
    order_type: "AUTOMATED" as const,
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
