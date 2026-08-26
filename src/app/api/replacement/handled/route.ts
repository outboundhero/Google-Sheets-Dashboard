import { NextResponse } from "next/server";
import { getHandledDomains } from "@/lib/replacement/store";

// GET /api/replacement/handled — every (instance, domain) the system considers
// LEAVING: lifecycle removed/replacing/retired, or sitting in a deletion or
// cancellation queue. The deliverability page uses it to (a) keep those out
// of the Reserve view and (b) badge them, so a human moving or reusing
// domains by hand sees "burnt — removed" before touching one.
//
// 2026-08-27: ten ex-CWSV/DBSM burnt domains (12k–34k sends, removed by the
// system) were moved OH → CO by hand because on the page they looked like
// plain untagged reserve. Read-only.
export async function GET() {
  try {
    const set = await getHandledDomains();
    return NextResponse.json({ keys: [...set] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
