import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, isInstanceSlug } from "@/lib/bison-instances";
import {
  buildBatches,
  checkOverdueAfterMs,
  type BatchRow,
  type BisonPresence,
  type LaterOrder,
} from "@/lib/inbox-order-batches";
import type { InboxOrderStatus } from "@/types/inbox-order";

export const maxDuration = 60;

// GET /api/inbox-orders/batches?instances=<csv>
//
// Inbox orders grouped the way they were placed — one row per submission with
// ordered / live / failed / missing counts — instead of one row per domain
// (Nick, 2026-09-30: "I would prefer that it just shows 1 single order instead
// of every domain as a separate order along with the number that errored out").
// Read-only.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instancesParam = searchParams.get("instances");
    const instances = instancesParam
      ? instancesParam.split(",").map((s) => s.trim()).filter(isInstanceSlug)
      : [...ALL_INSTANCE_SLUGS];
    const scoped = instances.length > 0 ? instances : [...ALL_INSTANCE_SLUGS];
    const supabase = getSupabaseAdmin();

    // Every row, not the domain list's newest 500: an order straddling that
    // cutoff would otherwise read short.
    const rows: BatchRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("inbox_orders")
        .select("id, provider, instance, inboxing_account, status, setup_stage, failure_reason, domain, mailbox_count, created_at, completed_at, last_checked_at")
        .in("instance", scoped)
        .order("created_at", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as BatchRow[]));
      if (data.length < 1000) break;
    }

    // Mailboxes in Bison per the last deliverability sync, in EVERY instance:
    // domains get moved between instances after they land (40 active orders
    // on 2026-09-30 live somewhere other than where they were ordered).
    const domains = [...new Set(rows.map((r) => r.domain))];
    const inBison = new Map<string, BisonPresence[]>();
    for (let i = 0; i < domains.length; i += 200) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, inbox_count, synced_at")
        .in("domain", domains.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const d of data || []) {
        const mailboxes = (d.inbox_count as number | null) ?? 0;
        if (mailboxes <= 0) continue; // an empty row is a move in flight, not a landing
        const list = inBison.get(d.domain as string) ?? [];
        list.push({ instance: d.instance as string, mailboxes, syncedAt: (d.synced_at as string | null) ?? null });
        inBison.set(d.domain as string, list);
      }
    }

    // A failed domain is often ordered again later, sometimes for another
    // instance — look across all of them so that one reads "ordered again",
    // not "failed".
    const failedDomains = [...new Set(rows.filter((r) => r.status === "failed").map((r) => r.domain))];
    const laterOrders = new Map<string, LaterOrder[]>();
    for (let i = 0; i < failedDomains.length; i += 200) {
      const { data, error } = await supabase
        .from("inbox_orders")
        .select("domain, instance, status, created_at")
        .in("domain", failedDomains.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const o of data || []) {
        const list = laterOrders.get(o.domain as string) ?? [];
        list.push({ instance: o.instance as string, status: o.status as InboxOrderStatus, created_at: o.created_at as string });
        laterOrders.set(o.domain as string, list);
      }
    }

    // The poll cron walks every instance's pending orders together, 100 per
    // run, so the backlog it is working through is global.
    const { count: pendingAll, error: countErr } = await supabase
      .from("inbox_orders")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "swapping", "deleting"]);
    if (countErr) throw new Error(countErr.message);

    const batches = buildBatches(rows, inBison, laterOrders, {
      checkOverdueMs: checkOverdueAfterMs(pendingAll ?? 0),
      instanceLabel: (slug) => (isInstanceSlug(slug) ? BISON_INSTANCES[slug].label : slug),
    });

    return NextResponse.json({ batches, generatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
