import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { sourceOf } from "@/lib/replacement/event-source";

// GET /api/replacement/domain-history?domain=x.com — everything the system
// ever did to ONE domain, newest first, across every instance and every
// automation: replacement events (flagged/tagged/removed/redirect/attached/
// skipped/errors), lifecycle state, deletion-queue rows, vendor cancellations.
//
// Spencer + Nick 2026-08-26: "every action recorded with why, visible live —
// we shouldn't have to ask you whether it worked." And Vicky's rule: before
// any domain is touched, its previous steps must be visible. Read-only.

interface HistoryEntry {
  at: string;
  kind: string;        // event_type, or "state" | "deletion" | "cancellation"
  instance: string | null;
  clientTag: string | null;
  detail: string;
  source: string;      // which automation wrote it, derived from the detail prefix
}

export async function GET(request: Request) {
  try {
    const domain = (new URL(request.url).searchParams.get("domain") || "").trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
    const supabase = getSupabaseAdmin();
    const entries: HistoryEntry[] = [];

    const { data: events, error: evErr } = await supabase
      .from("replacement_events")
      .select("created_at, instance, client_tag, event_type, detail")
      .eq("domain", domain)
      .order("created_at", { ascending: false })
      .limit(300);
    if (evErr) throw new Error(evErr.message);
    for (const e of events || []) {
      entries.push({
        at: e.created_at, kind: e.event_type, instance: e.instance, clientTag: e.client_tag,
        detail: e.detail || "", source: sourceOf(e.detail, e.event_type),
      });
    }

    const { data: states } = await supabase
      .from("domain_replacement_state")
      .select("instance, state, assigned_client_tag, flagged_at, flagged_reason, updated_at")
      .eq("domain", domain);
    for (const s of states || []) {
      entries.push({
        at: s.updated_at, kind: "state", instance: s.instance, clientTag: s.assigned_client_tag,
        detail: `lifecycle: ${s.state}${s.flagged_reason ? ` — ${s.flagged_reason}` : ""}${s.flagged_at ? ` (flagged ${String(s.flagged_at).slice(0, 10)})` : ""}`,
        source: "lifecycle",
      });
    }

    const { data: dels } = await supabase
      .from("duplicate_domain_deletions")
      .select("instance, status, scheduled_at, source, created_at")
      .eq("domain", domain);
    for (const d of dels || []) {
      entries.push({
        at: d.created_at || d.scheduled_at, kind: "deletion", instance: d.instance, clientTag: null,
        detail: `delete from ${d.instance} — ${d.status}${d.status === "pending" ? `, due ${String(d.scheduled_at).slice(0, 16).replace("T", " ")} UTC` : ""} (source: ${d.source})`,
        source: "deletion queue",
      });
    }

    const { data: cancels } = await supabase
      .from("replacement_cancellations")
      .select("instance, client_tag, status, scheduled_at, reason, created_at")
      .eq("domain", domain);
    for (const c of cancels || []) {
      entries.push({
        at: c.created_at || c.scheduled_at, kind: "cancellation", instance: c.instance, clientTag: c.client_tag,
        detail: `vendor cancellation — ${c.status}: ${c.reason || ""}`.trim(),
        source: "cancel bridge",
      });
    }

    const { data: rows } = await supabase
      .from("deliverability_domains")
      .select("instance, tags, total_sent, total_replied, inbox_count, domain_created_at, redirect_url")
      .eq("domain", domain);

    entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return NextResponse.json({
      domain,
      now: (rows || []).map((r) => ({
        instance: r.instance, tags: r.tags, sent: r.total_sent, replied: r.total_replied,
        inboxes: r.inbox_count, created: r.domain_created_at, redirect: r.redirect_url,
      })),
      history: entries,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
