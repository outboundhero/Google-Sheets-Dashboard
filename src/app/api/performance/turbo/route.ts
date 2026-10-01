import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";
import { endWindow, getOpenWindow, loadClientAccounts, startWindow } from "@/lib/sending-mode/windows";
import { getSendingModeSettings } from "@/lib/sending-mode/config";

export const maxDuration = 300;

// POST /api/performance/turbo  { clientTag, action: "preview" | "activate" | "cancel" }
//
//   preview   account count + end date for the confirmation prompt (no changes)
//   activate  open a Turbo window — snapshot, apply 5 warm-up / 8 sending, 15 days
//   cancel    end it now; every account goes back to what it had
//
// Built so the same startWindow() can be called from a scheduled job later
// (spec: "the Turbo action can be called from a scheduled job, not only from
// the button") — this route is just the button.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { clientTag?: string; action?: string };
    const clientTag = String(body.clientTag || "").trim().toUpperCase();
    const action = body.action;
    if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });

    const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
    const actor = user?.email ?? "unknown user";

    if (action === "preview") {
      const [settings, accounts, open] = await Promise.all([
        getSendingModeSettings(), loadClientAccounts(clientTag, false), getOpenWindow(clientTag),
      ]);
      const endsAt = new Date(Date.now() + settings.turboDays * 86_400_000).toISOString();
      const byInstance: Record<string, number> = {};
      for (const s of accounts.senders) byInstance[s.instance] = (byInstance[s.instance] ?? 0) + 1;
      return NextResponse.json({ clientTag, accounts: accounts.senders.length, byInstance, endsAt, settings, open });
    }

    if (action === "activate") {
      // Status/pace at activation from the cron's last evaluation — the log
      // needs them to judge the manual month.
      const { data: st } = await getSupabaseAdmin().from("client_sending_status")
        .select("status, pace, qls_delivered").eq("client_tag", clientTag).maybeSingle();
      const r = await startWindow({
        clientTag,
        kind: "turbo",
        activatedBy: actor,
        triggerDetail: "manual",
        statusAtStart: (st?.status as string) ?? null,
        paceAtStart: st?.pace === null || st?.pace === undefined ? null : Number(st.pace),
        qlsAtStart: st?.qls_delivered === null || st?.qls_delivered === undefined ? null : Number(st.qls_delivered),
        budgetMs: 230_000,
      });
      return NextResponse.json({ ok: true, ...r });
    }

    if (action === "cancel") {
      const open = await getOpenWindow(clientTag, "turbo");
      if (!open) return NextResponse.json({ error: `${clientTag} has no active Turbo window` }, { status: 404 });
      const { data: st } = await getSupabaseAdmin().from("client_sending_status")
        .select("pace, qls_delivered").eq("client_tag", clientTag).maybeSingle();
      const r = await endWindow(open.id, "cancelled", {
        budgetMs: 230_000,
        paceAtEnd: st?.pace === null || st?.pace === undefined ? null : Number(st.pace),
        qlsAtEnd: st?.qls_delivered === null || st?.qls_delivered === undefined ? null : Number(st.qls_delivered),
      });
      return NextResponse.json({ ok: true, ...r });
    }

    return NextResponse.json({ error: "action must be preview | activate | cancel" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
