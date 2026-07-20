import { NextResponse } from "next/server";
import { buildAliasesFromNameSpec } from "@/lib/inbox-order-aliases";
import { MAILBOX_COUNT_BY_PROVIDER, type InboxOrderProvider, type NameSpec } from "@/types/inbox-order";

// POST /api/inbox-orders/preview-names (admin-only via middleware)
// Body: { provider, nameMode: "auto"|"manual", personaCount: 1|2, names?: [{first_name,last_name}] }
// → { personas, aliases, mailboxCount }
// Lets the Create dialog show + let the user edit the sender names/aliases
// BEFORE the order is placed.
export const maxDuration = 30;

function isValidProvider(p: unknown): p is InboxOrderProvider {
  return p === "scaledmail" || p === "milkbox" || p === "inboxing";
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = body?.provider;
    if (!isValidProvider(provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    const spec: NameSpec = {
      nameMode: body?.nameMode === "manual" ? "manual" : "auto",
      personaCount: body?.personaCount === 2 ? 2 : 1,
      names: Array.isArray(body?.names) ? body.names : undefined,
    };
    const { personas, aliases } = await buildAliasesFromNameSpec(provider, spec);
    return NextResponse.json({ personas, aliases, mailboxCount: MAILBOX_COUNT_BY_PROVIDER[provider] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
