import { NextResponse } from "next/server";
import { snapshotAllInstances } from "@/lib/cron/snapshot-deliverability";

export const maxDuration = 60;

// Daily snapshot of per-domain cumulative sent/replied/bounced across all 4
// instances. Feeds the trailing 10d/15d reply & bounce rate columns on the
// Deliverability page. Idempotent per PST day.
export async function GET() {
  try {
    const results = await snapshotAllInstances();
    const total = results.reduce((n, r) => n + r.domains, 0);
    return NextResponse.json({ ok: true, total, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "snapshot failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
