import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const apiHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Delete a single sender email, returns true if successful
async function deleteSenderEmail(id: number): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(`${API_BASE}/sender-emails/${id}`, {
      method: "DELETE",
      headers: apiHeaders,
    });
    const body = await res.text();
    return { ok: res.ok || res.status === 404, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : "failed" };
  }
}

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

    // 2. Delete inboxes from OutboundHero API in concurrent batches
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 200;
    let deleted = 0;
    const errors: string[] = [];

    for (let i = 0; i < inboxIds.length; i += BATCH_SIZE) {
      const batch = inboxIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((id) => deleteSenderEmail(id)));

      for (let j = 0; j < results.length; j++) {
        if (results[j].ok) {
          deleted++;
        } else {
          errors.push(`Inbox ${batch[j]}: ${results[j].status} ${results[j].body}`);
        }
      }

      if (i + BATCH_SIZE < inboxIds.length) await delay(BATCH_DELAY);
    }

    // 3. Delete from Supabase — always clean up local records regardless of API errors
    // Delete inboxes first (FK constraint)
    await supabase
      .from("deliverability_inboxes")
      .delete()
      .in("domain", domains);

    // Then delete domains
    await supabase
      .from("deliverability_domains")
      .delete()
      .in("domain", domains);

    return NextResponse.json({
      success: true,
      inboxesDeleted: deleted,
      domainsDeleted: domains.length,
      totalInboxes: inboxIds.length,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined, // first 5 errors for debugging
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
