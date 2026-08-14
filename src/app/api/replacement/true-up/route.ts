import { NextResponse } from "next/server";
import { computeTrueUp } from "@/lib/replacement/true-up";

export const maxDuration = 60;

// GET /api/replacement/true-up — OBSERVE-ONLY.
//
// Nick 2026-08-13: "every single Tier .5 and tier 1 client will always need 20
// domains in B2B. Nothing more and nothing less." This reports what it would
// take to put every live client at exactly its tier's cap — the FILL side (pull
// reserves in) and the TRIM side (untag the worst performers back to reserve).
//
// Executes nothing: no tagging, untagging, moving or deleting. The trim ranking
// is still provisional (waiting on Nick's answer on which metric defines "better
// performing"), so the numbers are here to be checked against reality first.
//
// Query params override the provisional ranking for a what-if:
//   ?minSent=<n>       send-volume floor below which a domain is never trimmed
//   ?bounceWeight=<n>  0 = rank on reply rate alone; >0 penalises bounce rate
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // An absent param must leave the default alone. `Number(null)` is 0, which
    // passed the `>= 0` check and silently pinned the send floor to zero on
    // every plain page load — nothing counted as unproven except missing data.
    const num = (key: string) => {
      const raw = searchParams.get(key);
      return raw === null || raw.trim() === "" ? NaN : Number(raw);
    };
    const minSent = num("minSent");
    const bounceWeight = num("bounceWeight");

    const result = await computeTrueUp({
      ranking: {
        ...(Number.isFinite(minSent) && minSent >= 0 ? { minSentToTrim: minSent } : {}),
        ...(Number.isFinite(bounceWeight) && bounceWeight >= 0 ? { bounceWeight } : {}),
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "true-up failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
