import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };
const BATCH_DELAY = 100;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  try {
    const { domains } = (await request.json()) as { domains: string[] };
    if (!domains?.length) {
      return NextResponse.json({ error: "domains required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1. Get all inbox IDs for the selected domains
    const { data: inboxes, error: inboxError } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain")
      .in("domain", domains);

    if (inboxError) throw new Error(inboxError.message);

    const inboxIds = inboxes?.map((i) => i.id) || [];

    // 2. Delete each inbox from OutboundHero API
    let deleted = 0;
    const errors: string[] = [];

    for (let i = 0; i < inboxIds.length; i++) {
      try {
        const res = await fetch(`${API_BASE}/sender-emails/${inboxIds[i]}`, {
          method: "DELETE",
          headers,
        });
        if (res.ok || res.status === 404) {
          deleted++;
        } else {
          errors.push(`Inbox ${inboxIds[i]}: ${res.status}`);
        }
      } catch (e) {
        errors.push(`Inbox ${inboxIds[i]}: ${e instanceof Error ? e.message : "failed"}`);
      }
      if (i < inboxIds.length - 1) await delay(BATCH_DELAY);
    }

    // 3. Delete from Supabase inboxes
    if (inboxIds.length > 0) {
      await supabase
        .from("deliverability_inboxes")
        .delete()
        .in("domain", domains);
    }

    // 4. Delete from Supabase domains
    await supabase
      .from("deliverability_domains")
      .delete()
      .in("domain", domains);

    return NextResponse.json({
      success: true,
      inboxesDeleted: deleted,
      domainsDeleted: domains.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
