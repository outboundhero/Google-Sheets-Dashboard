import { runScheduledDeletions } from "@/lib/cron/fire-scheduled-deletions";

export const maxDuration = 300;

export async function GET() {
  return runScheduledDeletions();
}
