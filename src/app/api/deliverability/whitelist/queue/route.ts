import { NextResponse } from "next/server";
import { enqueueDomains } from "@/lib/whitelist-queue";

// POST { clientTag, domains[] } → queue domains for the next 6:30am PST
// whitelist-email batch. Idempotent: already queued/sent domains are skipped.
export async function POST(request: Request) {
  try {
    const { clientTag, domains } = (await request.json()) as {
      clientTag?: string;
      domains?: string[];
    };
    if (!clientTag || !Array.isArray(domains) || domains.length === 0) {
      return NextResponse.json({ error: "clientTag and domains are required" }, { status: 400 });
    }
    const result = await enqueueDomains(clientTag, domains);
    return NextResponse.json({ ok: true, clientTag, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to queue domains";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
