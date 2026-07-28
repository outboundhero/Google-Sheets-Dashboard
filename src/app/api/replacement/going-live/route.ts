import { NextResponse } from "next/server";
import { getGoingLiveForecast } from "@/lib/replacement/going-live";

export const maxDuration = 30;

// GET /api/replacement/going-live?horizon=45 — upcoming client go-lives bucketed
// around the next 1st / 15th. Observe-only forecast for domain pre-buying.
export async function GET(request: Request) {
  try {
    const raw = Number(new URL(request.url).searchParams.get("horizon"));
    const horizonDays = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    return NextResponse.json(await getGoingLiveForecast({ horizonDays }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
