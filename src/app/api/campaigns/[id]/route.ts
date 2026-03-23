import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Fetch campaign detail, stats, and sequence steps in parallel
    const [campaignRes, stepsRes] = await Promise.all([
      fetch(`${API_BASE}/campaigns/${id}`, { headers, cache: "no-store" }),
      fetch(`${API_BASE}/campaigns/v1.1/${id}/sequence-steps`, { headers, cache: "no-store" }),
    ]);

    if (!campaignRes.ok) throw new Error(`Campaign fetch failed: ${campaignRes.status}`);

    const campaignJson = await campaignRes.json();
    const campaign = campaignJson.data || campaignJson;

    // Get stats with date range from created_at to now
    const createdAt = campaign.created_at?.split("T")[0] || "2024-01-01";
    const now = new Date().toISOString().split("T")[0];

    const statsRes = await fetch(`${API_BASE}/campaigns/${id}/stats`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ start_date: createdAt, end_date: now }),
      cache: "no-store",
    });

    // Parse steps
    let sequenceSteps: Array<{
      id: number;
      order: number | null;
      variant: boolean;
      variant_from_step_id: number | null;
      wait_in_days: number;
      email_subject: string;
      thread_reply: boolean;
    }> = [];
    if (stepsRes.ok) {
      const stepsJson = await stepsRes.json();
      sequenceSteps = (stepsJson.data?.sequence_steps || []).map((s: Record<string, unknown>) => ({
        id: s.id,
        order: s.order,
        variant: s.variant || false,
        variant_from_step_id: s.variant_from_step_id,
        wait_in_days: s.wait_in_days || 0,
        email_subject: s.email_subject || "",
        thread_reply: s.thread_reply || false,
      }));
    }

    // Parse stats with per-step breakdown
    let stepStats: Array<{
      sequence_step_id: number;
      sent: number;
      leads_contacted: number;
      unique_opens: number;
      unique_replies: number;
      bounced: number;
      unsubscribed: number;
      interested: number;
    }> = [];
    let overallStats = null;

    if (statsRes.ok) {
      const statsJson = await statsRes.json();
      const statsData = statsJson.data;
      overallStats = {
        emails_sent: statsData.emails_sent || 0,
        total_leads_contacted: statsData.total_leads_contacted || 0,
        unique_replies: statsData.unique_replies_per_contact || 0,
        reply_rate: statsData.unique_replies_per_contact_percentage || 0,
        bounced: statsData.bounced || 0,
        bounce_rate: statsData.bounced_percentage || 0,
        unsubscribed: statsData.unsubscribed || 0,
        interested: statsData.interested || 0,
      };
      stepStats = (statsData.sequence_step_stats || []).map((s: Record<string, unknown>) => ({
        sequence_step_id: s.sequence_step_id,
        sent: s.sent || 0,
        leads_contacted: s.leads_contacted || 0,
        unique_opens: s.unique_opens || 0,
        unique_replies: s.unique_replies || 0,
        bounced: s.bounced || 0,
        unsubscribed: s.unsubscribed || 0,
        interested: s.interested || 0,
      }));
    }

    // Merge steps with their stats
    const stepsWithStats = sequenceSteps.map((step) => {
      const stat = stepStats.find((s) => s.sequence_step_id === step.id);
      return { ...step, stats: stat || null };
    });

    // Group: main steps (non-variant) with their variants
    const mainSteps = stepsWithStats.filter((s) => !s.variant);
    const variants = stepsWithStats.filter((s) => s.variant);
    const grouped = mainSteps.map((step) => ({
      ...step,
      variants: variants.filter((v) => v.variant_from_step_id === step.id),
    }));

    return NextResponse.json({
      campaign,
      overallStats,
      steps: grouped,
    });
  } catch (error) {
    console.error("[CAMPAIGN DETAIL] Error:", error);
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
