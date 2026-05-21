import { runDeliverabilitySync } from "@/lib/cron/sync-deliverability";

export const maxDuration = 60;

export async function GET() {
  return runDeliverabilitySync("outboundclean");
}
