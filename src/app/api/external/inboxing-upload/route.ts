import { NextResponse } from "next/server";
import { isInstanceSlug, ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";
import { inboxingConnectionFor } from "@/lib/replacement/inboxing-connections";
import { uploadEmailsToPlatform, findDomainByName } from "@/lib/inboxing";

// POST /api/external/inboxing-upload  (Bearer EXTERNAL_API_TOKEN, middleware-exempt)
// Uploads a single email account to the Inboxing platform connection for the
// given Bison instance. enable_warmup=true, skip_verified=false, sync_tags=false.
// Body (or query): { email, instance }  — instance is a slug e.g. "outboundhero".
// The email's domain MUST be an Inboxing-provisioned domain — inboxes from any
// other provider (ScaledMail, MilkBox, …) are rejected.
export const maxDuration = 60;
const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as { email?: string; instance?: string };
    const email = (body.email || url.searchParams.get("email") || "").trim().toLowerCase();
    const instance = (body.instance || url.searchParams.get("instance") || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "a valid 'email' is required" }, { status: 400 });
    }
    if (!isInstanceSlug(instance)) {
      return NextResponse.json({ error: `'instance' must be one of: ${ALL_INSTANCE_SLUGS.join(", ")}` }, { status: 400 });
    }

    // Gate: the email's domain must be an Inboxing-provisioned domain. Any other
    // provider's inbox is rejected before we attempt an upload.
    const domain = email.split("@")[1];
    const inboxingDomain = await findDomainByName(domain);
    if (!inboxingDomain) {
      return NextResponse.json(
        { error: `not an Inboxing inbox — domain "${domain}" is not on Inboxing`, email, domain, isInboxing: false },
        { status: 422 },
      );
    }

    const platformConnectionId = inboxingConnectionFor(instance);
    const result = await uploadEmailsToPlatform([email], platformConnectionId);

    return NextResponse.json({
      email,
      instance,
      domain,
      isInboxing: true,
      inboxingDomainId: inboxingDomain.id,
      platformConnectionId,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
