import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { generateAliases } from "@/lib/inbox-order-aliases";
import type { InboxOrder } from "@/types/inbox-order";

export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const newDomain = typeof body?.newDomain === "string" ? body.newDomain.trim().toLowerCase() : "";

    if (!newDomain || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(newDomain)) {
      return NextResponse.json({ error: "Invalid newDomain" }, { status: 400 });
    }

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

    const typed = order as InboxOrder;

    if (typed.provider === "scaledmail") {
      await scaledmail.swapDomain(typed.domain, newDomain);
      // Mark the old row as swapped, no new row needed — SM does in-place swap.
      const { data: updated, error: updateErr } = await supabase
        .from("inbox_orders")
        .update({
          status: "swapping",
          domain: newDomain,
          flagged_at: null,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (updateErr) throw new Error(updateErr.message);
      return NextResponse.json({ order: updated });
    }

    if (typed.provider === "milkbox") {
      if (!typed.provider_domain_id) {
        return NextResponse.json(
          { error: "MilkBox domain id not yet known — refresh first" },
          { status: 400 }
        );
      }
      await milkbox.swapDomain(typed.provider_domain_id, newDomain);
      const { data: updated, error: updateErr } = await supabase
        .from("inbox_orders")
        .update({
          status: "swapping",
          domain: newDomain,
          flagged_at: null,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (updateErr) throw new Error(updateErr.message);
      return NextResponse.json({ order: updated });
    }

    // Inboxing: emulate swap as delete + create
    if (typed.provider_domain_id) {
      try {
        await inboxing.deleteDomain(typed.provider_domain_id);
      } catch {
        // ignore delete errors; we still want to create the replacement
      }
    }
    const aliases = await generateAliases("inboxing", typed.mailbox_count);
    const created = await inboxing.createDomain({
      domain: newDomain,
      redirectUrl: typed.redirect_url || "",
      aliases,
    });
    // Mark old row deleted, insert new row as the replacement.
    await supabase.from("inbox_orders").update({ status: "swapped" }).eq("id", id);
    const { data: inserted, error: insertErr } = await supabase
      .from("inbox_orders")
      .insert({
        provider: "inboxing",
        provider_domain_id: created.domainId,
        provider_status_raw: created.raw.status || null,
        domain: newDomain,
        redirect_url: typed.redirect_url,
        mailbox_count: typed.mailbox_count,
        tag: typed.tag,
        company_name: typed.company_name,
        client_tag: typed.client_tag,
        status: "pending",
        aliases,
        parent_order_id: typed.id,
      })
      .select("*")
      .single();
    if (insertErr) throw new Error(insertErr.message);
    return NextResponse.json({ order: inserted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
