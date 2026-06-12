import { NextResponse } from "next/server";
import { runAttachNurture } from "@/app/api/deliverability/attach-nurture-inboxes/route";

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || authHeader !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const result = await runAttachNurture(searchParams);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
