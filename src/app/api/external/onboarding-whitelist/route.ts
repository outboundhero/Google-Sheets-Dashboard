import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getHandledDomains } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { isWhitelistExempt } from "@/lib/whitelist-exempt";
import { buildWhitelistEmail, fetchClientRecipients, whitelistEnvelope } from "@/lib/whitelist-email";

// POST /api/external/onboarding-whitelist   (Bearer EXTERNAL_API_TOKEN, middleware-exempt)
//
// Reply Router's onboarding checklist ("Whitelisting domains email to clients")
// asks what the whitelist email for a new client would be: who it goes to and
// which of the client's domains it would list.
//
// READ-ONLY. Only { dryRun: true } is accepted: it reports the email and stops.
// Nothing here sends, queues or marks anything.
//
// Same rules as the daily whitelist sync (src/lib/whitelist-sync.ts), for one
// client: a domain counts when it carries the client's tag, has inboxes, is not
// Burnt and is not removed / leaving. Recipients and wording come from the
// functions the 6:30 AM batch and "send now" use, so the preview is the email.
//
// One thing is stricter than "send now": a domain is treated as already sent
// when ANY stored form of the client's tag has it as sent ("TAG", "TAG: Leads",
// or a combined sheet tag listing it) — "send now" only looks at the exact tag
// it is called with, and the point here is that nobody gets the email twice.
//
// Body:  { clientTag, dryRun: true }
// 200:   { dryRun, clientTag, exempt, webhookConfigured,
//          from, to, cc, bcc, recipientProblem, subject, text,
//          domains: { assigned, toSend, queued, alreadySent: [{ domain, sentAt }],
//                     burnt, leaving, noInboxes },
//          queuedUnder }
//        toSend  = assigned domains this client has not been emailed about yet
//        queued  = the part of toSend already waiting for the 6:30 AM PT batch
//        queuedUnder = the stored tag forms those waiting rows sit under

const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";

export const maxDuration = 60;

interface Body {
  clientTag?: string;
  dryRun?: boolean;
}

/** The client tags a stored queue tag stands for: "EXCL: Leads" → EXCL,
 *  "DBSM / DBSA" → DBSM, DBSA. */
const tagParts = (stored: string) =>
  stored
    .split("/")
    .flatMap((p) => p.split(" & "))
    .map((p) => (p.split(":")[0] || p).trim().toUpperCase())
    .filter(Boolean);

interface OnboardingWhitelistPlan {
  dryRun: true;
  clientTag: string;
  exempt: boolean;
  webhookConfigured: boolean;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  recipientProblem: string | null;
  subject: string;
  text: string;
  domains: {
    assigned: number;
    toSend: string[];
    queued: string[];
    alreadySent: { domain: string; sentAt: string | null }[];
    burnt: string[];
    leaving: string[];
    noInboxes: string[];
  };
  queuedUnder: string[];
}

async function buildPlan(clientTag: string): Promise<OnboardingWhitelistPlan> {
  const supabase = getSupabaseAdmin();

  // The client's domains, read strictly — a failed read must not look like
  // "no domains". Tag names are matched as the client tag is normally written
  // (capitals) and in lower case, like the onboarding allocation does.
  const own = await supabase
    .from("deliverability_domains")
    .select("domain, instance, tags, inbox_count")
    .overlaps("tags", [...new Set([clientTag, clientTag.toLowerCase()])]);
  if (own.error) throw new Error(`could not read ${clientTag}'s domains: ${own.error.message}`);
  const rows = (own.data || []) as { domain: string; instance: string; tags: string[] | null; inbox_count: number | null }[];

  const handled = rows.length > 0 ? await getHandledDomains() : new Set<string>();

  // A domain on two instances counts once; it is usable if it is on either.
  const live = new Set<string>();
  const burnt = new Set<string>();
  const leaving = new Set<string>();
  const noInboxes = new Set<string>();
  for (const r of rows) {
    const domain = r.domain.trim().toLowerCase();
    if (!domain) continue;
    if (hasBurntTag(r.tags)) burnt.add(domain);
    else if (handled.has(`${r.instance}:${r.domain}`)) leaving.add(domain);
    else if (!r.inbox_count) noInboxes.add(domain);
    else live.add(domain);
  }
  const assigned = [...live].sort();
  const only = (set: Set<string>) => [...set].filter((d) => !live.has(d)).sort();

  // What the queue already holds for these domains, under any form of the tag.
  const sentAt = new Map<string, string | null>();
  const waiting = new Set<string>();
  const queuedUnder = new Set<string>();
  for (let i = 0; i < assigned.length; i += 100) {
    const q = await supabase
      .from("whitelist_queue")
      .select("client_tag, domain, status, sent_at")
      .in("domain", assigned.slice(i, i + 100));
    if (q.error) throw new Error(`could not read the whitelist queue: ${q.error.message}`);
    for (const r of (q.data || []) as { client_tag: string; domain: string; status: string; sent_at: string | null }[]) {
      if (!tagParts(r.client_tag || "").includes(clientTag)) continue;
      const domain = r.domain.trim().toLowerCase();
      if (r.status === "sent") {
        const prev = sentAt.get(domain);
        if (!sentAt.has(domain) || (r.sent_at && (!prev || r.sent_at > prev))) sentAt.set(domain, r.sent_at);
      } else {
        waiting.add(domain);
        queuedUnder.add(r.client_tag);
      }
    }
  }
  const toSend = assigned.filter((d) => !sentAt.has(d));

  const exempt = isWhitelistExempt(clientTag);
  let to: string[] = [];
  let bcc: string[] = [];
  let recipientProblem: string | null = null;
  if (!exempt) {
    try {
      const r = await fetchClientRecipients(clientTag);
      to = r.cc;
      bcc = r.bcc;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "lookup failed";
      recipientProblem = /404/.test(msg) ? `${clientTag} is not set up in ReplyRouter` : `ReplyRouter lookup failed: ${msg}`;
    }
  }
  const envelope = whitelistEnvelope(clientTag, to);
  if (!exempt && !recipientProblem && envelope.to.length === 0 && bcc.length === 0) {
    recipientProblem = `${clientTag} is set up in ReplyRouter but has no CC or BCC contacts`;
  }
  const email = buildWhitelistEmail(toSend);

  return {
    dryRun: true,
    clientTag,
    exempt,
    webhookConfigured: !!process.env.N8N_WHITELIST_WEBHOOK_URL,
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    bcc,
    recipientProblem,
    subject: email.subject,
    text: email.text,
    domains: {
      assigned: assigned.length,
      toSend,
      queued: toSend.filter((d) => waiting.has(d)),
      alreadySent: assigned.filter((d) => sentAt.has(d)).map((d) => ({ domain: d, sentAt: sentAt.get(d) ?? null })),
      burnt: only(burnt),
      leaving: only(leaving),
      noInboxes: only(noInboxes),
    },
    queuedUnder: [...queuedUnder].sort(),
  };
}

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${EXTERNAL_API_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    if (body.dryRun !== true) {
      return NextResponse.json({ error: "only { dryRun: true } is supported — this route does not send" }, { status: 400 });
    }
    const clientTag = (typeof body.clientTag === "string" ? body.clientTag : "").trim().toUpperCase();
    // One plain client tag: a sheet suffix or a combined tag belongs to the
    // queue's own handling, not to a new client's onboarding.
    if (!clientTag || /[\/:&,\s]/.test(clientTag)) {
      return NextResponse.json({ error: "clientTag must be a single client tag" }, { status: 400 });
    }
    return NextResponse.json(await buildPlan(clientTag));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
