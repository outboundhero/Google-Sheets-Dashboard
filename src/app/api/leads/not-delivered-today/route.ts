import { NextResponse } from "next/server";
import { getStoredLeads } from "@/lib/leads-store";
import { isPstToday } from "@/lib/date-utils";
import { listDismissedKeys, dismissLead, dismissedKey } from "@/lib/dismissed-leads";
import type { Lead } from "@/types/lead";

const STATUS_MATCH = "Lead not Received";

interface BannerLead {
  email: string;
  name: string;
  company: string;
  replyTime: string;
  sheetId: string;
  sheetName: string;
  sheetClientTag: string;
}

function pickBannerFields(l: Lead): BannerLead {
  return {
    email: l.email,
    name: l.name,
    company: l.company,
    replyTime: l.replyTime,
    sheetId: l.sheetId,
    sheetName: l.sheetName,
    sheetClientTag: l.sheetClientTag,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientTag = searchParams.get("clientTag")?.trim() || null;

    const [leads, dismissed] = await Promise.all([
      getStoredLeads(),
      listDismissedKeys(clientTag || undefined),
    ]);

    const seen = new Set<string>();
    const matched: Lead[] = [];
    for (const l of leads) {
      if (l.status !== STATUS_MATCH) continue;
      if (!isPstToday(l.replyTime)) continue;
      if (clientTag && l.sheetClientTag !== clientTag) continue;
      const k = dismissedKey(l.sheetId, l.email);
      if (dismissed.has(k)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      matched.push(l);
    }

    if (clientTag) {
      return NextResponse.json({
        leads: matched.map(pickBannerFields),
        count: matched.length,
      });
    }

    const counts = new Map<string, number>();
    for (const l of matched) {
      counts.set(l.sheetClientTag, (counts.get(l.sheetClientTag) || 0) + 1);
    }
    const byClient = Array.from(counts, ([clientTag, count]) => ({ clientTag, count }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({ total: matched.length, byClient });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sheetId = typeof body?.sheetId === "string" ? body.sheetId.trim() : "";
    const leadEmail = typeof body?.leadEmail === "string" ? body.leadEmail.trim() : "";
    const clientTag = typeof body?.clientTag === "string" ? body.clientTag.trim() : "";
    if (!sheetId || !leadEmail || !clientTag) {
      return NextResponse.json({ error: "sheetId, leadEmail, and clientTag are required" }, { status: 400 });
    }
    await dismissLead({ sheetId, leadEmail, clientTag });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
