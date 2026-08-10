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
      .select("id, name, filter, updated_at, is_default")
      .eq("scope", scope)
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const searches = (data || []).map((r) => ({ id: r.id, name: r.name, filter: r.filter, updatedAt: r.updated_at, isDefault: !!r.is_default }));
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

// Set (or clear) the auto-applied default for a scope. Body: { scope, id }.
// id = a search id → make it the sole default; id = null → clear the default.
export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { scope?: string; id?: number | null };
    const scope = (body.scope || "").trim();
    if (!VALID_SCOPES.has(scope)) return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    const supabase = getSupabaseAdmin();
    // Clear every default in this scope first, then set the chosen one.
    const clear = await supabase.from("domain_saved_searches").update({ is_default: false }).eq("scope", scope).eq("is_default", true);
    if (clear.error) return NextResponse.json({ error: clear.error.message }, { status: 500 });
    if (body.id != null) {
      const set = await supabase.from("domain_saved_searches").update({ is_default: true }).eq("scope", scope).eq("id", body.id);
      if (set.error) return NextResponse.json({ error: set.error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
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
