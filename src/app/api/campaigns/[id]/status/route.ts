import { NextResponse } from "next/server";
import { bisonFetch, resolveInstance } from "@/lib/bison";

const VALID_ACTIONS = ["resume", "pause", "archive"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const { action } = await request.json();

    if (!VALID_ACTIONS.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}` },
        { status: 400 }
      );
    }

    const res = await bisonFetch(instance, `/campaigns/${id}/${action}`, {
      method: "PATCH",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `EmailBison returned ${res.status}: ${text}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ success: true, action, instance });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
