import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// Saved filter presets for the Domains tables' advanced filter builder.
// Server-persisted (durable, team-shared) in `domain_saved_searches`.
//   GET    /api/domains/saved-searches?scope=all-domains  → list for a tab
//   POST   { scope, name, filter }                        → create/overwrite by name
//   DELETE /api/domains/saved-searches?id=<id>            → remove one
// Admin-only via middleware.
export const dynamic = "force-dynamic";

const VALID_SCOPES = new Set(["all-domains", "purchased"]);

export async function GET(request: Request) {
  try {
    const scope = new URL(request.url).searchParams.get("scope") || "";
    if (!VALID_SCOPES.has(scope)) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("domain_saved_searches")
      .select("id, name, filter, updated_at")
      .eq("scope", scope)
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const searches = (data || []).map((r) => ({ id: r.id, name: r.name, filter: r.filter, updatedAt: r.updated_at }));
    return NextResponse.json({ searches });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { scope?: string; name?: string; filter?: unknown };
    const scope = (body.scope || "").trim();
    const name = (body.name || "").trim();
    if (!VALID_SCOPES.has(scope)) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (body.filter == null || typeof body.filter !== "object") return NextResponse.json({ error: "filter required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("domain_saved_searches")
      .upsert({ scope, name, filter: body.filter, updated_at: new Date().toISOString() }, { onConflict: "scope,name" })
      .select("id, name, filter, updated_at")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ search: { id: data.id, name: data.name, filter: data.filter, updatedAt: data.updated_at } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("domain_saved_searches").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
