import { runCampaignsSync } from "@/lib/cron/sync-campaigns";

export const maxDuration = 60;

export async function GET() {
  return runCampaignsSync("cleaningoutbound");
}
