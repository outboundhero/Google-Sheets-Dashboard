import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

// POST — invite a viewer (admin only, enforced by middleware)
export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) {
      return NextResponse.json({ error: "email and password required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Create user with viewer role in app_metadata
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm email
      app_metadata: { role: "viewer" },
    });

    if (error) throw error;

    return NextResponse.json({
      success: true,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
