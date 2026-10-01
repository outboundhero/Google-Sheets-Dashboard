import { NextResponse } from "next/server";
import { listWindows } from "@/lib/sending-mode/windows";

// GET /api/performance/windows[?csv=1] — the Turbo + throttle log, newest
// first. ?csv=1 downloads it (the spec's "simple exportable table").
export async function GET(request: Request) {
  try {
    const windows = await listWindows(2000);
    const url = new URL(request.url);
    if (url.searchParams.get("csv") !== "1") return NextResponse.json({ windows });

    const cols = [
      "client_tag", "kind", "status", "started_at", "ends_at", "ended_at", "end_reason", "activated_by",
      "trigger_detail", "status_at_start", "pace_at_start", "qls_at_start", "pace_at_end", "qls_at_end",
      "sent_at_start", "sent_at_end", "account_count", "revert_attempts", "last_error",
    ] as const;
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      [...cols, "emails_sent_in_window", "applied_limits"].join(","),
      ...windows.map((w) => [
        ...cols.map((c) => esc(w[c])),
        esc(w.sent_at_end !== null && w.sent_at_start !== null ? w.sent_at_end - w.sent_at_start : ""),
        esc(w.applied_limits),
      ].join(",")),
    ];
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="turbo-throttle-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
