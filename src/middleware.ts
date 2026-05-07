import { NextResponse, type NextRequest } from "next/server";
import { createMiddlewareSupabaseClient } from "@/lib/supabase";

// Viewer-allowed page paths
const VIEWER_PAGES = ["/clients", "/deliverability"];
// Viewer-allowed API paths (GET only)
const VIEWER_API_GETS = [
  "/api/data/all",
  "/api/sheets",
  "/api/analytics",
  "/api/client-tracker",
  "/api/deliverability/domains",
  "/api/deliverability/tags",
  "/api/deliverability/bulk-tags",
  "/api/deliverability/sync",
  "/api/client-tags",
  "/api/campaigns",
  "/api/leads/not-delivered-today",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.match(/\.(svg|png|jpg|jpeg|gif|webp|ico)$/)
  ) {
    return NextResponse.next();
  }

  // Allow cron endpoints (Vercel cron, no user auth)
  if (pathname.startsWith("/api/cron")) {
    return NextResponse.next();
  }

  // Allow external API endpoints (use their own Bearer token auth)
  if (pathname.startsWith("/api/external")) {
    return NextResponse.next();
  }

  // Create Supabase client (refreshes session cookies)
  const { supabase, response } = createMiddlewareSupabaseClient(request);

  // Get authenticated user
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  // Auth error: log but don't block (session may have expired)
  if (authError) {
    console.error("[MIDDLEWARE] Auth error:", authError.message, "path:", pathname);
  }

  // Login page: redirect to dashboard if already authenticated
  if (pathname === "/login") {
    if (user) {
      const role = user.app_metadata?.role || "viewer";
      const url = request.nextUrl.clone();
      url.pathname = role === "viewer" ? "/clients" : "/";
      return NextResponse.redirect(url);
    }
    return response;
  }

  // Not authenticated: redirect to login (but not for API routes — return 401)
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized", authError: authError?.message }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Check role from app_metadata, fall back to profiles table role
  const role = user.app_metadata?.role || user.user_metadata?.role || "viewer";

  // Admin: allow everything
  if (role === "admin") {
    return response;
  }

  // Viewer: restrict access
  // Allow viewer page paths
  const isViewerPage = VIEWER_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (isViewerPage) return response;

  // Allow viewer API GET requests
  if (pathname.startsWith("/api/")) {
    const isGet = request.method === "GET";
    const isAllowedApi = VIEWER_API_GETS.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (isGet && isAllowedApi) return response;

    // Block other API requests for viewers
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Block other pages: redirect to /clients
  const url = request.nextUrl.clone();
  url.pathname = "/clients";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
