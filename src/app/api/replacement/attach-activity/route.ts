import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// GET /api/replacement/attach-activity?days=1
//
// What the attach automations did, for the Deliverability card Spencer asked
// for (Loom 2026-09-16: "in deliverability it would tell us what happened…
// how many accounts and which ones they were if you hit the toggle").
// Read-only; groups the audit events the two crons already write.

interface EventRow {
  created_at: string;
  instance: string | null;
  domain: string | null;
  client_tag: string | null;
  detail: string;
  signals: Record<string, unknown> | null;
}

export async function GET(request: Request) {
  try {
    const days = Math.max(1, Math.min(14, Number(new URL(request.url).searchParams.get("days") ?? 1) || 1));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const supabase = getSupabaseAdmin();

    const rows: EventRow[] = [];
    for (let off = 0; ; off += 500) {
      const { data, error } = await supabase
        .from("replacement_events")
        .select("created_at, instance, domain, client_tag, detail, signals")
        .eq("event_type", "attached")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .range(off, off + 499);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...(data as EventRow[]));
      if (data.length < 500) break;
    }

    interface Item { clientTag: string; instance: string; accounts: number; domains: string[]; campaigns: string[]; source: string; at: string }
    const byKey = new Map<string, Item>();
    let totalAccounts = 0;

    for (const r of rows) {
      const s = (r.signals ?? {}) as { kind?: string; campaign_completeness?: unknown; attached?: number; inboxes?: number; campaigns?: unknown };
      const isCompleteness = s.kind === "campaign_completeness" || r.detail.startsWith("campaign-completeness");
      const isOrphan = r.detail.startsWith("orphan-attach");
      if (!isCompleteness && !isOrphan) continue; // manual dialog attaches aren't logged here

      const tag = (r.client_tag || "—").toUpperCase();
      const instance = r.instance || "—";
      const key = `${tag}:${instance}:${isCompleteness ? "sweep" : "new-domain"}`;
      const accounts = isCompleteness
        ? Number(s.attached ?? 0)
        : Number(s.inboxes ?? 0);
      if (accounts <= 0 && isCompleteness) continue;

      const item = byKey.get(key) ?? {
        clientTag: tag, instance, accounts: 0, domains: [], campaigns: [],
        source: isCompleteness ? "daily sweep" : "newly tagged domain", at: r.created_at,
      };
      item.accounts += accounts;
      if (r.domain && !item.domains.includes(r.domain)) item.domains.push(r.domain);
      for (const c of (Array.isArray(s.campaigns) ? s.campaigns : []) as unknown[]) {
        const name = typeof c === "string" ? c : (c as { name?: string })?.name;
        if (name && !item.campaigns.includes(name)) item.campaigns.push(name);
      }
      if (r.created_at > item.at) item.at = r.created_at;
      byKey.set(key, item);
      totalAccounts += accounts;
    }

    const items = [...byKey.values()].sort((a, b) => b.accounts - a.accounts || b.at.localeCompare(a.at));
    return NextResponse.json({
      days,
      totalAccounts,
      clients: new Set(items.map((i) => i.clientTag)).size,
      items,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "attach-activity failed" }, { status: 500 });
  }
}
