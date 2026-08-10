import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";
import { deriveStage } from "@/lib/campaigns/stage";

interface CampaignPayload {
  id: number;
  name: string;
  status: string;
  type?: string;
  sequence_id?: number;
  max_emails_per_day?: number;
  max_new_leads_per_day?: number;
  total_leads?: number;
  total_leads_contacted?: number;
  emails_sent?: number;
  replied?: number;
  unique_replies?: number;
  bounced?: number;
  opened?: number;
  unique_opens?: number;
  interested?: number;
  unsubscribed?: number;
  completion_percentage?: number;
  created_at: string;
  updated_at: string;
}

// "Sending" = Bison status active. Used to stamp first_sending_at the first
// time we observe a campaign live (Bison exposes no started-sending timestamp).
function isSending(status: string): boolean {
  return (status || "").trim().toLowerCase() === "active";
}

export async function runCampaignsSync(instance: BisonInstanceSlug): Promise<NextResponse> {
  const t0 = Date.now();
  const supabase = getSupabaseAdmin();

  try {
    const firstRes = await bisonFetch(instance, `/campaigns?page=1&per_page=100`);
    if (!firstRes.ok) {
      return NextResponse.json(
        { error: `Bison ${firstRes.status} on page 1`, instance },
        { status: 502 },
      );
    }
    const firstJson = await firstRes.json();
    const lastPage: number = firstJson.meta?.last_page || 1;
    const all: CampaignPayload[] = [...(firstJson.data || [])];

    for (let p = 2; p <= lastPage && Date.now() - t0 < 55_000; p++) {
      const r = await bisonFetch(instance, `/campaigns?page=${p}&per_page=100`);
      if (!r.ok) continue;
      const j = await r.json();
      all.push(...(j.data || []));
    }

    // Existing first_sending_at per campaign — so we stamp it ONCE (first time we
    // see the campaign Active) and never move it. stage_override is preserved by
    // simply NOT including it in the upsert payload.
    const priorFirstSending = new Map<number, string | null>();
    for (let off = 0; ; off += 1000) {
      const { data } = await supabase
        .from("campaigns")
        .select("id, first_sending_at")
        .eq("instance", instance)
        .range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const r of data) priorFirstSending.set(r.id as number, (r.first_sending_at as string) ?? null);
      if (data.length < 1000) break;
    }

    const nowIso = new Date().toISOString();
    const rows = all.map((c) => {
      const colonIdx = c.name?.indexOf(":") ?? -1;
      const totalLeads = c.total_leads || 0;
      const contacted = c.total_leads_contacted || 0;
      const prior = priorFirstSending.get(c.id) ?? null;
      const firstSendingAt = prior ?? (isSending(c.status) ? nowIso : null);
      return {
        id: c.id,
        instance,
        name: c.name,
        status: c.status,
        campaign_type: c.type ?? null,
        sequence_id: c.sequence_id ?? null,
        stage: deriveStage(c.name),
        first_sending_at: firstSendingAt,
        max_emails_per_day: c.max_emails_per_day ?? null,
        max_new_leads_per_day: c.max_new_leads_per_day ?? null,
        client_tag: colonIdx > 0 ? c.name.substring(0, colonIdx).trim() : "",
        total_leads: totalLeads,
        total_leads_contacted: contacted,
        remaining_leads: totalLeads - contacted,
        emails_sent: c.emails_sent || 0,
        replied: c.replied || 0,
        unique_replies: c.unique_replies || 0,
        bounced: c.bounced || 0,
        opened: c.opened || 0,
        unique_opens: c.unique_opens || 0,
        interested: c.interested || 0,
        unsubscribed: c.unsubscribed || 0,
        completion_percentage: c.completion_percentage || 0,
        created_at: c.created_at,
        updated_at: c.updated_at,
        synced_at: nowIso,
      };
    });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("campaigns")
        .upsert(rows.slice(i, i + 500), { onConflict: "instance,id", ignoreDuplicates: false });
      if (error) console.error(`[cron/campaigns:${instance}] upsert failed:`, error.message);
    }

    const durationMs = Date.now() - t0;
    console.log(
      `[cron/campaigns:${instance}] synced=${rows.length} pages=${lastPage} duration=${durationMs}ms`,
    );
    return NextResponse.json({ instance, campaignsSynced: rows.length, pages: lastPage, durationMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error(`[cron/campaigns:${instance}]`, message);
    return NextResponse.json({ error: message, instance }, { status: 500 });
  }
}
