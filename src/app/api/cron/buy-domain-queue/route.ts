import { runBuyQueue } from "@/lib/cron/buy-domain-queue";

export const maxDuration = 300;

export async function GET() {
  return runBuyQueue();
}
