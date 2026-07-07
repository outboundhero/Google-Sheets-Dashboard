import { NextResponse } from "next/server";
import { runProviderDomainStatusCheck } from "@/lib/provider-status";

// Vercel Pro cap. One full pass fits well under it.
export const maxDuration = 300;

// Daily lifecycle check for every Inboxing / MilkBox / ScaledMail-tagged
// domain. All the logic lives in runProviderDomainStatusCheck so the manual
// per-provider trigger on the deliverability page shares it.
export async function GET() {
  try {
    const summary = await runProviderDomainStatusCheck();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider-domain-status cron failed";
    console.error("[cron/provider-domain-status]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
