import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * GET /api/conform-tag-log
 *   Returns the most recent Conform Tags batches (newest first) summarised
 *   for the Settings page "Tag Conformance Log" card.
 *
 * GET /api/conform-tag-log?batch=<uuid>
 *   Returns every event row for a single batch — for the per-batch CSV
 *   download / inline list expansion.
 */

interface EventRow {
  id: number;
  applied_at: string;
  batch_id: string;
  instance: string;
  sender_id: number;
  sender_email: string | null;
  domain: string | null;
  tag_id: number | null;
  tag_name: string;
  status: string;
  error: string | null;
}

export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);
    const batch = searchParams.get("batch");

    if (batch) {
      const { data, error } = await supabase
        .from("conform_tag_events")
        .select("*")
        .eq("batch_id", batch)
        .order("applied_at", { ascending: true })
        .limit(5000);
      if (error) throw new Error(error.message);
      return NextResponse.json({ batchId: batch, events: data ?? [] });
    }

    // Recent rows; we aggregate into batch summaries in JS rather than SQL
    // so we don't need a separate RPC. 2000 rows ~= last 20-40 batches typically.
    const { data, error } = await supabase
      .from("conform_tag_events")
      .select("applied_at, batch_id, instance, sender_id, tag_name, status")
      .order("applied_at", { ascending: false })
      .limit(2000);
    if (error) {
      // Table likely missing — return empty so the UI can show a graceful hint.
      return NextResponse.json({ batches: [], note: error.message });
    }

    type Summary = {
      batchId: string;
      startedAt: string;
      finishedAt: string;
      instances: string[];
      attachmentsOk: number;
      attachmentsFailed: number;
      senderCount: number;
      tagsCount: number;
    };

    const byBatch = new Map<string, {
      startedAt: string;
      finishedAt: string;
      instances: Set<string>;
      ok: number;
      failed: number;
      senders: Set<number>;
      tags: Set<string>;
    }>();

    for (const r of (data ?? []) as EventRow[]) {
      let g = byBatch.get(r.batch_id);
      if (!g) {
        g = {
          startedAt: r.applied_at,
          finishedAt: r.applied_at,
          instances: new Set(),
          ok: 0,
          failed: 0,
          senders: new Set(),
          tags: new Set(),
        };
        byBatch.set(r.batch_id, g);
      }
      // applied_at is ordered desc, so the first row we see for a batch is its
      // finish time; the last row we see is the start.
      g.startedAt = r.applied_at;
      g.instances.add(r.instance);
      if (r.status === "ok") g.ok++;
      else g.failed++;
      g.senders.add(r.sender_id);
      g.tags.add(r.tag_name);
    }

    const batches: Summary[] = [...byBatch.entries()]
      .map(([batchId, g]) => ({
        batchId,
        startedAt: g.startedAt,
        finishedAt: g.finishedAt,
        instances: [...g.instances].sort(),
        attachmentsOk: g.ok,
        attachmentsFailed: g.failed,
        senderCount: g.senders.size,
        tagsCount: g.tags.size,
      }))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
      .slice(0, 50);

    return NextResponse.json({ batches });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
