import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import type { InboxOrder, ProviderStatusResult } from "@/types/inbox-order";

export const maxDuration = 60;

async function refresh(order: InboxOrder): Promise<ProviderStatusResult & { providerDomainId?: string | null }> {
  if (order.provider === "scaledmail") {
    if (!order.provider_order_id) {
      return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
    }
    return scaledmail.getOrderStatus(order.provider_order_id, order.domain);
  }
  if (order.provider === "milkbox") {
    if (!order.provider_order_id) {
      return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
    }
    const r = await milkbox.getOrderStatus(order.provider_order_id);
    return { ...r, providerDomainId: r.domainId };
  }
  if (!order.provider_domain_id) {
    return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
  }
  return inboxing.getDomainStatus(order.provider_domain_id);
}

export async function GET() {
  const startedAt = Date.now();
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from("inbox_orders")
    .select("*")
    .in("status", ["pending", "swapping", "deleting"])
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(100);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let refreshed = 0;
  let failed = 0;
  for (const row of rows || []) {
    if (Date.now() - startedAt > 50000) break;
    try {
      const r = await refresh(row as InboxOrder);
      const update: Record<string, unknown> = {
        status: r.status,
        provider_status_raw: r.rawStatus,
        setup_stage: r.setupStage,
        failure_reason: r.failureReason,
        last_checked_at: new Date().toISOString(),
      };
      if (r.completed && r.status === "active" && !row.completed_at) {
        update.completed_at = new Date().toISOString();
      }
      if (r.providerDomainId && !row.provider_domain_id) {
        update.provider_domain_id = r.providerDomainId;
      }
      await supabase.from("inbox_orders").update(update).eq("id", row.id);
      refreshed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : "Unknown";
      await supabase
        .from("inbox_orders")
        .update({
          last_checked_at: new Date().toISOString(),
          failure_reason: msg.slice(0, 500),
        })
        .eq("id", row.id);
    }
  }

  return NextResponse.json({ refreshed, failed, total: rows?.length || 0 });
}
