import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));

    // Fetch page 1 to get lastPage
    const firstRes = await bisonFetch(instance, `/campaigns?page=1&per_page=100`);
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
            bisonFetch(instance, `/campaigns?page=${p}&per_page=100`)
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
        instance,
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
