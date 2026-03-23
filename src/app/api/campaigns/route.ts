import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export interface CampaignData {
  id: number;
  name: string;
  status: string;
  client_tag: string;
  total_leads: number;
  total_leads_contacted: number;
  remaining_leads: number;
  emails_sent: number;
  replied: number;
  unique_replies: number;
  bounced: number;
  opened: number;
  unique_opens: number;
  interested: number;
  unsubscribed: number;
  completion_percentage: number;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  try {
    const allCampaigns: CampaignData[] = [];
    let page = 1;

    // Fetch all pages
    while (true) {
      const res = await fetch(
        `${API_BASE}/campaigns?page=${page}&per_page=100`,
        { headers, cache: "no-store" }
      );
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      const campaigns = json.data || [];

      for (const c of campaigns) {
        // Extract client tag from campaign name: "CLIENT_TAG: Campaign Name"
        const colonIdx = c.name.indexOf(":");
        const clientTag = colonIdx > 0 ? c.name.substring(0, colonIdx).trim() : "";

        allCampaigns.push({
          id: c.id,
          name: c.name,
          status: c.status,
          client_tag: clientTag,
          total_leads: c.total_leads || 0,
          total_leads_contacted: c.total_leads_contacted || 0,
          remaining_leads: (c.total_leads || 0) - (c.total_leads_contacted || 0),
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
        });
      }

      const lastPage = json.meta?.last_page || 1;
      if (page >= lastPage) break;
      page++;
    }

    // Sort by created_at descending
    allCampaigns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return NextResponse.json(allCampaigns);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
