import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ clientTag: string }> }
) {
  try {
    const { clientTag: rawTag } = await params;
    const clientTag = decodeURIComponent(rawTag);
    const all = await getStoredLeads();
    const leads = all.filter((l) => l.sheetClientTag === clientTag);

    const cats = new Map<string, number>();
    const statuses = new Map<string, number>();
    let withReplyTime = 0;
    let withTimeWeGotReply = 0;
    let withCurrentCategory = 0;
    let withMeetingInCategory = 0;
    for (const l of leads) {
      cats.set(l.currentCategory || "(empty)", (cats.get(l.currentCategory || "(empty)") || 0) + 1);
      statuses.set(l.status || "(empty)", (statuses.get(l.status || "(empty)") || 0) + 1);
      if (l.replyTime) withReplyTime++;
      if (l.timeWeGotReply) withTimeWeGotReply++;
      if ((l.currentCategory || "").trim()) withCurrentCategory++;
      if ((l.currentCategory || "").toLowerCase().includes("meeting")) withMeetingInCategory++;
    }

    const sample = leads.slice(0, 5).map((l) => ({
      email: l.email,
      currentCategory: l.currentCategory,
      status: l.status,
      replyTime: l.replyTime,
      timeWeGotReply: l.timeWeGotReply,
      sheetName: l.sheetName,
    }));

    return NextResponse.json({
      clientTag,
      totalLeads: leads.length,
      withReplyTime,
      withTimeWeGotReply,
      withCurrentCategory,
      withMeetingInCategory,
      categoryCounts: Object.fromEntries([...cats.entries()].sort((a, b) => b[1] - a[1])),
      statusCounts: Object.fromEntries([...statuses.entries()].sort((a, b) => b[1] - a[1])),
      sample,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
