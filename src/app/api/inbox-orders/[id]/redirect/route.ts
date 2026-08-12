import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as scaledmail from "@/lib/scaledmail";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { DEFAULT_INBOXING_ACCOUNT } from "@/lib/inboxing-accounts";
import type { InboxOrder } from "@/types/inbox-order";

export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const newRedirect = typeof body?.redirectUrl === "string" ? body.redirectUrl.trim() : "";

    if (!newRedirect || !/^https?:\/\/.+/i.test(newRedirect)) {
      return NextResponse.json({ error: "Invalid redirectUrl (must start with http:// or https://)" }, { status: 400 });
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
      await scaledmail.updateRedirect(typed.domain, newRedirect);
    } else if (typed.provider === "milkbox") {
      if (!typed.provider_domain_id) {
        return NextResponse.json(
          { error: "MilkBox domain id not yet known — refresh first" },
          { status: 400 }
        );
      }
      await milkbox.updateRedirect(typed.provider_domain_id, newRedirect);
    } else {
      if (!typed.provider_domain_id) {
        return NextResponse.json({ error: "Inboxing domain id missing" }, { status: 400 });
      }
      await inboxing.updateRedirect(typed.provider_domain_id, newRedirect, typed.inboxing_account ?? DEFAULT_INBOXING_ACCOUNT);
    }

    const { data: updated, error: updateErr } = await supabase
      .from("inbox_orders")
      .update({ redirect_url: newRedirect })
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
