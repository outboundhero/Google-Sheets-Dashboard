import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

export async function GET() {
  try {
    // Fetch all campaigns pages and filter for failed status
    const failed: { id: number; name: string; client_tag: string; created_at: string }[] = [];
    let page = 1;

    while (true) {
      const res = await fetch(`${API_BASE}/campaigns?page=${page}&per_page=100`, {
        headers,
        cache: "no-store",
      });
      if (!res.ok) break;
      const json = await res.json();
      const data = json.data || [];

      for (const c of data) {
        if (c.status === "failed") {
          const colonIdx = (c.name as string).indexOf(":");
          failed.push({
            id: c.id,
            name: c.name,
            client_tag: colonIdx > 0 ? c.name.substring(0, colonIdx).trim() : "",
            created_at: c.created_at,
          });
        }
      }

      const lastPage = json.meta?.last_page || 1;
      if (page >= lastPage) break;
      page++;
    }

    return NextResponse.json(failed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
