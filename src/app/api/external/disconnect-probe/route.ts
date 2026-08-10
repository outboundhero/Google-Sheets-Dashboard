import { NextResponse } from "next/server";
import { bisonFetch } from "@/lib/bison";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

// TEMP probe: validate the reconnect approach — resolve the "Inboxing" tag id
// per instance + count not_connected senders (total and Inboxing-only). Remove after.
export const maxDuration = 60;
const TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

async function total(instance: (typeof ALL_INSTANCE_SLUGS)[number], qs: string): Promise<number | string> {
  try {
    const res = await bisonFetch(instance, `/sender-emails?per_page=1&${qs}`);
    if (!res.ok) return `HTTP ${res.status}`;
    const j = await res.json();
    return j?.meta?.total ?? (Array.isArray(j?.data) ? j.data.length : "?");
  } catch (e) { return e instanceof Error ? e.message : "err"; }
}

async function inboxingTagId(instance: (typeof ALL_INSTANCE_SLUGS)[number]): Promise<{ id: number | null; names: string[] }> {
  try {
    const res = await bisonFetch(instance, `/tags?search=Inboxing&per_page=50`);
    if (!res.ok) return { id: null, names: [`HTTP ${res.status}`] };
    const j = await res.json();
    const tags = (j?.data || []) as { id: number; name: string }[];
    const exact = tags.find((t) => (t.name || "").trim().toLowerCase() === "inboxing");
    return { id: exact?.id ?? null, names: tags.map((t) => `${t.name}#${t.id}`) };
  } catch (e) { return { id: null, names: [e instanceof Error ? e.message : "err"] }; }
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const out = [];
  for (const inst of ALL_INSTANCE_SLUGS) {
    const tag = await inboxingTagId(inst);
    const notConnectedTotal = await total(inst, "status=not_connected");
    const notConnectedInboxing = tag.id ? await total(inst, `status=not_connected&tag_ids[]=${tag.id}`) : "no-tag";
    const connectedTotal = await total(inst, "status=connected");
    out.push({ instance: inst, inboxingTagId: tag.id, tagsSeen: tag.names, notConnectedTotal, notConnectedInboxing, connectedTotal });
  }
  return NextResponse.json({ results: out });
}
