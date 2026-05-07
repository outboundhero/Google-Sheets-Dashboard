import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";
import { isPstTodayOrYesterday, isPstToday, pstDateString } from "@/lib/date-utils";

const STATUS_MATCH = "lead not received";

export async function GET() {
  const leads = await getStoredLeads();

  const statusCounts = new Map<string, number>();
  for (const l of leads) {
    statusCounts.set(l.status, (statusCounts.get(l.status) || 0) + 1);
  }

  const lnr = leads.filter((l) => (l.status || "").trim().toLowerCase() === STATUS_MATCH);

  const matchedReply = lnr.filter((l) => isPstTodayOrYesterday(l.replyTime));
  const matchedGot = lnr.filter((l) => isPstTodayOrYesterday(l.timeWeGotReply));
  const matchedEither = lnr.filter((l) => isPstTodayOrYesterday(l.replyTime) || isPstTodayOrYesterday(l.timeWeGotReply));

  const recent = [...lnr]
    .sort((a, b) => {
      const ta = new Date(a.replyTime || a.timeWeGotReply).getTime() || 0;
      const tb = new Date(b.replyTime || b.timeWeGotReply).getTime() || 0;
      return tb - ta;
    })
    .slice(0, 10)
    .map((l) => ({
      email: l.email,
      status: l.status,
      replyTime: l.replyTime,
      timeWeGotReply: l.timeWeGotReply,
      replyTimeIsToday: isPstToday(l.replyTime),
      timeWeGotReplyIsToday: isPstToday(l.timeWeGotReply),
      sheetClientTag: l.sheetClientTag,
      sheetId: l.sheetId,
    }));

  return NextResponse.json({
    totalLeadsInStore: leads.length,
    todayPst: pstDateString(new Date()),
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort((a, b) => b[1] - a[1])),
    leadNotReceivedCount: lnr.length,
    matchedOnReplyTime: matchedReply.length,
    matchedOnTimeWeGotReply: matchedGot.length,
    matchedOnEither: matchedEither.length,
    sampleRecentLeadNotReceived: recent,
  });
}
