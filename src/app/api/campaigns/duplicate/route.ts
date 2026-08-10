import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isInstanceSlug } from "@/lib/bison-instances";
import { setRoleIndex } from "@/lib/campaigns/duplication";

// Shared campaign-duplication queue: enqueue (POST), status for the panel (GET),
// item actions retry/skip/skip-tag (PATCH). Draining happens in ./drain.
export const dynamic = "force-dynamic";

const ACTIVE = ["queued", "duplicating", "blocked", "failed"];

interface EnqueueItem { instance: string; source_id: number; source_name: string; client_tag: string; set_role?: string | null }
interface QueueRow {
  id: number; job_id: string; instance: string; client_tag: string; source_id: number; source_name: string;
  set_role: string | null; order_index: number; status: string; new_id: number | null; new_name: string | null;
  error: string | null; attempts: number; submitted_at: string; updated_at: string;
}

// ── POST: enqueue a batch ────────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { items?: EnqueueItem[] };
    const items = (body.items || []).filter((i) => i && isInstanceSlug(i.instance) && i.source_id && i.client_tag);
    if (items.length === 0) return NextResponse.json({ error: "no valid items" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    // Dedupe: skip sources already active in the queue.
    const sourceIds = items.map((i) => i.source_id);
    const { data: existing } = await supabase
      .from("campaign_dup_queue").select("source_id, instance").in("source_id", sourceIds).in("status", ACTIVE);
    const activeKeys = new Set((existing || []).map((r) => `${r.instance}:${r.source_id}`));

    const jobId = `job_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const now = new Date().toISOString();
    const rows = items
      .filter((i) => !activeKeys.has(`${i.instance}:${i.source_id}`))
      .map((i) => ({
        job_id: jobId, instance: i.instance, client_tag: i.client_tag.toUpperCase(),
        source_id: i.source_id, source_name: i.source_name || "", set_role: i.set_role ?? null,
        order_index: setRoleIndex(i.set_role), status: "queued", submitted_at: now, updated_at: now,
      }));
    const skipped = items.length - rows.length;
    if (rows.length === 0) return NextResponse.json({ jobId, enqueued: 0, skipped, message: "all already queued" });

    const { error } = await supabase.from("campaign_dup_queue").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ jobId, enqueued: rows.length, skipped });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

// ── GET: queue status for the panel ──────────────────────────────────────
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    // Active rows (any age) + recently-finished rows (last 24h) for the panel.
    const { data } = await supabase
      .from("campaign_dup_queue").select("*")
      .or(`status.in.(${ACTIVE.join(",")}),updated_at.gte.${since}`)
      .order("submitted_at", { ascending: true })
      .order("client_tag", { ascending: true })
      .order("order_index", { ascending: true });
    const rows = (data || []) as QueueRow[];

    // Group by job → client tag.
    const jobsMap = new Map<string, Map<string, QueueRow[]>>();
    for (const r of rows) {
      if (!jobsMap.has(r.job_id)) jobsMap.set(r.job_id, new Map());
      const tags = jobsMap.get(r.job_id)!;
      const key = `${r.instance}:${r.client_tag}`;
      if (!tags.has(key)) tags.set(key, []);
      tags.get(key)!.push(r);
    }
    const jobs = Array.from(jobsMap.entries()).map(([jobId, tags]) => ({
      jobId,
      submittedAt: tags.values().next().value?.[0]?.submitted_at ?? null,
      tags: Array.from(tags.values()).map((its) => ({
        clientTag: its[0].client_tag, instance: its[0].instance,
        items: its.map((r) => ({ id: r.id, sourceId: r.source_id, sourceName: r.source_name, setRole: r.set_role, status: r.status, newName: r.new_name, error: r.error })),
        counts: countBy(its),
      })),
    }));

    const totals = countBy(rows);
    const current = rows.find((r) => r.status === "duplicating") || null;
    const remaining = rows.filter((r) => r.status === "queued").length;
    return NextResponse.json({ jobs, totals, remaining, current: current ? { clientTag: current.client_tag, sourceName: current.source_name } : null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

// ── PATCH: item actions (retry / skip / skip-tag / dismiss-done) ──────────
export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string; id?: number; jobId?: string; clientTag?: string; instance?: string };
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    if (body.action === "retry" && body.id) {
      // Re-queue this failed item, and unblock its tag's blocked items.
      const { data: item } = await supabase.from("campaign_dup_queue").select("*").eq("id", body.id).single();
      if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
      await supabase.from("campaign_dup_queue").update({ status: "queued", error: null, updated_at: now }).eq("id", body.id);
      await supabase.from("campaign_dup_queue").update({ status: "queued", updated_at: now })
        .eq("job_id", item.job_id).eq("instance", item.instance).eq("client_tag", item.client_tag).eq("status", "blocked");
      return NextResponse.json({ ok: true });
    }
    if (body.action === "skip" && body.id) {
      const { data: item } = await supabase.from("campaign_dup_queue").select("*").eq("id", body.id).single();
      if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
      await supabase.from("campaign_dup_queue").update({ status: "skipped", updated_at: now }).eq("id", body.id);
      // Skipping the blocker unblocks the rest of the tag.
      await supabase.from("campaign_dup_queue").update({ status: "queued", updated_at: now })
        .eq("job_id", item.job_id).eq("instance", item.instance).eq("client_tag", item.client_tag).eq("status", "blocked");
      return NextResponse.json({ ok: true });
    }
    if (body.action === "skip-tag" && body.jobId && body.clientTag) {
      await supabase.from("campaign_dup_queue").update({ status: "skipped", updated_at: now })
        .eq("job_id", body.jobId).eq("client_tag", body.clientTag.toUpperCase()).in("status", ["queued", "blocked", "failed"]);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "dismiss-done") {
      // Clear finished rows from the panel (does not touch active ones).
      await supabase.from("campaign_dup_queue").delete().in("status", ["done", "skipped"]);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

function countBy(rows: { status: string }[]) {
  const c = { total: rows.length, queued: 0, duplicating: 0, done: 0, failed: 0, blocked: 0, skipped: 0 } as Record<string, number>;
  for (const r of rows) if (r.status in c) c[r.status]++;
  return c;
}
