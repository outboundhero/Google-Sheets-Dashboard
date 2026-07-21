import { NextResponse } from "next/server";
import { inboxingRawGet } from "@/lib/inboxing";

// GET /api/inbox-orders/inboxing-credentials  (admin-only via middleware)
// Discovery probe: tries the likely Inboxing credential-list endpoints and
// returns whichever respond, so we can find the registrar / cloudflare
// credential IDs + names (e.g. the Spencersellstech vs OutboundHero registrar).
export const maxDuration = 30;

const CANDIDATES = [
  "/credentials",
  "/registrar-credentials",
  "/cloudflare-credentials",
  "/porkbun-credentials",
  "/credentials/registrar",
  "/credentials/cloudflare",
  "/registrars",
  "/registrar",
];

export async function GET() {
  try {
    const results = await Promise.all(
      CANDIDATES.map(async (path) => {
        try {
          const { status, body } = await inboxingRawGet(path);
          return { path, status, ok: status >= 200 && status < 300, body: status < 300 ? body : undefined };
        } catch (e) {
          return { path, status: -1, ok: false, error: e instanceof Error ? e.message : "failed" };
        }
      }),
    );
    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
