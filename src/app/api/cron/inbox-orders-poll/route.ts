import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount, inboxingConnectionFor } from "@/lib/inboxing-accounts";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
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
  return inboxing.getDomainStatus(order.provider_domain_id, order.inboxing_account ?? DEFAULT_INBOXING_ACCOUNT);
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
        // Inboxing: going active is the moment the domain can be uploaded to
        // its Bison instance. The create call never passes a platform
        // connection (the 291-domain 2026-08-12 batch sat "active" with
        // nothing in Bison — Ramon/Spencer), so upload here, to the instance
        // the order was placed for. inbox-orders-upload retries/verifies hourly.
        if (row.provider === "inboxing" && row.provider_domain_id && isInstanceSlug(row.instance)) {
          try {
            const account = toInboxingAccount(row.inboxing_account) ?? DEFAULT_INBOXING_ACCOUNT;
            // Per-account connection (the Premium login has its own four).
            const connection = inboxingConnectionFor(row.instance as BisonInstanceSlug, account);
            if (!connection) throw new Error(`no Inboxing platform connection for ${row.instance} on the ${account} account`);
            await inboxing.uploadDomainToPlatform(row.provider_domain_id, connection, account);
            update.setup_stage = "bison_upload_queued";
          } catch (e) {
            update.setup_stage = "bison_upload_failed";
            update.failure_reason = (e instanceof Error ? e.message : "upload failed").slice(0, 500);
          }
        }
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
