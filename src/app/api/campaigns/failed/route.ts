import { NextResponse } from "next/server";

const API_BASE = "https://app.outboundhero.co/api";
const API_KEY = process.env.OUTBOUNDHERO_API_KEY!;
const headers = { Authorization: `Bearer ${API_KEY}` };

export async function GET() {
  try {
    // Fetch page 1 to get lastPage
    const firstRes = await fetch(`${API_BASE}/campaigns?page=1&per_page=100`, { headers, cache: "no-store" });
    if (!firstRes.ok) throw new Error(`API error: ${firstRes.status}`);
    const firstJson = await firstRes.json();
    const lastPage = firstJson.meta?.last_page || 1;

    const allData: Array<{ id: number; name: string; status: string; created_at: string }> = [...(firstJson.data || [])];

    // Fetch remaining pages concurrently
    if (lastPage > 1) {
      const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
      for (let i = 0; i < pages.length; i += 10) {
        const batch = pages.slice(i, i + 10);
        const results = await Promise.allSettled(
          batch.map((p) =>
            fetch(`${API_BASE}/campaigns?page=${p}&per_page=100`, { headers, cache: "no-store" })
              .then((r) => r.json())
              .then((j) => j.data || [])
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled") allData.push(...r.value);
        }
      }
    }

    const failed = allData
      .filter((c) => c.status === "failed")
      .map((c) => ({
        id: c.id,
        name: c.name,
        client_tag: c.name.indexOf(":") > 0 ? c.name.substring(0, c.name.indexOf(":")).trim() : "",
        created_at: c.created_at,
      }));

    return NextResponse.json(failed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
