import { runScheduledDeletions } from "@/lib/cron/fire-scheduled-deletions";

// 800s (Fluid): a single facilityreach domain can spend ~60s per rate-limited
// sender search, so the old 300s ceiling killed rows mid-delete.
export const maxDuration = 800;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  return runScheduledDeletions(undefined, { force });
}
