import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const WINDOW_MS = 8 * 60 * 60 * 1000;

// POST /api/domains/queue  — enqueue domains for the 20/8h buy queue.
// Body: { domains: string[], source?: "niche"|"lookalike", niche?: string }
// Prices/tld are pulled from the porkbun_domains discovery row. Domains already
// active in the queue (queued/buying/registered) are skipped.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    // { action: "retry-failed" } — put failed rows back in the queue so the
    // drip cron picks them up again. A failure is usually not the domain's
    // fault: Porkbun blocked the whole account for three days in September
    // 2026 and 153 rows failed with "your account is currently unable to
    // register domain names", then needed a hand-written SQL update to come
    // back. The cron only ever claims `queued`, so this is the one thing
    // standing between a cleared outage and buying resuming.
    //
    // Domains already taken are left alone — those are `skipped`, not
    // `failed`, and retrying them would only burn Porkbun calls.
    if (body?.action === "retry-failed") {
      const supabase = getSupabaseAdmin();
      const only: string[] = Array.isArray(body?.domains)
        ? body.domains.filter((d: unknown): d is string => typeof d === "string").map((d: string) => d.trim().toLowerCase())
        : [];
      let q = supabase
        .from("porkbun_buy_queue")
        .update({ status: "queued", batch_id: null, last_error: null, updated_at: new Date().toISOString() })
        .eq("status", "failed");
      if (only.length > 0) q = q.in("domain", only);
      const { data, error } = await q.select("domain");
      if (error) throw new Error(error.message);
      const requeued = (data || []).map((r) => r.domain as string);
      return NextResponse.json({ requeued: requeued.length, domains: requeued.slice(0, 50) });
    }

    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains: string[] = Array.from(
      new Set(
        raw
          .filter((d: unknown): d is string => typeof d === "string")
          .map((d: string) => d.trim().toLowerCase())
          .filter(Boolean)
      )
    );
    if (domains.length === 0) {
      return NextResponse.json({ error: "domains array required" }, { status: 400 });
    }
    const source = body?.source === "lookalike" ? "lookalike" : "niche";
    const niche = typeof body?.niche === "string" ? body.niche.trim() : null;

    const supabase = getSupabaseAdmin();

    // Real prices from discovery.
    const priceByDomain = new Map<string, number | null>();
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      const { data } = await supabase
        .from("porkbun_domains")
        .select("domain, price_usd")
        .in("domain", slice);
      for (const r of data || []) {
        const p = typeof r.price_usd === "number" ? r.price_usd : parseFloat(String(r.price_usd ?? ""));
        priceByDomain.set(r.domain as string, Number.isFinite(p) ? p : null);
      }
    }

    // Skip domains already active in the queue.
    const active = new Set<string>();
    for (let i = 0; i < domains.length; i += 200) {
      const slice = domains.slice(i, i + 200);
      const { data } = await supabase
        .from("porkbun_buy_queue")
        .select("domain")
        .in("domain", slice)
        .in("status", ["queued", "buying", "registered"]);
      for (const r of data || []) active.add(r.domain as string);
    }

    const nowIso = new Date().toISOString();
    const toInsert = domains
      .filter((d) => !active.has(d))
      .map((d) => ({
        domain: d,
        tld: `.${d.split(".").pop()}`,
        real_price_usd: priceByDomain.get(d) ?? null,
        status: "queued",
        source,
        niche,
        requested_at: nowIso,
      }));

    let enqueued = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      const { data, error } = await supabase
        .from("porkbun_buy_queue")
        .insert(toInsert.slice(i, i + 200))
        .select("id");
      if (error) throw new Error(error.message);
      enqueued += data?.length ?? 0;
    }

    return NextResponse.json({ enqueued, skipped: domains.length - toInsert.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/domains/queue — queue status for the UI.
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    const statuses = ["queued", "buying", "registered", "failed", "skipped"] as const;
    const counts: Record<string, number> = {};
    for (const s of statuses) {
      const { count } = await supabase
        .from("porkbun_buy_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      counts[s] = count ?? 0;
    }

    const { data: lastRows } = await supabase
      .from("porkbun_buy_queue")
      .select("purchased_at")
      .eq("status", "registered")
      .order("purchased_at", { ascending: false })
      .limit(1);
    const lastPurchaseAt = lastRows?.[0]?.purchased_at ?? null;
    const lastMs = lastPurchaseAt ? new Date(lastPurchaseAt).getTime() : null;
    const inWindow = lastMs != null && Date.now() - lastMs < WINDOW_MS;
    const nextEligibleAt = inWindow && lastMs != null ? new Date(lastMs + WINDOW_MS).toISOString() : null;

    const { data: recent } = await supabase
      .from("porkbun_buy_queue")
      .select("domain, status, real_price_usd, purchased_at, last_error, requested_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(50);

    return NextResponse.json({
      counts,
      lastPurchaseAt,
      nextEligibleAt,
      inWindow,
      recent: recent || [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
