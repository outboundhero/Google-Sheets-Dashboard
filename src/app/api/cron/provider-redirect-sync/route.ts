import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { listDomainsWithLifecycle, configuredInboxingAccounts } from "@/lib/inboxing";

export const maxDuration = 300;

// GET /api/cron/provider-redirect-sync — hourly: for every Inboxing domain,
// record the redirect Inboxing has CONFIGURED as the domain's redirect_url.
//
// Why (2026-08-27): Inboxing redirects are masked by default (Cloudflare
// proxies the destination), so the hourly HTTP redirect-check gets a 200
// page with no Location header and records "no redirect". 553 client-tagged
// Inboxing domains read that way while Inboxing had the right redirect on
// every one probed — and redirect-conform kept "fixing" them daily. For
// Inboxing domains the provider config IS the truth; the HTTP walk stays the
// truth for MilkBox/ScaledMail (plain redirects), and redirect-check now
// leaves Inboxing-tagged rows to this sync.
//
// ~60 paginated list calls per Inboxing login (both logins), no per-domain
// calls. ?dry=1 reports without writing.

export async function GET(request: Request) {
  try {
    const dryRun = new URL(request.url).searchParams.get("dry") === "1";
    const supabase = getSupabaseAdmin();

    // Provider truth: domain name → configured redirect, across both logins.
    const provider = new Map<string, string | null>();
    const perAccount: Record<string, number> = {};
    for (const account of configuredInboxingAccounts()) {
      try {
        const list = await listDomainsWithLifecycle(account);
        perAccount[account] = list.length;
        for (const d of list) provider.set(d.name.toLowerCase(), d.redirectUrl);
      } catch (e) {
        perAccount[account] = -1;
        console.error(`[provider-redirect-sync] ${account} list failed:`, e);
      }
    }
    if (provider.size === 0) {
      return NextResponse.json({ error: "no Inboxing domains listed (keys missing or API down)", perAccount }, { status: 502 });
    }

    // Our Inboxing-tagged rows, all instances.
    interface Row { instance: string; domain: string; tags: string[] | null; redirect_url: string | null }
    const rows: Row[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags, redirect_url")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as Row[]) {
        if ((r.tags || []).some((t) => String(t).trim().toLowerCase().startsWith("inboxing"))) rows.push(r);
      }
      if (data.length < 1000) break;
    }

    const now = new Date().toISOString();
    const updates: { instance: string; domain: string; redirect_url: string | null; redirect_checked_at: string }[] = [];
    let unchanged = 0, notAtProvider = 0;
    for (const r of rows) {
      const key = r.domain.toLowerCase();
      if (!provider.has(key)) { notAtProvider++; continue; }
      const configured = provider.get(key) ?? null;
      if ((r.redirect_url || null) === configured) { unchanged++; continue; }
      updates.push({ instance: r.instance, domain: r.domain, redirect_url: configured, redirect_checked_at: now });
    }

    if (!dryRun) {
      for (let i = 0; i < updates.length; i += 200) {
        const { error } = await supabase
          .from("deliverability_domains")
          .upsert(updates.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }
    }

    return NextResponse.json({
      dryRun,
      providerDomains: provider.size,
      perAccount,
      inboxingRows: rows.length,
      updated: updates.length,
      unchanged,
      notAtProvider,
      sample: updates.slice(0, 10),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "provider-redirect-sync failed" }, { status: 500 });
  }
}
