import { NextResponse } from "next/server";
import { resolveDomainOrders } from "@/lib/inbox-order-accounts";
import type { InboxOrderProvider } from "@/types/inbox-order";

// POST /api/inbox-orders/resolve-accounts  (admin-only via middleware)
// Body: { domains: string[], provider?: "inboxing"|"milkbox"|"scaledmail" }
// → which Porkbun account each domain belongs to + whether the (selected)
// provider has a credential for it. Lets the Create / Bulk Import UIs flag mixed
// accounts + block unknowns BEFORE an order is placed.
export const maxDuration = 30;

function isProvider(v: unknown): v is InboxOrderProvider {
  return v === "inboxing" || v === "milkbox" || v === "scaledmail";
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Array.isArray(body?.domains) ? body.domains : [];
    const domains: string[] = raw
      .filter((d: unknown): d is string => typeof d === "string")
      .map((d: string) => d.trim().toLowerCase())
      .filter(Boolean);
    if (domains.length === 0) return NextResponse.json({ error: "domains required" }, { status: 400 });
    const provider: InboxOrderProvider = isProvider(body?.provider) ? body.provider : "inboxing";

    const map = await resolveDomainOrders(domains, provider);
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

    const byAccount: Record<string, string[]> = {};
    for (const r of results) {
      const key = r.ok && r.accountLabel ? r.accountLabel : "Unknown";
      (byAccount[key] ||= []).push(r.domain);
    }

    return NextResponse.json({
      provider,
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
