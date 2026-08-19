import { NextResponse } from "next/server";
import { getHiddenTags, hideTags, unhideTags, WRONG_INSTANCE_SCOPE } from "@/lib/replacement/tag-skips";

// Hidden client tags for the wrong-instance card (Spencer 2026-08-20).
//   GET                                   → { hidden: [...] }
//   POST { action: "hide"|"unhide", tags } → toggle
// Display-only: hiding never changes what the detector computes.

export async function GET(request: Request) {
  try {
    const scope = new URL(request.url).searchParams.get("scope") || WRONG_INSTANCE_SCOPE;
    return NextResponse.json({ hidden: await getHiddenTags(scope) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: "hide" | "unhide";
      tags?: unknown;
      reason?: string;
      scope?: string;
    };
    const action = body.action;
    if (action !== "hide" && action !== "unhide") {
      return NextResponse.json({ error: "action must be hide or unhide" }, { status: 400 });
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [];
    if (tags.length === 0) {
      return NextResponse.json({ error: "tags required" }, { status: 400 });
    }
    const scope = body.scope || WRONG_INSTANCE_SCOPE;
    const count =
      action === "hide"
        ? await hideTags(tags, body.reason ?? null, scope)
        : await unhideTags(tags, scope);
    return NextResponse.json({ action, count, hidden: await getHiddenTags(scope) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
