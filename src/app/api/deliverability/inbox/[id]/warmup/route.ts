import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const today = new Date().toISOString().split("T")[0];

    // Fetch inbox info to get created_at as start_date
    const inboxRes = await bisonFetch(instance, `/sender-emails/${id}`);

    let startDate = "2024-01-01";
    if (inboxRes.ok) {
      const inboxJson = await inboxRes.json();
      const createdAt = inboxJson?.data?.created_at || inboxJson?.created_at;
      if (createdAt) startDate = createdAt.split("T")[0];
    }

    const warmupRes = await bisonFetch(
      instance,
      `/warmup/sender-emails/${id}?start_date=${startDate}&end_date=${today}`
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
