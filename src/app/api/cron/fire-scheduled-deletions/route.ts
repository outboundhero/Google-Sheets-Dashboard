import { runScheduledDeletions } from "@/lib/cron/fire-scheduled-deletions";

// 800s (Fluid): a single facilityreach domain can spend ~60s per rate-limited
// sender search, so the old 300s ceiling killed rows mid-delete.
export const maxDuration = 800;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const force = params.get("force") === "1";
  // ?limit=1 — debug window: a tiny run returns inside a curl timeout WITH the
  // per-row error text (2026-09-07: every row hard-fails on prod but the same
  // call succeeds locally; the reason only exists in logs we can't read).
  const limitRaw = parseInt(params.get("limit") || "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 40) : undefined;
  const instanceOnly = params.get("instance") || undefined;
  return runScheduledDeletions(limit, { force, instanceOnly });
}
