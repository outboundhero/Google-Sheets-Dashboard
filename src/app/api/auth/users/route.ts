import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// GET — list all profiles (admin only, enforced by middleware)
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, created_at")
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH — update user role or reset password (admin only)
export async function PATCH(request: Request) {
  try {
    const { userId, role, password } = await request.json();
    if (!userId) {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Update role
    if (role && (role === "admin" || role === "viewer")) {
      // Update app_metadata (read by middleware JWT)
      const { error: authError } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { role },
      });
      if (authError) throw authError;

      // Update profiles table
      const { error: profileError } = await supabase
        .from("profiles")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (profileError) throw profileError;
    }

    // Reset password
    if (password) {
      const { error: pwError } = await supabase.auth.admin.updateUserById(userId, {
        password,
      });
      if (pwError) throw pwError;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE — remove a user (admin only)
export async function DELETE(request: Request) {
  try {
    const { userId } = await request.json();
    if (!userId) {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) throw error;

    // Profile auto-deleted via ON DELETE CASCADE
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
