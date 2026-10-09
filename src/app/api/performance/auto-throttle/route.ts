import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";
import { setAutoThrottleEnabled } from "@/lib/sending-mode/config";
import { logEvents } from "@/lib/replacement/store";

// POST /api/performance/auto-throttle  { enabled: boolean }
//
// The auto-throttle on/off switch on the Performance tab (admins only — the
// middleware keeps viewers off /api/performance). On: the next daily pass may
// throttle clients. Off: nobody new is throttled; clients already throttled
// still come off by the normal rules or the Release button.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled (true | false) required" }, { status: 400 });

    const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
    const actor = user?.email ?? "unknown user";
    const settings = await setAutoThrottleEnabled(body.enabled, actor);

    // Same audit trail the rest of the automation writes to.
    await logEvents([{ eventType: "proposed", detail: `auto-throttle switched ${body.enabled ? "ON" : "OFF"} by ${actor}` }]).catch(() => {});

    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
