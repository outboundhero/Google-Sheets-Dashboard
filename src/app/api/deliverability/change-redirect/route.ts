import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { meansNoRedirect } from "@/lib/deliverability/redirect-normalize";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount, type InboxingAccount } from "@/lib/inboxing-accounts";

export const maxDuration = 300;

/**
 * POST /api/deliverability/change-redirect
 *
 * Bulk-change the redirect URL for selected deliverability domains. The route
 * inspects each domain's tags in deliverability_domains.tags (case-insensitive
 * substring match) to decide which provider's API to call:
 *
 *   - `milkbox`   → milkbox.updateRedirect(provider_domain_id, newUrl)
 *   - `inboxing`  → inboxing.updateRedirect(provider_domain_id, newUrl)
 *   - `scaledmail`→ scaledmail.updateRedirect(domain_name, newUrl)
 *   - `cheap inboxes` → skipped (no provider API)
 *   - no vendor tag at all → skipped
 *
 * MilkBox + Inboxing need the provider's internal domain ID, which we look up
 * from `inbox_orders.provider_domain_id` matched on (provider, domain). If
 * LeadSync never placed the order, that row doesn't exist → skipped with
 * "no provider record" so the user can update it manually in the provider UI.
 *
 * Each per-domain action retries up to 3 times with exponential backoff before
 * being recorded as failed. The full per-domain result is returned so the
 * dialog can render a status table; on success we also bump
 * inbox_orders.redirect_url so the cache reflects the new value.
 *
 * Phase 1 — Plan: { dryRun: true, domains: [...] }
 *   Just inspects tags + looks up provider_domain_id; no API calls to providers.
 *   Returns per-domain routing so the dialog can preview before submit.
 *
 * Phase 2 — Apply: { dryRun: false, domains: [...], newUrl: "https://..." }
 *   Performs the actual updates with retry.
 */

type ProviderSlug = "milkbox" | "scaledmail" | "inboxing";

interface DomainRouting {
  domain: string;
  tags: string[];
  provider: ProviderSlug | null;
  providerDomainId: string | null;
  /** Inboxing only: which login holds the domain (null → the original one). */
  inboxingAccount: InboxingAccount | null;
  skipReason: string | null;
}

interface PerDomainResult {
  domain: string;
  provider: ProviderSlug | null;
  status: "updated" | "skipped" | "failed";
  reason?: string;
  attempts?: number;
}

function detectProvider(tags: string[]): { provider: ProviderSlug | null; skipReason: string | null } {
  const lower = tags.map((t) => t.toLowerCase());
  // MilkBox first because the literal "milkbox" may also appear inside compound
  // tags like "MilkBox - Microsoft" — substring match catches both.
  if (lower.some((t) => t.includes("milkbox"))) return { provider: "milkbox", skipReason: null };
  if (lower.some((t) => t.includes("scaledmail") || t.includes("scaled mail"))) return { provider: "scaledmail", skipReason: null };
  if (lower.some((t) => t.includes("inboxing"))) return { provider: "inboxing", skipReason: null };
  if (lower.some((t) => t.includes("cheap inbox"))) return { provider: null, skipReason: "Cheap Inboxes (no API)" };
  return { provider: null, skipReason: "No vendor tag" };
}

// newUrl === null means "clear the redirect" → each provider's NONE endpoint.
async function callProviderUpdateRedirect(
  routing: DomainRouting,
  newUrl: string | null,
  mask = true,
): Promise<void> {
  if (routing.provider === "milkbox") {
    if (!routing.providerDomainId) throw new Error("Missing MilkBox provider_domain_id");
    await milkbox.updateRedirect(routing.providerDomainId, newUrl);
    return;
  }
  if (routing.provider === "inboxing") {
    if (!routing.providerDomainId) throw new Error("Missing Inboxing provider_domain_id");
    await inboxing.updateRedirect(
      routing.providerDomainId,
      newUrl,
      routing.inboxingAccount ?? DEFAULT_INBOXING_ACCOUNT,
      mask,
    );
    return;
  }
  if (routing.provider === "scaledmail") {
    // ScaledMail's swap-redirect takes a string; empty = clear.
    await scaledmail.updateRedirect(routing.domain, newUrl ?? "");
    return;
  }
  throw new Error(`Unsupported provider: ${routing.provider}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: string; attempts: number }> {
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) await sleep(1000 * attempt); // 1s, 2s backoff
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

async function buildRouting(
  domains: string[],
): Promise<DomainRouting[]> {
  const supabase = getSupabaseAdmin();
  // Pull tags for the requested domains from deliverability_domains. A single
  // (instance, domain) shows tags scoped to that instance — but since the
  // deliverability page already filters by instance via its `instancesQuery`
  // and feeds us the visible domains, the tags shown there are what we trust.
  // We just need any matching row; merge tags across instances if duplicated.
  const tagsByDomain = new Map<string, string[]>();
  for (let i = 0; i < domains.length; i += 200) {
    const batch = domains.slice(i, i + 200);
    const { data } = await supabase
      .from("deliverability_domains")
      .select("domain, tags")
      .in("domain", batch);
    for (const row of (data ?? []) as { domain: string; tags: string[] | null }[]) {
      const existing = tagsByDomain.get(row.domain) ?? [];
      const next = new Set<string>(existing);
      for (const t of row.tags ?? []) next.add(t);
      tagsByDomain.set(row.domain, [...next]);
    }
  }

  // For MilkBox + Inboxing we need provider_domain_id from inbox_orders.
  // Pull all orders for the relevant providers + domains in one shot.
  const { data: orderRows } = await supabase
    .from("inbox_orders")
    .select("provider, domain, provider_domain_id, redirect_url, inboxing_account")
    .in("domain", domains)
    .in("provider", ["milkbox", "inboxing", "scaledmail"]);
  const providerIdByKey = new Map<string, string | null>();
  const inboxingAccountByDomain = new Map<string, InboxingAccount>();
  for (const r of (orderRows ?? []) as { provider: string; domain: string; provider_domain_id: string | null; inboxing_account?: string | null }[]) {
    providerIdByKey.set(`${r.provider}:${r.domain}`, r.provider_domain_id);
    const acc = r.provider === "inboxing" ? toInboxingAccount(r.inboxing_account) : null;
    if (acc) inboxingAccountByDomain.set(r.domain, acc);
  }

  // Build initial routing. Both MilkBox and Inboxing's PUT redirect endpoints
  // require their internal UUID; the cached value from inbox_orders is used
  // when present, and missing rows get a live lookup pass below.
  const routing: DomainRouting[] = domains.map((domain) => {
    const tags = tagsByDomain.get(domain) ?? [];
    const { provider, skipReason } = detectProvider(tags);
    let providerDomainId: string | null = null;
    if (provider === "milkbox" || provider === "inboxing") {
      providerDomainId = providerIdByKey.get(`${provider}:${domain}`) ?? null;
    }
    return {
      domain,
      tags,
      provider,
      providerDomainId,
      inboxingAccount: provider === "inboxing" ? inboxingAccountByDomain.get(domain) ?? null : null,
      skipReason,
    };
  });

  // Live lookup pass for MilkBox: one paginated /api/v1/domains fetch resolves
  // every milkbox domain that's missing an ID. Only fired if there's anything
  // to resolve.
  const milkboxNeedsLookup = routing.filter(
    (r) => r.provider === "milkbox" && !r.skipReason && !r.providerDomainId,
  );
  if (milkboxNeedsLookup.length > 0) {
    try {
      const list = await milkbox.listDomains();
      const byName = new Map<string, string>();
      for (const d of list) byName.set(d.name.toLowerCase(), d.id);
      for (const r of milkboxNeedsLookup) {
        const id = byName.get(r.domain.toLowerCase());
        if (id) r.providerDomainId = id;
        else r.skipReason = "Domain not found on MilkBox";
      }
    } catch (e) {
      const reason = `MilkBox list failed: ${e instanceof Error ? e.message : "unknown"}`;
      for (const r of milkboxNeedsLookup) {
        r.skipReason = reason;
      }
    }
  }

  // Live lookup pass for Inboxing: its GET /domains?search= endpoint lets us
  // look up by name one-at-a-time (cheap). The PUT redirect endpoint requires
  // the UUID even though GET accepts either, so we need this step.
  const inboxingNeedsLookup = routing.filter(
    (r) => r.provider === "inboxing" && !r.skipReason && !r.providerDomainId,
  );
  if (inboxingNeedsLookup.length > 0) {
    // 5 in flight to stay polite — same as the apply concurrency below.
    const POOL = 5;
    let idx = 0;
    async function worker() {
      while (idx < inboxingNeedsLookup.length) {
        const r = inboxingNeedsLookup[idx++];
        try {
          const match = await inboxing.findDomainAnyAccount(r.domain);
          if (match) {
            r.providerDomainId = match.id;
            r.inboxingAccount = match.account;
          } else r.skipReason = "Domain not found on Inboxing";
        } catch (e) {
          r.skipReason = `Inboxing lookup failed: ${e instanceof Error ? e.message : "unknown"}`;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, inboxingNeedsLookup.length) }, () => worker()));
  }

  return routing;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const inputDomains: string[] = Array.isArray(body?.domains)
      ? body.domains.map((d: unknown) => String(d).trim().toLowerCase()).filter(Boolean)
      : [];
    const rawNewUrl = typeof body?.newUrl === "string" ? body.newUrl.trim() : "";
    // Clear the redirect (→ each provider's NONE endpoint) only on an EXPLICIT
    // signal: a `clearRedirect: true` flag, or a non-blank no-redirect sentinel
    // like "n/a" / "none". A blank field is NOT treated as clear — that would
    // let an accidental empty submit wipe every selected domain's redirect.
    const clearRedirect = body?.clearRedirect === true || (rawNewUrl !== "" && meansNoRedirect(rawNewUrl));
    const newUrl: string | null = clearRedirect ? null : rawNewUrl;

    // Masking (Spencer 2026-08-20): Inboxing domains are masked by default —
    // EXCEPT jan-pro.com, whose site can't be framed. `mask` lets the caller
    // turn masking off for a batch; it can never turn it ON for a destination
    // that can't be masked, so the JAN-PRO rule stays enforced server-side no
    // matter what the UI sends. Only Inboxing supports this.
    const maskRequested = body?.mask === false ? false : true;

    if (inputDomains.length === 0) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }
    if (!dryRun) {
      if (!clearRedirect && !/^https?:\/\/.+/i.test(newUrl ?? "")) {
        return NextResponse.json({ error: "newUrl required (http:// or https://), or send a clear value (n/a / none)" }, { status: 400 });
      }
    }

    const routing = await buildRouting(inputDomains);

    // ─── Dry-run: just return the routing plan ───
    if (dryRun) {
      const counts = {
        total: routing.length,
        byProvider: { milkbox: 0, inboxing: 0, scaledmail: 0 } as Record<ProviderSlug, number>,
        skipped: 0,
      };
      for (const r of routing) {
        if (r.skipReason || !r.provider) counts.skipped++;
        else counts.byProvider[r.provider]++;
      }
      return NextResponse.json({ dryRun: true, routing, counts });
    }

    // ─── Apply: per-domain update with retry, ~5 in parallel to be polite ───
    const supabase = getSupabaseAdmin();
    const CONCURRENCY = 5;
    const results: PerDomainResult[] = new Array(routing.length);

    // Worker pool
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < routing.length) {
        const idx = nextIdx++;
        const r = routing[idx];

        if (r.skipReason || !r.provider) {
          results[idx] = { domain: r.domain, provider: r.provider, status: "skipped", reason: r.skipReason ?? "Unknown" };
          continue;
        }

        const attempt = await withRetry(() => callProviderUpdateRedirect(r, newUrl, maskRequested), 3);
        if (attempt.ok) {
          results[idx] = { domain: r.domain, provider: r.provider, status: "updated", attempts: attempt.attempts };
          // Best-effort cache updates — don't fail the result if either errors.
          // Two tables to keep in sync:
          //   - inbox_orders.redirect_url (for the Inbox Orders page)
          //   - deliverability_domains.redirect_url (for the Deliverability "Redirect URL" column)
          // Without the second update the user wouldn't see the change until the
          // /api/cron/redirect-check sweep runs and re-resolves the redirect.
          try {
            await supabase
              .from("inbox_orders")
              .update({ redirect_url: newUrl })
              .eq("provider", r.provider)
              .eq("domain", r.domain);
          } catch { /* ignore */ }
          try {
            await supabase
              .from("deliverability_domains")
              .update({ redirect_url: newUrl, redirect_checked_at: new Date().toISOString() })
              .eq("domain", r.domain);
          } catch { /* ignore */ }
        } else {
          results[idx] = {
            domain: r.domain,
            provider: r.provider,
            status: "failed",
            reason: attempt.error,
            attempts: attempt.attempts,
          };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routing.length) }, () => worker()));

    const summary = {
      updated: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    };

    return NextResponse.json({ dryRun: false, newUrl, results, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
