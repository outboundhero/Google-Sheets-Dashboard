import { NextResponse } from "next/server";
import { porkbunAccounts, updateAutoRenew } from "@/lib/porkbun-domains";

// POST /api/deliverability/domains-auto-renew (admin-only)
// Body: { items: [{ account, domain }], enabled: boolean }
// Turns auto-renew on/off in Porkbun for each domain on its own account, with
// low concurrency + retry. Returns per-domain outcomes. The FE drives it in
// batches through the persistent progress panel.
export const maxDuration = 120;

const CONCURRENCY = 3; // Porkbun rate-limits; keep it gentle

interface Item { account: string; domain: string }

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { items?: Item[]; enabled?: boolean };
    const items = body.items || [];
    const enabled = body.enabled === true;
    if (items.length === 0) return NextResponse.json({ error: "items required" }, { status: 400 });

    const accts = porkbunAccounts();
    const byLabel = new Map(accts.map((a) => [a.label, a]));

    const results: { domain: string; status: "ok" | "failed"; error?: string }[] = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (it) => {
          const acct = byLabel.get(it.account);
          if (!acct) return { domain: it.domain, status: "failed" as const, error: `unknown account "${it.account}"` };
          try {
            await updateAutoRenew(acct, it.domain, enabled);
            return { domain: it.domain, status: "ok" as const };
          } catch (e) {
            return { domain: it.domain, status: "failed" as const, error: e instanceof Error ? e.message : "failed" };
          }
        }),
      );
      results.push(...settled);
    }

    return NextResponse.json({
      enabled,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
