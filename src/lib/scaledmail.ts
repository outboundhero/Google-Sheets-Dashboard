import type {
  CreateOrderInput,
  InboxOrderAlias,
  ProviderStatusResult,
} from "@/types/inbox-order";

const BASE = "https://server.scaledmail.com/api/v1";

// Porkbun hosting login is resolved per-domain (Porkbun account) by the caller;
// the legacy single SCALEDMAIL_PORKBUN_USERNAME/PASSWORD is the fallback.
function env() {
  const key = process.env.SCALEDMAIL_API_KEY;
  const orgId = process.env.SCALEDMAIL_ORGANIZATION_ID;
  const priceId = process.env.SCALEDMAIL_OUTLOOK_25_PRICE_ID;
  if (!key || !orgId || !priceId) {
    throw new Error(
      "ScaledMail env missing (SCALEDMAIL_API_KEY / SCALEDMAIL_ORGANIZATION_ID / SCALEDMAIL_OUTLOOK_25_PRICE_ID)"
    );
  }
  return {
    key,
    orgId,
    priceId,
    porkbunUsername: process.env.SCALEDMAIL_PORKBUN_USERNAME || null,
    porkbunPassword: process.env.SCALEDMAIL_PORKBUN_PASSWORD || null,
  };
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query: Record<string, string> = {},
  body?: unknown
): Promise<T> {
  const { key } = env();
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url.toString(), init);
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
      (parsed && typeof parsed === "object" && (parsed as { message?: string }).message) ||
      text.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new Error(`ScaledMail ${method} ${path}: ${msg}`);
  }
  return (parsed ?? {}) as T;
}

interface ScaledmailOrderDomain {
  id?: string;
  name: string;
  status?: string;
}

interface ScaledmailOrderPackage {
  type?: string;
  status?: string;
  domains?: ScaledmailOrderDomain[];
}

interface ScaledmailOrderDetails {
  id: string;
  status?: string;
  packages?: ScaledmailOrderPackage[];
}

function aliasesToScaledmail(aliases: InboxOrderAlias[]) {
  return aliases.map((a) => ({
    first_name: a.first_name,
    last_name: a.last_name,
    alias: a.alias,
  }));
}

export interface ScaledmailCreateOrderResult {
  orderId: string;
  raw: unknown;
}

export async function createOrder(
  input: CreateOrderInput,
  opts?: { username?: string; password?: string },
): Promise<ScaledmailCreateOrderResult> {
  const { orgId, priceId, porkbunUsername, porkbunPassword } = env();
  const username = opts?.username ?? porkbunUsername;
  const password = opts?.password ?? porkbunPassword;
  if (!username || !password) {
    throw new Error("ScaledMail createOrder: no Porkbun login for this domain's account");
  }
  const body = {
    quantity: 1,
    ...(input.tag ? { tag: input.tag.slice(0, 20) } : {}),
    providers: {
      outlook: {
        domains: [
          {
            domain: input.domain,
            ...(input.redirectUrl ? { redirect: input.redirectUrl } : {}),
            aliases: aliasesToScaledmail(input.aliases),
          },
        ],
      },
    },
    hosting: {
      provider: "Porkbun",
      username,
      password,
    },
  };
  const result = await call<{ id?: string; order_id?: string; payment_id?: string }>(
    "POST",
    `/create-order/${encodeURIComponent(priceId)}`,
    { provider: "other", organization_id: orgId },
    body
  );
  const orderId = result.id || result.order_id || result.payment_id || "";
  if (!orderId) {
    throw new Error("ScaledMail createOrder: response missing order id");
  }
  return { orderId, raw: result };
}

export async function getOrder(orderId: string): Promise<ScaledmailOrderDetails> {
  const { orgId } = env();
  const result = await call<{ id?: string; status?: string; packages?: ScaledmailOrderPackage[] }>(
    "GET",
    `/orders/${encodeURIComponent(orderId)}`,
    { organization_id: orgId }
  );
  return {
    id: result.id || orderId,
    status: result.status,
    packages: result.packages,
  };
}

function deriveStatus(raw: string | undefined): ProviderStatusResult {
  const norm = (raw || "").toLowerCase();
  if (!norm) return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
  if (norm === "active" || norm === "completed" || norm === "success") {
    return { status: "active", rawStatus: raw!, setupStage: null, failureReason: null, completed: true };
  }
  if (norm === "cancelled" || norm === "canceled") {
    return { status: "deleted", rawStatus: raw!, setupStage: null, failureReason: null, completed: true };
  }
  if (norm.includes("fail") || norm === "error") {
    return { status: "failed", rawStatus: raw!, setupStage: null, failureReason: raw!, completed: true };
  }
  return { status: "pending", rawStatus: raw!, setupStage: null, failureReason: null, completed: false };
}

export async function getOrderStatus(orderId: string, expectedDomain: string): Promise<ProviderStatusResult> {
  const order = await getOrder(orderId);
  // Order-level status first
  let result = deriveStatus(order.status);
  if (result.completed && result.status === "active") {
    // Also check the specific domain's status
    const domainRow = (order.packages || [])
      .flatMap((p) => p.domains || [])
      .find((d) => d.name?.toLowerCase() === expectedDomain.toLowerCase());
    if (domainRow?.status) result = deriveStatus(domainRow.status);
  }
  return result;
}

export interface ScaledmailSwapResult {
  newDomain: string;
  raw: unknown;
}

export async function swapDomain(
  currentDomain: string,
  newDomain: string
): Promise<ScaledmailSwapResult> {
  const { orgId, porkbunUsername, porkbunPassword } = env();
  const body = {
    new_domain: newDomain,
    hosting: {
      provider: "Porkbun",
      username: porkbunUsername,
      password: porkbunPassword,
    },
  };
  const raw = await call(
    "POST",
    `/swap-domain/${encodeURIComponent(currentDomain)}`,
    { organization_id: orgId, provider: "other" },
    body
  );
  return { newDomain, raw };
}

export async function updateRedirect(domain: string, newRedirect: string): Promise<void> {
  const { orgId } = env();
  await call(
    "POST",
    `/swap-redirect/${encodeURIComponent(domain)}`,
    { organization_id: orgId },
    { new_redirect: newRedirect }
  );
}

export async function cancelOrder(orderId: string): Promise<void> {
  const { orgId } = env();
  await call("DELETE", `/orders/${encodeURIComponent(orderId)}`, { organization_id: orgId });
}

/** Account-wide domain list (GET /domains?organization_id=) for the daily
 *  provider-status check. Standalone fetch instead of call(): env() demands
 *  the full order-flow credential set (price id, Porkbun login), but a read
 *  only needs the API key + org id. The response shape isn't documented, so
 *  parsing is defensive: accepts a bare array or {domains|data: [...]}, and
 *  domain/name + status/active under common key variants. */
export async function listDomainsWithLifecycle(): Promise<
  { id: string; name: string; status: string | null }[]
> {
  const key = process.env.SCALEDMAIL_API_KEY;
  const orgId = process.env.SCALEDMAIL_ORGANIZATION_ID;
  if (!key || !orgId) {
    throw new Error("ScaledMail env missing (SCALEDMAIL_API_KEY / SCALEDMAIL_ORGANIZATION_ID)");
  }
  const url = new URL(`${BASE}/domains`);
  url.searchParams.set("organization_id", orgId);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ScaledMail GET /domains: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {
    throw new Error("ScaledMail GET /domains: non-JSON response");
  }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed as { domains?: unknown[]; data?: unknown[] })?.domains
      ?? (parsed as { data?: unknown[] })?.data
      ?? [];
  const out: { id: string; name: string; status: string | null }[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = String(r.domain ?? r.name ?? "").trim().toLowerCase();
    if (!name) continue;
    const status =
      typeof r.status === "string" && r.status
        ? r.status
        : typeof r.active === "boolean"
          ? (r.active ? "active" : "inactive")
          : null;
    out.push({ id: String(r.id ?? r.domain_id ?? ""), name, status });
  }
  return out;
}
