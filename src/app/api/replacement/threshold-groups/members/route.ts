import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { segmentForTags } from "@/lib/replacement/threshold-groups";
import { classificationFromName } from "@/lib/campaigns/stage";

// GET /api/replacement/threshold-groups/members — which ACTIVE client tags
// each threshold segment governs, using the saved config and the same
// matcher the detector uses (segmentForTags: explicit tag first, otherwise the
// default). Spencer 2026-10-07: "I don't know right now what client tags are
// belonging to them" — he searched for JPPS and the default segment, which
// lists no tags, gave him nothing.
//
// Also returns the active clients sitting in the cleaning default whose
// campaign names say otherwise ("(OS)", "(Non-Cleaning Client)",
// "(Internal)") — the ones likely to need their own segment.

export interface SegmentMembersResponse {
  activeCount: number;
  members: Record<string, string[]>;   // segment id → client tags
  mismatched: { clientTag: string; label: string }[];
}

export async function GET() {
  try {
    const [tracker, cfg] = await Promise.all([getClientTrackerData(), getThresholdConfig()]);
    const active = [...new Set(
      tracker
        .filter((r) => /active/i.test(r.status) && r.clientAbbr)
        .map((r) => r.clientAbbr.trim().toUpperCase()),
    )].sort();

    // Campaign-name label per client tag (majority over non-archived campaigns).
    const labels = new Map<string, Record<string, number>>();
    const supabase = getSupabaseAdmin();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("campaigns").select("client_tag, name, status").order("id").range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const c of (data || []) as { client_tag: string | null; name: string; status: string | null }[]) {
        if (!c.client_tag || String(c.status || "").toLowerCase() === "archived") continue;
        const label = classificationFromName(c.name);
        if (!label) continue;
        const tag = c.client_tag.trim().toUpperCase();
        const m = labels.get(tag) ?? {};
        m[label] = (m[label] || 0) + 1;
        labels.set(tag, m);
      }
      if (!data || data.length < 1000) break;
    }
    const topLabel = (tag: string): string | null => {
      const m = labels.get(tag);
      if (!m) return null;
      return Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
    };

    const members: Record<string, string[]> = {};
    for (const s of cfg.segments) members[s.id] = [];
    const mismatched: SegmentMembersResponse["mismatched"] = [];
    for (const tag of active) {
      const seg = segmentForTags(new Set([tag]), cfg.segments);
      if (!seg) continue;
      members[seg.id].push(tag);
      const label = topLabel(tag);
      if (seg.isDefault && label && label !== "Cleaning") mismatched.push({ clientTag: tag, label });
    }

    return NextResponse.json({ activeCount: active.length, members, mismatched } satisfies SegmentMembersResponse);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
