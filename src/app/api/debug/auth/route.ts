import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const supabase = createServerSupabaseClient(cookieStore);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error) {
      return NextResponse.json({ error: error.message, code: error.code });
    }

    if (!user) {
      return NextResponse.json({ error: "No user session" });
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      app_metadata_role: user.app_metadata?.role || "(not set)",
      user_metadata_role: user.user_metadata?.role || "(not set)",
      app_metadata: user.app_metadata,
      created_at: user.created_at,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
