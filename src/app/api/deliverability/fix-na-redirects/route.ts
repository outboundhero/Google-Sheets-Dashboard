import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as inboxing from "@/lib/inboxing";
import * as milkbox from "@/lib/milkbox";
import * as scaledmail from "@/lib/scaledmail";
import { isBogusStoredRedirect } from "@/lib/deliverability/redirect-normalize";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount } from "@/lib/inboxing-accounts";

export const maxDuration = 300;

/**
 * GET  /api/deliverability/fix-na-redirects        → preview (no writes)
 * POST /api/deliverability/fix-na-redirects { apply: true } → repair
 *
 * One-off (idempotent, re-runnable) cleanup for the Inboxing "n/a" redirect
 * bug Ramon flagged: domains whose redirect was set to the literal string
 * "n/a" (or "none" / "-" / …) as a REGULAR redirect instead of NONE.
 *
 * For each affected `inbox_orders` row we call the provider's redirect endpoint
 * to clear it (→ NONE for Inboxing/MilkBox, empty for ScaledMail), then null
 * the stored `redirect_url` in both `inbox_orders` and `deliverability_domains`
 * so the bogus value is gone everywhere. Any bogus `deliverability_domains`
 * value with no matching order is just nulled — the redirect-check cron
 * re-resolves the real value on its next pass.
 *
 * Admin-only via the standard /api/deliverability/* middleware gate.
 */

interface OrderRow {
  instance: string;
  provider: string;
  domain: string;
  provider_domain_id: string | null;
  inboxing_account: string | null;
  redirect_url: string | null;
}

async function loadBogusOrders(): Promise<OrderRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("inbox_orders")
    .select("instance, provider, domain, provider_domain_id, inboxing_account, redirect_url")
    .limit(10000);
  if (error) throw new Error(error.message);
  return ((data || []) as OrderRow[]).filter((r) => isBogusStoredRedirect(r.redirect_url));
}

async function loadBogusDomains(): Promise<{ instance: string; domain: string; redirect_url: string | null }[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deliverability_domains")
    .select("instance, domain, redirect_url")
    .not("redirect_url", "is", null)
    .limit(30000);
  if (error) throw new Error(error.message);
  return ((data || []) as { instance: string; domain: string; redirect_url: string | null }[])
    .filter((r) => isBogusStoredRedirect(r.redirect_url));
}

function tally(items: { redirect_url: string | null; provider?: string }[]) {
  const byValue: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  for (const r of items) {
    const v = String(r.redirect_url);
    byValue[v] = (byValue[v] || 0) + 1;
    if (r.provider) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
  }
  return { byValue, byProvider };
}

export async function GET() {
  try {
    const [orders, domains] = await Promise.all([loadBogusOrders(), loadBogusDomains()]);
    const orderTally = tally(orders);
    return NextResponse.json({
      preview: true,
      orders: {
        total: orders.length,
        byProvider: orderTally.byProvider,
        byValue: orderTally.byValue,
        list: orders.map((r) => ({
          instance: r.instance,
          provider: r.provider,
          domain: r.domain,
          redirect_url: r.redirect_url,
          hasProviderId: !!r.provider_domain_id,
        })),
      },
      deliverabilityDomains: {
        total: domains.length,
        byValue: tally(domains).byValue,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.apply !== true) {
      return NextResponse.json({ error: "POST { apply: true } to execute (GET for a dry-run preview)" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const orders = await loadBogusOrders();

    // Resolve MilkBox ids once for any rows missing provider_domain_id.
    const milkboxByName = new Map<string, string>();
    if (orders.some((r) => r.provider === "milkbox" && !r.provider_domain_id)) {
      try {
        for (const d of await milkbox.listDomains()) milkboxByName.set(d.name.toLowerCase(), d.id);
      } catch { /* leave map empty → those rows skip with "no MilkBox id" */ }
    }

    const results: { instance: string; provider: string; domain: string; status: "fixed" | "skipped" | "failed"; reason?: string }[] = [];
    const key = (r: OrderRow) => ({ instance: r.instance, provider: r.provider, domain: r.domain });

    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < orders.length) {
        const r = orders[idx++];
        try {
          if (r.provider === "inboxing") {
            let id = r.provider_domain_id;
            // Domains live on either Inboxing login — resolve across both.
            let account = toInboxingAccount(r.inboxing_account) ?? DEFAULT_INBOXING_ACCOUNT;
            if (!id) {
              const hit = await inboxing.findDomainAnyAccount(r.domain);
              id = hit?.id ?? null;
              if (hit) account = hit.account;
            }
            if (!id) { results.push({ ...key(r), status: "skipped", reason: "no Inboxing domain id" }); continue; }
            await inboxing.updateRedirect(id, null, account);
          } else if (r.provider === "milkbox") {
            const id = r.provider_domain_id ?? milkboxByName.get(r.domain.toLowerCase()) ?? null;
            if (!id) { results.push({ ...key(r), status: "skipped", reason: "no MilkBox domain id" }); continue; }
            await milkbox.updateRedirect(id, null);
          } else if (r.provider === "scaledmail") {
            await scaledmail.updateRedirect(r.domain, "");
          } else {
            results.push({ ...key(r), status: "skipped", reason: `unknown provider ${r.provider}` });
            continue;
          }
          // Clear the stored value everywhere it lived.
          await supabase.from("inbox_orders").update({ redirect_url: null }).eq("provider", r.provider).eq("domain", r.domain);
          await supabase.from("deliverability_domains").update({ redirect_url: null }).eq("domain", r.domain);
          results.push({ ...key(r), status: "fixed" });
        } catch (e) {
          results.push({ ...key(r), status: "failed", reason: e instanceof Error ? e.message : "error" });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, orders.length) }, () => worker()));

    // Null any remaining bogus deliverability_domains values with no order row —
    // harmless, the redirect-check cron re-resolves the real redirect next pass.
    const domains = await loadBogusDomains();
    let domainsCleared = 0;
    for (const d of domains) {
      const { error } = await supabase
        .from("deliverability_domains")
        .update({ redirect_url: null })
        .eq("instance", d.instance)
        .eq("domain", d.domain);
      if (!error) domainsCleared++;
    }

    const summary = {
      fixed: results.filter((r) => r.status === "fixed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      deliverabilityDomainsCleared: domainsCleared,
    };
    return NextResponse.json({ applied: true, summary, results });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
