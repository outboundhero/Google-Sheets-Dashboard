import { NextResponse } from "next/server";
import {
  logEvents, setLifecycle, scheduleCancellations,
  type NewEvent, type LifecycleUpdate, type CancellationEntry,
} from "@/lib/replacement/store";

// POST /api/replacement/record — execution bookkeeping. The frontend calls this
// after each real action to: (1) append audit events, (2) update domain
// lifecycle state, (3) schedule burnt domains for the 5-day vendor-delete grace.
// This NEVER deletes anything at a provider — it only records intent.
// Admin-only via middleware.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      events?: NewEvent[];
      lifecycle?: LifecycleUpdate[];
      cancellations?: CancellationEntry[];
    };
    if (body.events?.length) await logEvents(body.events);
    if (body.lifecycle?.length) await setLifecycle(body.lifecycle);
    if (body.cancellations?.length) await scheduleCancellations(body.cancellations);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
