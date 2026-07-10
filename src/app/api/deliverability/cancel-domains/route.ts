import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { findDomainByName, listDomainsWithLifecycle as listInboxingDomains } from "@/lib/inboxing";
import { listDomainsWithLifecycle as listMilkboxDomains } from "@/lib/milkbox";
import { postSlackMessage } from "@/lib/slack";

export const maxDuration = 300;

/**
 * POST /api/deliverability/cancel-domains
 *
 * Cancels domains at their PROVIDER (Inboxing / MilkBox) while leaving the
 * rows in LeadSync untouched — the counterpart to bulk-delete, which removes
 * inboxes from Bison + the dashboard. ScaledMail has no per-domain cancel
 * API, so ScaledMail domains are explicitly skipped with a clear message.
 *
 * Actions:
 *   { dryRun: true,  domains }  → routing plan (provider, skip reasons), no writes
 *   { dryRun: false, domains }  → cancel batch: per-domain 3-attempt retry
 *                                 (2s/6s/15s, honors Retry-After), classified
 *                                 outcomes (canceled / alreadyGone / failed)
 *   { action: "notify", canceled, failed, skipped } → Slack summary to
 *                                 CANCEL_DOMAINS_SLACK_CHANNEL_ID (only the
 *                                 successfully canceled domains are listed)
 *
 * Admin-only via middleware (POST).
 */

type Provider = "inboxing" | "milkbox";

const SLACK_CHANNEL = process.env.CANCEL_DOMAINS_SLACK_CHANNEL_ID || "C0B84LMSVMH";
const SCALEDMAIL_SKIP = "ScaledMail domain — this workflow is for Inboxing and MilkBox domains only";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function detectProvider(tags: string[]): { provider: Provider | "scaledmail" | null; skipReason: string | null } {
  const lower = tags.map((t) => (t || "").toLowerCase());
  if (lower.some((t) => t.includes("milkbox"))) return { provider: "milkbox", skipReason: null };
  if (lower.some((t) => t.includes("scaledmail") || t.includes("scaled mail"))) return { provider: "scaledmail", skipReason: null };
  if (lower.some((t) => t.includes("inboxing"))) return { provider: "inboxing", skipReason: null };
  if (lower.some((t) => t.includes("cheap inbox"))) return { provider: null, skipReason: "Cheap Inboxes — no provider API" };
  return { provider: null, skipReason: "No provider tag on domain" };
}

/** Status-classified provider cancel with 3 patient attempts. */
async function cancelAtProvider(
  provider: Provider,
  providerDomainId: string,
): Promise<{ outcome: "canceled" | "already_gone" | "failed"; status: number | null; error: string }> {
  const url =
    provider === "inboxing"
      ? `${process.env.INBOXING_BASE_URL || "https://v2.inboxing.com/api/v2"}/domains/${encodeURIComponent(providerDomainId)}`
      : `https://api.milkboxmail.com/api/v1/domains/${encodeURIComponent(providerDomainId)}`;
  const headers: Record<string, string> =
    provider === "inboxing"
      ? { Accept: "application/json", "X-API-Key": process.env.INBOXING_API_KEY || "" }
      : { Accept: "application/json", Authorization: `Bearer ${process.env.MILKBOX_API_KEY || ""}` };

  const WAITS = [2_000, 6_000, 15_000];
  let lastStatus: number | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "DELETE", headers });
      if (res.ok) return { outcome: "canceled", status: res.status, error: "" }; // 200 / 202 accepted
      if (res.status === 404) return { outcome: "already_gone", status: 404, error: "not found at provider (already canceled/deleted)" };
      lastStatus = res.status;
      lastError = (await res.text().catch(() => "")).slice(0, 150) || `HTTP ${res.status}`;
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "", 10);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 + 500 : WAITS[attempt];
        await delay(wait + Math.floor(Math.random() * 400));
        continue;
      }
      // Other 4xx won't improve with retries.
      return { outcome: "failed", status: lastStatus, error: lastError };
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : "network error";
      await delay(WAITS[attempt]);
    }
  }
  return { outcome: "failed", status: lastStatus, error: `exhausted retries: ${lastError}` };
}

interface RoutingRow {
  domain: string;
  provider: Provider | "scaledmail" | null;
  providerDomainId: string | null;
  instances: string[];
  skipReason: string | null;
}

/** Resolve provider + provider domain id for each requested name. */
async function routeDomains(domains: string[]): Promise<RoutingRow[]> {
  const supabase = getSupabaseAdmin();

  // Tags per name (union across instances) + instance list.
  const tagsByName = new Map<string, { tags: string[]; instances: string[] }>();
  for (let i = 0; i < domains.length; i += 100) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags")
      .in("domain", domains.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of (data || []) as { instance: string; domain: string; tags: string[] | null }[]) {
      const k = r.domain.toLowerCase();
      const entry = tagsByName.get(k) ?? { tags: [], instances: [] };
      entry.tags.push(...(r.tags || []));
      entry.instances.push(r.instance);
      tagsByName.set(k, entry);
    }
  }

  // Provider domain ids: inbox_orders first, provider_domain_status fallback.
  const idByKey = new Map<string, string>(); // `${provider}:${domain}` → id
  for (let i = 0; i < domains.length; i += 100) {
    const batch = domains.slice(i, i + 100);
    const { data: orders } = await supabase
      .from("inbox_orders")
      .select("provider, domain, provider_domain_id")
      .in("domain", batch)
      .in("provider", ["inboxing", "milkbox"]);
    for (const o of (orders || []) as { provider: string; domain: string; provider_domain_id: string | null }[]) {
      if (o.provider_domain_id) idByKey.set(`${o.provider}:${o.domain.toLowerCase()}`, o.provider_domain_id);
    }
    const { data: statuses } = await supabase
      .from("provider_domain_status")
      .select("provider, domain, provider_domain_id, status")
      .in("domain", batch);
    for (const s of (statuses || []) as { provider: string; domain: string; provider_domain_id: string | null; status: string }[]) {
      const key = `${s.provider}:${s.domain.toLowerCase()}`;
      if (s.provider_domain_id && !idByKey.has(key)) idByKey.set(key, s.provider_domain_id);
    }
  }

  // Already-canceled check from the cached provider status.
  const canceledSet = new Set<string>();
  for (let i = 0; i < domains.length; i += 100) {
    const { data } = await supabase
      .from("provider_domain_status")
      .select("domain, status")
      .in("domain", domains.slice(i, i + 100))
      .eq("status", "canceled");
    for (const r of (data || []) as { domain: string }[]) canceledSet.add(r.domain.toLowerCase());
  }

  return domains.map((domain) => {
    const entry = tagsByName.get(domain);
    if (!entry) return { domain, provider: null, providerDomainId: null, instances: [], skipReason: "not found in LeadSync" };
    const det = detectProvider(entry.tags);
    if (det.provider === "scaledmail") {
      return { domain, provider: "scaledmail" as const, providerDomainId: null, instances: entry.instances, skipReason: SCALEDMAIL_SKIP };
    }
    if (!det.provider) return { domain, provider: null, providerDomainId: null, instances: entry.instances, skipReason: det.skipReason };
    if (canceledSet.has(domain)) {
      return { domain, provider: det.provider, providerDomainId: null, instances: entry.instances, skipReason: "already canceled at provider" };
    }
    return {
      domain,
      provider: det.provider,
      providerDomainId: idByKey.get(`${det.provider}:${domain}`) ?? null, // null → live lookup at apply
      instances: entry.instances,
      skipReason: null,
    };
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // ── Slack summary after the FE-driven run completes ───────────────────
    if (body?.action === "notify") {
      const canceled = (body.canceled || []) as { domain: string; provider: string }[];
      const failed = Number(body.failed || 0);
      const skipped = Number(body.skipped || 0);
      if (canceled.length === 0) {
        return NextResponse.json({ sent: false, reason: "nothing canceled — no message sent" });
      }
      const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
      const byProvider: Record<string, string[]> = {};
      for (const c of canceled) (byProvider[c.provider] ||= []).push(c.domain);

      const lines: string[] = [
        `:no_entry_sign: *Domains canceled — ${canceled.length} domain${canceled.length === 1 ? "" : "s"}* (${date})`,
      ];
      for (const [provider, doms] of Object.entries(byProvider)) {
        const label = provider === "inboxing" ? "Inboxing" : provider === "milkbox" ? "MilkBox" : provider;
        lines.push(`*${label} (${doms.length}):*`);
        for (const d of doms.sort()) lines.push(`• ${d}`);
      }
      if (failed > 0 || skipped > 0) {
        lines.push(`_${[failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(" / ")} — see LeadSync for details_`);
      }

      // Slack messages display best under ~80 bullet lines — chunk if huge.
      const CHUNK = 90;
      let sent = true;
      let reason: string | undefined;
      if (lines.length <= CHUNK) {
        const r = await postSlackMessage(lines.join("\n"), SLACK_CHANNEL);
        sent = r.ok;
        reason = r.reason;
      } else {
        for (let i = 0; i < lines.length; i += CHUNK) {
          const part = lines.slice(i, i + CHUNK).join("\n");
          const r = await postSlackMessage(i === 0 ? part : `(continued)\n${part}`, SLACK_CHANNEL);
          if (!r.ok) { sent = false; reason = r.reason; break; }
          await delay(600);
        }
      }
      return NextResponse.json({ sent, reason, channel: SLACK_CHANNEL });
    }

    const domains = ([...new Set((body?.domains || []) as string[])]).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }
    const dryRun = body?.dryRun !== false;
    const routing = await routeDomains(domains);

    // ── Dry run: plan only ─────────────────────────────────────────────────
    if (dryRun) {
      const cancelable = routing.filter((r) => !r.skipReason);
      return NextResponse.json({
        plan: routing,
        counts: {
          cancelable: cancelable.length,
          skipped: routing.length - cancelable.length,
          byProvider: {
            inboxing: cancelable.filter((r) => r.provider === "inboxing").length,
            milkbox: cancelable.filter((r) => r.provider === "milkbox").length,
          },
        },
      });
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    const supabase = getSupabaseAdmin();
    interface CancelResult { domain: string; provider: string | null; status: "canceled" | "alreadyGone" | "skipped" | "failed"; error?: string }
    const results: CancelResult[] = [];

    // Live-lookup fallbacks, loaded lazily at most once per request.
    let milkboxIndex: Map<string, string> | null = null;
    let inboxingIndex: Map<string, string> | null = null;

    for (const row of routing) {
      if (row.skipReason) {
        results.push({ domain: row.domain, provider: row.provider, status: "skipped", error: row.skipReason });
        continue;
      }
      const provider = row.provider as Provider;

      // Resolve missing provider domain ids live.
      let providerId = row.providerDomainId;
      try {
        if (!providerId && provider === "inboxing") {
          // Cheap single lookup first; fall back to a one-time full index
          // (handles search-endpoint flakiness under rate limits).
          const hit = await findDomainByName(row.domain).catch(() => null);
          if (hit) {
            providerId = hit.id;
          } else {
            if (!inboxingIndex) {
              inboxingIndex = new Map((await listInboxingDomains()).map((d) => [d.name.toLowerCase(), d.id]));
            }
            providerId = inboxingIndex.get(row.domain) ?? null;
          }
        }
        if (!providerId && provider === "milkbox") {
          if (!milkboxIndex) {
            milkboxIndex = new Map((await listMilkboxDomains()).map((d) => [d.name.toLowerCase(), d.id]));
          }
          providerId = milkboxIndex.get(row.domain) ?? null;
        }
      } catch (e) {
        results.push({ domain: row.domain, provider, status: "failed", error: `provider lookup failed: ${e instanceof Error ? e.message : "error"}` });
        continue;
      }
      if (!providerId) {
        results.push({ domain: row.domain, provider, status: "failed", error: "not found on the provider account (no domain id)" });
        continue;
      }

      const res = await cancelAtProvider(provider, providerId);
      if (res.outcome === "failed") {
        results.push({ domain: row.domain, provider, status: "failed", error: `${res.status ? `HTTP ${res.status} — ` : ""}${res.error}` });
      } else {
        results.push({ domain: row.domain, provider, status: res.outcome === "canceled" ? "canceled" : "alreadyGone" });
        // Bookkeeping (LeadSync rows stay put): mark the order deleting and
        // flip the cached provider status so the column updates immediately.
        // The follow-up Check Provider Status run re-verifies from the API.
        await supabase.from("inbox_orders").update({ status: "deleting", last_checked_at: new Date().toISOString() })
          .eq("provider", provider).eq("domain", row.domain);
        for (const instance of row.instances) {
          await supabase.from("provider_domain_status").upsert(
            [{
              instance,
              domain: row.domain,
              provider,
              provider_domain_id: providerId,
              status: "canceled",
              raw_status: "deleting",
              failure_reason: null,
              checked_at: new Date().toISOString(),
            }],
            { onConflict: "instance,domain" },
          );
        }
      }
      // Pace provider calls — both providers rate-limit per minute.
      await delay(500);
    }

    return NextResponse.json({
      results,
      summary: {
        canceled: results.filter((r) => r.status === "canceled").length,
        alreadyGone: results.filter((r) => r.status === "alreadyGone").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cancel failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
