import { NextResponse } from "next/server";
import {
  runProviderDomainStatusCheck,
  PROVIDER_STATUS_PROVIDERS,
  type ProviderStatusProvider,
} from "@/lib/provider-status";

export const maxDuration = 300;

/**
 * POST /api/deliverability/provider-status-check  { provider }
 *
 * Manual per-provider trigger for the domain lifecycle check — the
 * deliverability page fires one request per provider (Inboxing, MilkBox,
 * ScaledMail) in parallel so it can render live per-provider progress.
 * Same logic as the daily cron, scoped to one provider per request.
 *
 * Admin-only via middleware (viewers' GET whitelist doesn't cover POSTs).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = body?.provider as ProviderStatusProvider | undefined;
    if (!provider || !PROVIDER_STATUS_PROVIDERS.includes(provider)) {
      return NextResponse.json(
        { error: `provider must be one of: ${PROVIDER_STATUS_PROVIDERS.join(", ")}` },
        { status: 400 },
      );
    }
    const summary = await runProviderDomainStatusCheck(provider);
    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider status check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
