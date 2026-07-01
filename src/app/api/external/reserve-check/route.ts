// TEMPORARY diagnostic — calls the deployed buildReplacementPlan and returns
// just the reserve summary so we can verify the /replacement page is getting
// what we expect. Bearer-authed. Delete once the reserve pool display is
// working end-to-end.
import { NextResponse } from "next/server";
import { buildReplacementPlan } from "@/lib/replacement/plan";

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const maxDuration = 120;

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const plan = await buildReplacementPlan();
    return NextResponse.json({
      reserveReadyByInstance: plan.reserveReadyByInstance,
      reserveListLength: plan.reserveList?.length ?? null,
      reserveListSample: (plan.reserveList ?? []).slice(0, 10),
      generatedFor: plan.generatedFor,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
