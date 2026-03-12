import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const today = new Date().toISOString().split("T")[0];

    // Fetch inbox info to get created_at as start_date
    const inboxRes = await fetch(`${API_BASE}/sender-emails/${id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: "no-store",
    });

    let startDate = "2024-01-01";
    if (inboxRes.ok) {
      const inboxJson = await inboxRes.json();
      const createdAt = inboxJson?.data?.created_at || inboxJson?.created_at;
      if (createdAt) startDate = createdAt.split("T")[0];
    }

    const warmupRes = await fetch(
      `${API_BASE}/warmup/sender-emails/${id}?start_date=${startDate}&end_date=${today}`,
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
        cache: "no-store",
      }
    );

    if (!warmupRes.ok) {
      return NextResponse.json({ error: "Warmup data unavailable" }, { status: warmupRes.status });
    }

    const warmupJson = await warmupRes.json();
    const payload = Array.isArray(warmupJson) ? warmupJson[0] : warmupJson;
    return NextResponse.json(payload?.data || payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
