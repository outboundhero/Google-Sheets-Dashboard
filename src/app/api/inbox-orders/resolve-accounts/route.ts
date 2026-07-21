import { NextResponse } from "next/server";
import { resolveDomainRegistrars } from "@/lib/inboxing-registrar";

// POST /api/inbox-orders/resolve-accounts  (admin-only via middleware)
// Body: { domains: string[] } → which Porkbun account each domain belongs to
// (from the All Domains inventory) + whether we have an Inboxing registrar for
// it. Lets the Create / Bulk Import UIs flag mixed accounts + block unknowns
// BEFORE an order is placed.
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains: string[] = raw
      .filter((d: unknown): d is string => typeof d === "string")
      .map((d: string) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });

    const map = await resolveDomainRegistrars(domains);
    const results = domains.map((d) => {
      const r = map.get(d);
      return {
        domain: d,
        source: r?.source ?? null,
        accountLabel: r?.accountLabel ?? null,
        ok: !!r?.ok,
        reason: r?.reason ?? null,
      };
    });

    // Group by account for the "different orders per account" flag.
    const byAccount: Record<string, string[]> = {};
    for (const r of results) {
      const key = r.ok && r.accountLabel ? r.accountLabel : "Unknown";
      (byAccount[key] ||= []).push(r.domain);
    }

    return NextResponse.json({
      results,
      byAccount,
      accounts: Object.keys(byAccount),
      hasUnknown: results.some((r) => !r.ok),
      mixed: Object.keys(byAccount).filter((k) => k !== "Unknown").length > 1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
