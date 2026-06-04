import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";

// Shared triage status for the "Clients without meeting-ready leads (4+ days)"
// panel. Status is per client tag (shared across users), one of:
//   unreviewed | in_progress | resolved
// Table: client_triage_status (client_tag PK, status, updated_by, updated_at)

const VALID = new Set(["unreviewed", "in_progress", "resolved"]);

// GET ?tags=A,B,C  → { statuses: { TAG: { status, updated_by, updated_at } } }
// Also AUTO-RESETS: any stored tag NOT in the current panel set is deleted, so a
// client that dropped off the panel (got a lead) starts fresh if it returns.
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(request.url);

    // Only prune when the caller explicitly passes the current panel set.
    if (searchParams.has("tags")) {
      const tags = (searchParams.get("tags") || "")
        .split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length > 0) {
        // Delete rows for tags no longer on the panel.
        const { data: existing } = await supabase.from("client_triage_status").select("client_tag");
        const stale = (existing || []).map((r) => r.client_tag).filter((t: string) => !tags.includes(t));
        if (stale.length > 0) {
          await supabase.from("client_triage_status").delete().in("client_tag", stale);
        }
      } else {
        // Panel is empty → everyone got a lead → reset all.
        await supabase.from("client_triage_status").delete().neq("client_tag", "");
      }
    }

    const { data, error } = await supabase
      .from("client_triage_status")
      .select("client_tag, status, updated_by, updated_at");
    if (error) throw new Error(error.message);

    const statuses: Record<string, { status: string; updated_by: string | null; updated_at: string }> = {};
    for (const r of data || []) {
      statuses[r.client_tag] = { status: r.status, updated_by: r.updated_by, updated_at: r.updated_at };
    }
    return NextResponse.json({ statuses });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST { clientTag, status, updatedBy } → upsert; posts to Slack on "resolved".
export async function POST(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    const { clientTag, status, updatedBy } = (await request.json()) as {
      clientTag?: string; status?: string; updatedBy?: string;
    };
    if (!clientTag || !status || !VALID.has(status)) {
      return NextResponse.json({ error: "clientTag and a valid status are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("client_triage_status")
      .upsert(
        { client_tag: clientTag, status, updated_by: updatedBy || null, updated_at: now },
        { onConflict: "client_tag" },
      );
    if (error) throw new Error(error.message);

    let slack: { ok: boolean; reason?: string } | undefined;
    if (status === "resolved") {
      const ts = new Date().toLocaleString("en-US", {
        timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short",
      });
      slack = await postSlackMessage(
        `✅ *${clientTag}* has been diagnosed and resolved by ${updatedBy || "a teammate"} — ${ts} PST`,
      );
    }
    return NextResponse.json({ ok: true, slack });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
