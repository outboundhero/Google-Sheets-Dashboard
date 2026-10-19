import { NextResponse } from "next/server";
import { getBatchProgress } from "@/lib/onboarding-run";

// GET /api/external/onboarding-progress?clientTag=TAG   (Bearer EXTERNAL_API_TOKEN, middleware-exempt)
//
// What an onboarding batch for this client is doing right now — or last did,
// for an hour after — so Reply Router's checklist can show it live while its
// Run is under way: the runner's steps (tag, redirect, each campaign, the
// sheet, the whitelist queue) with their states, then the checks and the
// daily limit (onboarding-allocate writes it; src/lib/onboarding-run.ts).
// Read-only, one Redis read.
//
// 200: { clientTag, progress: { clientTag, instance, domains, startedAt,
//        updatedAt, phase: "running" | "checking" | "done" | "problems",
//        steps: [{ label, state, note? }], problems? } | null }

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const clientTag = (new URL(request.url).searchParams.get("clientTag") || "").trim().toUpperCase();
  if (!clientTag || /[\/:&,\s]/.test(clientTag)) return NextResponse.json({ error: "clientTag (one client tag) is required" }, { status: 400 });
  return NextResponse.json({ clientTag, progress: await getBatchProgress(clientTag) });
}
