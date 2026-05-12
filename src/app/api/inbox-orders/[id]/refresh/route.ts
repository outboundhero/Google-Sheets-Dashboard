import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import type { InboxOrder, ProviderStatusResult } from "@/types/inbox-order";

export const maxDuration = 30;

async function refreshOrder(order: InboxOrder): Promise<ProviderStatusResult & { providerDomainId?: string | null }> {
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
  // inboxing
  if (!order.provider_domain_id) {
    return { status: "pending", rawStatus: null, setupStage: null, failureReason: null, completed: false };
  }
  return inboxing.getDomainStatus(order.provider_domain_id);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdmin();
    const { data: order, error: readErr } = await supabase
      .from("inbox_orders")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const result = await refreshOrder(order as InboxOrder);

    const update: Record<string, unknown> = {
      status: result.status,
      provider_status_raw: result.rawStatus,
      setup_stage: result.setupStage,
      failure_reason: result.failureReason,
      last_checked_at: new Date().toISOString(),
    };
    if (result.completed && result.status === "active" && !order.completed_at) {
      update.completed_at = new Date().toISOString();
    }
    if (result.providerDomainId && !order.provider_domain_id) {
      update.provider_domain_id = result.providerDomainId;
    }

    const { data: updated, error: updateErr } = await supabase
      .from("inbox_orders")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (updateErr) throw new Error(updateErr.message);

    return NextResponse.json({ order: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
