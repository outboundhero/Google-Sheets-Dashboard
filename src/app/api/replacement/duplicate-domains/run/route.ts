import { runScheduledDeletions } from "@/lib/cron/fire-scheduled-deletions";

// POST /api/replacement/duplicate-domains/run  (admin-only via middleware)
// Fires a batch of due scheduled deletions on demand (same executor as the
// cron) and returns { due, completed, retryNext, dueRemaining, results } so the
// UI can loop until the backlog is drained and show any per-domain failures.
// Body { force: true } ignores the 3-day grace and works the oldest pending
// rows regardless of their scheduled date (Spencer's "force these through").
export const maxDuration = 800;

const MANUAL_BATCH = 8; // small batch → responsive; UI loops for the rest

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const force = (body as { force?: boolean })?.force === true;
  return runScheduledDeletions(MANUAL_BATCH, { force });
}
