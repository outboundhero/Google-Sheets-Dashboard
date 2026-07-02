import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 60;

/**
 * POST /api/admin/setup-bison-webhooks
 * Optional body: { callbackBaseUrl?: string }
 *
 * Idempotently registers the LeadSync disconnect + reconnect webhooks on
 * every Bison instance. Uses Bison's own webhook management endpoints
 * (POST /api/webhook-url, GET /api/webhook-url) — safe to re-run any time.
 *
 * For each instance × webhook, the flow is:
 *   1. GET /api/webhook-url — list existing webhooks in that Bison
 *   2. If a webhook with the target URL already exists → skip (idempotent)
 *   3. Otherwise POST /api/webhook-url — create it
 *
 * Callback URL is derived from the incoming request's origin by default so
 * webhooks point back to the exact deployment the admin is on. Override
 * with { callbackBaseUrl: "https://…" } if setting up from a preview/local
 * client but targeting the prod deployment (or vice versa).
 *
 * Admin-only. The route is under /api/admin/ and re-checks the role
 * in-band as defense-in-depth.
 */

interface BisonWebhookRow {
  id: number;
  name: string;
  url: string;
  events: string[];
}

interface DesiredWebhook {
  name: string;
  url: string;
  events: string[];
}

interface PerWebhookResult {
  name: string;
  url: string;
  status: "created" | "already_exists" | "failed";
  bisonId?: number;
  error?: string;
}

interface PerInstanceResult {
  instance: BisonInstanceSlug;
  webhooks: PerWebhookResult[];
  listError?: string;
}

function buildDesired(instance: BisonInstanceSlug, callbackBaseUrl: string): DesiredWebhook[] {
  const base = callbackBaseUrl.replace(/\/+$/, "");
  return [
    {
      name: "LeadSync Disconnect",
      url: `${base}/api/webhooks/bison-disconnect/${instance}`,
      events: ["email_account_disconnected"],
    },
    {
      name: "LeadSync Reconnect",
      url: `${base}/api/webhooks/bison-reconnect/${instance}`,
      events: ["email_account_reconnected"],
    },
  ];
}

async function listBisonWebhooks(instance: BisonInstanceSlug): Promise<{ rows: BisonWebhookRow[]; error?: string }> {
  const res = await bisonFetch(instance, `/webhook-url`);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { rows: [], error: `list webhooks: ${res.status} ${txt.slice(0, 200)}` };
  }
  const json = await res.json().catch(() => ({}));
  const data: BisonWebhookRow[] = Array.isArray(json?.data) ? json.data : [];
  return { rows: data };
}

async function createBisonWebhook(
  instance: BisonInstanceSlug,
  desired: DesiredWebhook,
): Promise<{ id?: number; error?: string }> {
  const res = await bisonFetch(instance, `/webhook-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(desired),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { error: `create webhook: ${res.status} ${txt.slice(0, 300)}` };
  }
  const json = await res.json().catch(() => ({}));
  const id = typeof json?.data?.id === "number" ? json.data.id : undefined;
  return { id };
}

export async function POST(request: Request) {
  try {
    // Admin-only.
    const cookieStore = await cookies();
    const supabaseAuth = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabaseAuth.auth.getUser();
    const role = user?.app_metadata?.role || user?.user_metadata?.role;
    if (!user || role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const overrideBase = typeof body?.callbackBaseUrl === "string" && body.callbackBaseUrl.length > 0
      ? body.callbackBaseUrl
      : null;

    // Default: point webhooks at the same host that served this request.
    // Works for prod, staging, and preview deployments without env config.
    const url = new URL(request.url);
    const callbackBaseUrl = overrideBase || `${url.protocol}//${url.host}`;

    const results: PerInstanceResult[] = [];
    for (const instance of ALL_INSTANCE_SLUGS) {
      const list = await listBisonWebhooks(instance);
      const perWebhook: PerWebhookResult[] = [];
      if (list.error) {
        results.push({ instance, webhooks: [], listError: list.error });
        continue;
      }
      // Normalize URLs for matching (strip trailing slash + lowercase host).
      const existingByUrl = new Map<string, BisonWebhookRow>();
      for (const row of list.rows) {
        if (typeof row?.url === "string") {
          existingByUrl.set(row.url.replace(/\/+$/, "").toLowerCase(), row);
        }
      }

      for (const desired of buildDesired(instance, callbackBaseUrl)) {
        const key = desired.url.replace(/\/+$/, "").toLowerCase();
        const existing = existingByUrl.get(key);
        if (existing) {
          // Verify the existing webhook subscribes to the events we need. If
          // it's missing our event, Bison's PATCH isn't exposed by the docs —
          // report it as an existing row for now.
          const hasAllEvents = desired.events.every((e) => existing.events?.includes(e));
          perWebhook.push({
            name: desired.name,
            url: desired.url,
            status: "already_exists",
            bisonId: existing.id,
            ...(hasAllEvents ? {} : { error: `existing webhook is subscribed to [${(existing.events || []).join(", ")}] — not the expected [${desired.events.join(", ")}]. Delete it in Bison UI and re-run.` }),
          });
          continue;
        }
        const created = await createBisonWebhook(instance, desired);
        if (created.error) {
          perWebhook.push({
            name: desired.name,
            url: desired.url,
            status: "failed",
            error: created.error,
          });
        } else {
          perWebhook.push({
            name: desired.name,
            url: desired.url,
            status: "created",
            bisonId: created.id,
          });
        }
      }
      results.push({ instance, webhooks: perWebhook });
    }

    const summary = {
      total_instances: ALL_INSTANCE_SLUGS.length,
      created: results.reduce((s, r) => s + r.webhooks.filter((w) => w.status === "created").length, 0),
      already_exists: results.reduce((s, r) => s + r.webhooks.filter((w) => w.status === "already_exists").length, 0),
      failed: results.reduce((s, r) => s + r.webhooks.filter((w) => w.status === "failed").length, 0),
      list_errors: results.filter((r) => r.listError).length,
    };

    return NextResponse.json({
      ok: summary.failed === 0 && summary.list_errors === 0,
      callback_base_url: callbackBaseUrl,
      summary,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
