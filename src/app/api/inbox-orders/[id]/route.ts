import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as milkbox from "@/lib/milkbox";
import * as inboxing from "@/lib/inboxing";
import { DEFAULT_INBOXING_ACCOUNT } from "@/lib/inboxing-accounts";
import type { InboxOrder } from "@/types/inbox-order";

export const maxDuration = 30;

// DELETE removes the underlying provider resource. For ScaledMail (which has no
// per-domain delete) the dedicated /swap endpoint should be used instead — this
// endpoint will reject ScaledMail rows. Spencer's preference (Q1=A) is to use
// the UI's Swap button for ScaledMail.
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
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

    const typed = order as InboxOrder;

    if (typed.provider === "scaledmail") {
      return NextResponse.json(
        { error: "ScaledMail has no per-domain delete — use Swap instead" },
        { status: 400 }
      );
    }

    if (typed.provider === "milkbox") {
      if (!typed.provider_domain_id) {
        return NextResponse.json(
          { error: "MilkBox domain id not yet known — refresh first" },
          { status: 400 }
        );
      }
      await milkbox.deleteDomain(typed.provider_domain_id);
    } else {
      if (!typed.provider_domain_id) {
        return NextResponse.json({ error: "Inboxing domain id missing" }, { status: 400 });
      }
      await inboxing.deleteDomain(typed.provider_domain_id, typed.inboxing_account ?? DEFAULT_INBOXING_ACCOUNT);
    }

    const { data: updated, error: updateErr } = await supabase
      .from("inbox_orders")
      .update({ status: "deleting", last_checked_at: new Date().toISOString() })
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
