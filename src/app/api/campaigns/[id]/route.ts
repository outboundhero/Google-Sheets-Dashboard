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

    // Fetch campaign detail
    const res = await fetch(`${API_BASE}/campaigns/${id}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = await res.json();
    const campaign = json.data || json;

    return NextResponse.json(campaign);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
