import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ domain: string }> }
) {
  try {
    const { domain } = await params;
    const { warmup_status } = await request.json();
    if (!["open", "done"].includes(warmup_status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("deliverability_domains")
      .update({ warmup_status })
      .eq("domain", decodeURIComponent(domain));
    if (error) throw error;

    // Actor audit — this tick masqueraded as "warmup complete" for days with
    // no record of who set it (Spencer 2026-09-03). Best-effort only.
    try {
      const { cookies } = await import("next/headers");
      const { createServerSupabaseClient } = await import("@/lib/supabase");
      const { logEvents } = await import("@/lib/replacement/store");
      const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
      await logEvents([{
        domain: decodeURIComponent(domain),
        eventType: "mode_changed",
        detail: `warmup mark set to ${warmup_status} by ${user?.email ?? "unknown user"}`,
        signals: { warmup_status, actor: user?.email ?? null },
      }]);
    } catch (e) { console.error("[warmup-status] actor log failed:", e); }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
