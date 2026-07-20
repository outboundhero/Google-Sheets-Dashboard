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
