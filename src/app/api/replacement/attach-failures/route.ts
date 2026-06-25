import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;

// GET /api/replacement/attach-failures — recent "attach incomplete" flags from
// the replacement automation, grouped by client tag, for the main dashboard.
// These are partial attaches (some inboxes couldn't be added to a campaign) that
// the engine refused to report as success. Admin-only via middleware.
//
// Window defaults to 5 days (the replacement cadence). A client drops off once
// no fresh attach-incomplete event lands inside the window — i.e. once a later
// run/retry attaches cleanly and stops emitting the flag.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(30, Math.max(1, parseInt(searchParams.get("days") || "5", 10)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("replacement_events")
      .select("instance, client_tag, detail, signals, created_at")
      .eq("event_type", "error")
      .contains("signals", { kind: "attach_incomplete" })
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    // Group by client tag, keeping the most recent flag per (tag, campaign).
    interface Flag { instance: string | null; campaign: string; failed: number; rateLimited: number; newlyAttached: number; detail: string; at: string }
    const byTag = new Map<string, Flag[]>();
    const seen = new Set<string>();
    for (const r of data || []) {
      const sig = (r.signals || {}) as Record<string, unknown>;
      const tag = (r.client_tag || "—") as string;
      const campaign = String(sig.campaign ?? "");
      const dedupeKey = `${tag}:${campaign}`;
      if (seen.has(dedupeKey)) continue; // first = most recent (ordered desc)
      seen.add(dedupeKey);
      const list = byTag.get(tag) || [];
      list.push({
        instance: r.instance,
        campaign,
        failed: Number(sig.failed ?? 0),
        rateLimited: Number(sig.rateLimited ?? 0),
        newlyAttached: Number(sig.newlyAttached ?? 0),
        detail: r.detail || "",
        at: r.created_at,
      });
      byTag.set(tag, list);
    }

    const clients = [...byTag.entries()]
      .map(([clientTag, flags]) => ({
        clientTag,
        instance: flags[0]?.instance ?? null,
        totalSkipped: flags.reduce((s, f) => s + f.failed, 0),
        totalRateLimited: flags.reduce((s, f) => s + f.rateLimited, 0),
        campaigns: flags,
        lastAt: flags.reduce((m, f) => (f.at > m ? f.at : m), flags[0]?.at || since),
      }))
      .sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));

    return NextResponse.json({ clients, days });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
