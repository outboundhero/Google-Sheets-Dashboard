import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";
import { getAnticipated, setAnticipated, groupForStartDate, upcomingStartDates } from "@/lib/replacement/anticipated-clients";
import { logEvents } from "@/lib/replacement/store";
import type { ClientTier } from "@/lib/replacement/client-tiers";

// GET  → { entries, upcoming: [{ startDate, group }] }
// PUT  { startDate, clients, tier } → upsert (clients = 0 removes). Admin via middleware.

export async function GET() {
  try {
    const entries = await getAnticipated();
    const upcoming = upcomingStartDates().map((startDate) => ({ startDate, group: groupForStartDate(startDate) }));
    return NextResponse.json({ entries, upcoming });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { startDate?: string; clients?: number; tier?: string };
    const tier: ClientTier = body.tier === "2" ? "2" : "1";
    if (!body.startDate || typeof body.clients !== "number") {
      return NextResponse.json({ error: "startDate and clients are required" }, { status: 400 });
    }
    const { data: { user } } = await createServerSupabaseClient(await cookies()).auth.getUser();
    const entries = await setAnticipated({ startDate: body.startDate, clients: body.clients, tier }, user?.email ?? null);
    await logEvents([{
      eventType: "proposed",
      detail: `anticipated clients set by ${user?.email ?? "unknown user"}: ${body.clients} × Tier ${tier} on ${body.startDate} (Group ${groupForStartDate(body.startDate)})`,
      signals: { kind: "anticipated_clients", startDate: body.startDate, clients: body.clients, tier, actor: user?.email ?? null },
    }]).catch(() => undefined);
    return NextResponse.json({ entries });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
