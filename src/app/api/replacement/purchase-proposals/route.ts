import { NextResponse } from "next/server";
import { listProposals, generateProposals, decideProposal } from "@/lib/replacement/purchase-proposal";

export const maxDuration = 120;

// GET  /api/replacement/purchase-proposals — list (newest first). Admin-only.
// POST { action: "generate" } — propose now (candidate names only, buys nothing)
// POST { action: "decide", id, status: "approved"|"rejected", results? } —
//      record the human decision + per-domain outcomes from the approval run.
export async function GET() {
  try {
    return NextResponse.json({ proposals: await listProposals() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: string; id?: number; status?: "approved" | "rejected"; results?: Record<string, string>;
    };
    if (body.action === "generate") {
      return NextResponse.json(await generateProposals());
    }
    if (body.action === "decide" && typeof body.id === "number" && (body.status === "approved" || body.status === "rejected")) {
      return NextResponse.json({ proposal: await decideProposal(body.id, body.status, body.results) });
    }
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
