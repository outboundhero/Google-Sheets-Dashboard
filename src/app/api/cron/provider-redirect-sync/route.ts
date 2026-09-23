import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { listDomainsWithLifecycle, configuredInboxingAccounts } from "@/lib/inboxing";
import { listDomainsWithLifecycle as milkboxList, milkboxRawGet } from "@/lib/milkbox";

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
// Extended to MilkBox 2026-09-23: Cloudflare answers our HTTP walk on
// MilkBox-fronted domains with a 403 challenge, so those rows read as "no
// redirect" too (401 of the 735 blanked rows). MilkBox is the truth for its
// own domains exactly as Inboxing is. The list endpoint carries redirect_url
// on newer accounts; where it doesn't, we fall back to per-domain GETs for
// the rows we actually need, budgeted so the cron still finishes.
//
// ~60 paginated list calls per Inboxing login (both logins) plus one MilkBox
// list walk. ?dry=1 reports without writing.

const MILKBOX_PROBE_BUDGET_MS = 120_000;
const MILKBOX_PROBE_CAP = 400;

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
      if ((r.redirect_url || null) === configured) { unchanged++; }
      // Verified-unchanged rows get their checked_at stamped too. Skipping them
      // left ~2k Inboxing rows with ancient timestamps permanently occupying
      // redirect-check's oldest-first window, which starved the HTTP walker
      // down to ~6 domains/run (found 2026-09-04).
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

    // ---- MilkBox ------------------------------------------------------
    // Same idea, separate provider. Only rows whose stored redirect is blank
    // or differs are probed, so a settled fleet costs one list walk.
    const mb = { listed: 0, rows: 0, updated: 0, unchanged: 0, notAtProvider: 0, probed: 0, probeFailed: 0, error: null as string | null };
    const mbUpdates: typeof updates = [];
    try {
      const listed = await milkboxList();
      mb.listed = listed.length;
      const byName = new Map(listed.map((d) => [d.name.toLowerCase(), d]));

      const mbRows: Row[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase
          .from("deliverability_domains")
          .select("instance, domain, tags, redirect_url")
          .order("domain", { ascending: true })
          .range(off, off + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const r of data as Row[]) {
          if ((r.tags || []).some((t) => String(t).trim().toLowerCase().startsWith("milkbox"))) mbRows.push(r);
        }
        if (data.length < 1000) break;
      }
      mb.rows = mbRows.length;

      const probeStart = Date.now();
      for (const r of mbRows) {
        const hit = byName.get(r.domain.toLowerCase());
        if (!hit) { mb.notAtProvider++; continue; }
        let configured = hit.redirectUrl;
        if (configured === undefined) {
          // List didn't report it. Probe only rows we have no redirect for —
          // those are the ones the HTTP walk could not see.
          if (r.redirect_url) { mb.unchanged++; continue; }
          if (mb.probed >= MILKBOX_PROBE_CAP || Date.now() - probeStart > MILKBOX_PROBE_BUDGET_MS) continue;
          mb.probed++;
          try {
            const res = await milkboxRawGet(`/domains/${encodeURIComponent(hit.id)}`);
            const body = res.body as { data?: { redirect_url?: string | null } } | null;
            configured = body?.data?.redirect_url ?? null;
          } catch { mb.probeFailed++; continue; }
        }
        if ((r.redirect_url || null) === (configured || null)) { mb.unchanged++; continue; }
        mb.updated++;
        mbUpdates.push({ instance: r.instance, domain: r.domain, redirect_url: configured ?? null, redirect_checked_at: now });
      }

      if (!dryRun && mbUpdates.length > 0) {
        for (let i = 0; i < mbUpdates.length; i += 200) {
          const { error } = await supabase
            .from("deliverability_domains")
            .upsert(mbUpdates.slice(i, i + 200), { onConflict: "instance,domain", ignoreDuplicates: false });
          if (error) throw new Error(error.message);
        }
      }
    } catch (e) {
      // MilkBox trouble must not lose the Inboxing half, which is already written.
      mb.error = e instanceof Error ? e.message : "milkbox sync failed";
      console.error("[provider-redirect-sync] milkbox:", mb.error);
    }

    return NextResponse.json({
      dryRun,
      providerDomains: provider.size,
      perAccount,
      inboxingRows: rows.length,
      updated: updates.length,
      unchanged,
      notAtProvider,
      milkbox: mb,
      sample: updates.slice(0, 10),
      milkboxSample: mbUpdates.slice(0, 10),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "provider-redirect-sync failed" }, { status: 500 });
  }
}
