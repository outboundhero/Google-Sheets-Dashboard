import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";
import { endWindow, getOpenWindow } from "@/lib/sending-mode/windows";

export const maxDuration = 300;

// POST /api/performance/throttle  { clientTag, action: "pause" | "resume" | "release" }
//
//   pause    auto-throttle leaves this client alone (and releases an active throttle)
//   resume   auto-throttle may act on them again from the next daily pass
//   release  end the current throttle window now, restoring recorded limits
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { clientTag?: string; action?: string };
    const clientTag = String(body.clientTag || "").trim().toUpperCase();
    const action = body.action;
    if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

    const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
    const actor = user?.email ?? "unknown user";
    const supabase = getSupabaseAdmin();

    if (action === "pause" || action === "resume") {
      const { error } = await supabase.from("client_sending_prefs").upsert(
        { client_tag: clientTag, auto_throttle_paused: action === "pause", updated_by: actor, updated_at: new Date().toISOString() },
        { onConflict: "client_tag" },
      );
      if (error) throw new Error(error.message);
      let released = null;
      if (action === "pause") {
        const open = await getOpenWindow(clientTag, "throttle");
        if (open) released = await endWindow(open.id, "auto_throttle_paused", { budgetMs: 230_000 });
      }
      return NextResponse.json({ ok: true, paused: action === "pause", released });
    }

    if (action === "release") {
      const open = await getOpenWindow(clientTag, "throttle");
      if (!open) return NextResponse.json({ error: `${clientTag} is not throttled` }, { status: 404 });
      const r = await endWindow(open.id, "released", { budgetMs: 230_000 });
      return NextResponse.json({ ok: true, ...r });
    }

    return NextResponse.json({ error: "action must be pause | resume | release" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
