import { runScheduledDeletions } from "@/lib/cron/fire-scheduled-deletions";

// POST /api/replacement/duplicate-domains/run  (admin-only via middleware)
// Fires a batch of due scheduled deletions on demand (same executor as the
// cron) and returns { due, completed, retryNext, dueRemaining, results } so the
// UI can loop until the backlog is drained and show any per-domain failures.
export const maxDuration = 300;

const MANUAL_BATCH = 8; // small batch → responsive; UI loops for the rest

export async function POST() {
  return runScheduledDeletions(MANUAL_BATCH);
}
