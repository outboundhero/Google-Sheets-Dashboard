import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("tracked_sheets")
      .select("*")
      .order("client_tag", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const sheets = (data || []).map((row) => ({
      id: row.id,
      name: row.name,
      clientTag: row.client_tag,
      sheetName: row.sheet_name,
      addedAt: row.added_at,
      syncedAt: row.synced_at,
    }));

    return NextResponse.json({
      sheets,
      count: sheets.length,
      lastSyncedAt: sheets.length > 0
        ? sheets.reduce((latest, s) => (s.syncedAt > latest ? s.syncedAt : latest), sheets[0].syncedAt)
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
