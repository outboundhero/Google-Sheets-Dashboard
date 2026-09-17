import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

const VALID_ACTIONS = ["resume", "pause", "archive"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { action } = await request.json();

    if (!VALID_ACTIONS.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}` },
        { status: 400 }
      );
    }

    const res = await bisonFetch(instance, `/campaigns/${id}/${action}`, {
      method: "PATCH",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `EmailBison returned ${res.status}: ${text}` },
        { status: res.status }
      );
    }

    // Who flipped what, when — JPDET (2026-09-17) went active with nobody able
    // to say from where. Best-effort, never blocks the action.
    try {
      const { cookies } = await import("next/headers");
      const { createServerSupabaseClient } = await import("@/lib/supabase");
      const { logEvents } = await import("@/lib/replacement/store");
      const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
      await logEvents([{
        instance,
        eventType: "proposed",
        detail: `campaign ${action} by ${user?.email ?? "unknown user"}: campaign #${id} on ${instance}`,
        signals: { kind: "campaign_status", action, campaignId: id, actor: user?.email ?? null },
      }]);
    } catch (e) { console.error("[campaigns/status] actor log failed:", e); }

    return NextResponse.json({ success: true, action, instance });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
