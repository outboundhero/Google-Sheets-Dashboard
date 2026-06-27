import { NextResponse } from "next/server";
import {
  getAssignedDomains, getKnownClientTags, auditDomainsBatch, storeFlagged,
  clearAudit, getFlagged, clearDomain, type DomainRef,
} from "@/lib/replacement/cross-tag-audit";

export const maxDuration = 120;

// GET /api/replacement/cross-tag-audit          → stored flagged domains
// GET /api/replacement/cross-tag-audit?list=domains → the (instance,domain) list to iterate
// Admin-only via middleware.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("list") === "domains") {
      return NextResponse.json({ domains: await getAssignedDomains() });
    }
    return NextResponse.json({ flagged: await getFlagged() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

// POST — two actions:
//   run:   { action?: "run", domains: [{instance,domain}], reset?: boolean }
//          audits one chunk of domains (FE loops); reset clears prior results first.
//   clear: { action: "clearDomain", instance, domain }
//          drop a domain's row once it's been cleaned.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.action === "clearDomain") {
      await clearDomain(body.instance, body.domain);
      return NextResponse.json({ ok: true });
    }
    const domains = (body.domains || []) as DomainRef[];
    if (body.reset) await clearAudit();
    if (domains.length === 0) return NextResponse.json({ flaggedCount: 0, processed: 0 });

    const knownTags = await getKnownClientTags();
    const flagged = await auditDomainsBatch(domains, knownTags);
    await storeFlagged(flagged);
    return NextResponse.json({ flaggedCount: flagged.length, processed: domains.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
