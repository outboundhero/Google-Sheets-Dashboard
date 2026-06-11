// Whitelist-email feature: builds the "please whitelist our sending domains"
// email, resolves the client's recipients from ReplyRouter, and hands the
// message to n8n (whose Gmail node actually sends it as spencer@outboundhero.co).
// Same delivery pattern as the client-report cron (see sendClientReport in
// src/lib/cron/client-reports.ts) — the app never talks SMTP directly.

const SUBJECT = "Action needed: whitelist our emails – OutboundHero";

// Static help links from Spencer's source doc.
const GMAIL_GUIDE =
  "https://docs.google.com/document/d/1mAou94uy4Nt6wBgM0CYEVg0Om_3uORRpLKuvRrVqzuc/edit?usp=sharing";
const OUTLOOK_GUIDE =
  "https://docs.google.com/document/d/1vd1TB53Ejews5ubyk6YJdo2vFCWsYw8wHpLTOPv-ev8/edit?usp=sharing";
const GATEWAY_GUIDE =
  "https://docs.google.com/document/d/1Tkm5Gr8qHm4BwtXsxd6O7J1lENzyTY18QuI9IwrcjJs/edit?usp=sharing";

const FROM_EMAIL = process.env.WHITELIST_FROM_EMAIL || "spencer@outboundhero.co";
const INTERNAL_CC = (process.env.WHITELIST_INTERNAL_CC || "nick@outboundhero.co,madison@outboundhero.co")
  .split(",").map((s) => s.trim()).filter(Boolean);

const REPLY_ROUTER_BASE_URL =
  process.env.REPLY_ROUTER_BASE_URL || "https://replies-custom-code-project.vercel.app";
const REPLY_ROUTER_SECRET = process.env.REPLY_ROUTER_SECRET || "outboundhero2024";

export interface WhitelistRecipients {
  cc: string[];
  bcc: string[];
}

/**
 * Build the whitelist email. The domain list is variable — rendered straight
 * from `domains` (one bullet / one line each), never a hardcoded count.
 */
export function buildWhitelistEmail(domains: string[]): { subject: string; text: string; html: string } {
  const cleaned = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];

  const text = [
    "Hi Team,",
    "",
    "To make sure none of our emails get quarantined or blocked, this needs to be done for every person listed on the lead handoff emails, not just one. Please make sure the instructions below are completed for each of them.",
    "",
    "We need you to whitelist the domains we send from, at the domain level. Those domains hold our sender accounts, so allowlisting the secondary domain used covers every sender account on it in one step.",
    "",
    "Domains to whitelist:",
    ...cleaned.map((d) => `  • ${d}`),
    "",
    "What to do:",
    "1. Everyone needs the Gmail or Outlook step done, so start there:",
    `   - Gmail / Google Workspace: ${GMAIL_GUIDE}`,
    `   - Outlook / Microsoft 365: ${OUTLOOK_GUIDE}`,
    "2. If your company also uses a security email gateway (like Proofpoint, Barracuda, or Mimecast), or you're not sure, ask your IT team. Then follow the right path here:",
    `   ${GATEWAY_GUIDE}`,
    "",
    "Please get this done right away. We'd like you to reply here in this same thread to confirm once it's complete so we know you're all set. If your team hits any snags, just reply and we'll help.",
    "",
    "Spencer",
    "OutboundHero",
    "Phone: (509) 800-7013",
  ].join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const domainList = cleaned.map((d) => `<li style="margin:2px 0;">${esc(d)}</li>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111;">
  <p>Hi Team,</p>
  <p>To make sure none of our emails get quarantined or blocked, this needs to be done for every person listed on the lead handoff emails, not just one. Please make sure the instructions below are completed for each of them.</p>
  <p>We need you to whitelist the domains we send from, at the domain level. Those domains hold our sender accounts, so allowlisting the secondary domain used covers every sender account on it in one step.</p>
  <p style="margin-bottom:4px;"><strong>Domains to whitelist:</strong></p>
  <ul style="margin-top:0;padding-left:22px;">${domainList}</ul>
  <p style="margin-bottom:4px;"><strong>What to do:</strong></p>
  <ol style="margin-top:0;padding-left:22px;">
    <li>Everyone needs the Gmail or Outlook step done, so start there:
      <ul style="padding-left:22px;">
        <li>Gmail / Google Workspace: <a href="${GMAIL_GUIDE}">guide</a></li>
        <li>Outlook / Microsoft 365: <a href="${OUTLOOK_GUIDE}">guide</a></li>
      </ul>
    </li>
    <li>If your company also uses a security email gateway (like Proofpoint, Barracuda, or Mimecast), or you're not sure, ask your IT team. Then follow the right path <a href="${GATEWAY_GUIDE}">here</a>.</li>
  </ol>
  <p>Please get this done right away. We'd like you to reply here in this same thread to confirm once it's complete so we know you're all set. If your team hits any snags, just reply and we'll help.</p>
  <p style="margin-bottom:0;">Spencer<br/>OutboundHero<br/>Phone: (509) 800-7013</p>
</div>`;

  return { subject: SUBJECT, text, html };
}

/** Fetch a client's CC + BCC contact emails from ReplyRouter. */
export async function fetchClientRecipients(clientTag: string): Promise<WhitelistRecipients> {
  const url = `${REPLY_ROUTER_BASE_URL}/api/config/clients/${encodeURIComponent(clientTag)}?secret=${encodeURIComponent(REPLY_ROUTER_SECRET)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`ReplyRouter ${res.status} for ${clientTag}`);
  }
  const data = (await res.json()) as { cc?: { email?: string }[]; bcc?: { email?: string }[] };
  const emails = (list?: { email?: string }[]) =>
    [...new Set((list || []).map((c) => (c.email || "").trim()).filter(Boolean))];
  return { cc: emails(data.cc), bcc: emails(data.bcc) };
}

/**
 * Send the whitelist email via the n8n webhook (Gmail node sends as From).
 * No-ops gracefully (returns sent:false) until N8N_WHITELIST_WEBHOOK_URL is set,
 * mirroring sendClientReport.
 */
export async function sendWhitelistEmail(args: {
  clientTag: string;
  domains: string[];
  to: string[];
  bcc: string[];
}): Promise<{ sent: boolean; reason?: string }> {
  const webhookUrl = process.env.N8N_WHITELIST_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[whitelist] N8N_WHITELIST_WEBHOOK_URL not set — skipping send");
    return { sent: false, reason: "N8N_WHITELIST_WEBHOOK_URL not configured" };
  }
  if (args.to.length === 0 && args.bcc.length === 0) {
    return { sent: false, reason: "no recipients" };
  }
  const { subject, text, html } = buildWhitelistEmail(args.domains);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientTag: args.clientTag,
        from: FROM_EMAIL,
        to: args.to,
        cc: INTERNAL_CC,
        bcc: args.bcc,
        subject,
        text,
        html,
        domains: args.domains,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { sent: false, reason: `n8n webhook ${res.status}: ${t.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : "request failed" };
  }
}
