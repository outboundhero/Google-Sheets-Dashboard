import { NextResponse } from "next/server";
import { milkboxRawGet } from "@/lib/milkbox";

// GET /api/inbox-orders/provider-accounts  (admin-only via middleware)
// Discovery probe for MilkBox: lists domain-provider / sequencer accounts (like
// the Inboxing /registrars probe) so we can tell whether MilkBox has more than
// one Porkbun account and needs per-domain account selection like Inboxing.
export const maxDuration = 30;

const MILKBOX_CANDIDATES = [
  "/domain-providers",
  "/domain_providers",
  "/sequencers",
  "/providers",
  "/domain-provider",
];

export async function GET() {
  try {
    const milkbox = await Promise.all(
      MILKBOX_CANDIDATES.map(async (path) => {
        try {
          const { status, body } = await milkboxRawGet(path);
          return { path, status, ok: status >= 200 && status < 300, body: status < 300 ? body : undefined };
        } catch (e) {
          return { path, status: -1, ok: false, error: e instanceof Error ? e.message : "failed" };
        }
      }),
    );
    return NextResponse.json({
      milkbox,
      note: "ScaledMail hosts via a single Porkbun username/password (SCALEDMAIL_PORKBUN_USERNAME) — one account by design; no list endpoint.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
