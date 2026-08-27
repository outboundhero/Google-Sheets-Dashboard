// Per-client whitelist send, factored out so the daily cron and the dashboard
// "Retry" button run the exact same path (no drift). Pure: it sends + marks
// sent, returns a structured result, and NEVER touches Slack or the alert store
// — the caller decides what to record. partitionByClientSubTags now strips the
// ": Leads" suffix, so ReplyRouter lookups resolve to the bare client tag.
import { fetchClientRecipients, sendWhitelistEmail } from "@/lib/whitelist-email";
import { markSent, partitionByClientSubTags } from "@/lib/whitelist-queue";
import { isWhitelistExempt } from "@/lib/whitelist-exempt";

export interface WhitelistFailure {
  /** Which step broke: partition | drop-burnt | no-subtag | send. */
  step: string;
  /** Bare sub-tag (or the client tag) the failure belongs to. */
  subTag: string;
  reason: string;
  domains: string[];
}

export interface WhitelistClientResult {
  clientTag: string;
  sentEmails: number;
  sentDomains: number;
  burntDropped: number;
  failures: WhitelistFailure[];
  /** Client is on the no-whitelist-email list — domains marked done, no send. */
  exempt?: boolean;
}

/**
 * Send whitelist emails for ONE client's queued domains.
 *
 * `clientTag` is the stored (possibly suffixed / compound) tag — it stays the
 * key used for markSent so DB rows line up. The bare sub-tags produced by the
 * partition are what get sent to ReplyRouter + used as the email's client tag.
 */
export async function runWhitelistForClient(
  clientTag: string,
  domains: string[],
): Promise<WhitelistClientResult> {
  const res: WhitelistClientResult = {
    clientTag,
    sentEmails: 0,
    sentDomains: 0,
    burntDropped: 0,
    failures: [],
  };

  // Exempt client (Spencer 2026-08-28, DM4PM → outside agency works the
  // leads, so there is no client inbox to whitelist against): mark the
  // domains complete and send nothing. No failure, no alert, no re-queue.
  if (isWhitelistExempt(clientTag)) {
    await markSent(clientTag, domains);
    res.sentDomains = domains.length;
    res.exempt = true;
    return res;
  }

  let partition;
  try {
    partition = await partitionByClientSubTags(clientTag, domains);
  } catch (err) {
    res.failures.push({
      step: "partition",
      subTag: clientTag,
      reason: err instanceof Error ? err.message : "failed to partition domains",
      domains,
    });
    return res;
  }

  const { buckets, burnt, unmatched } = partition;

  if (burnt.length > 0) {
    try {
      await markSent(clientTag, burnt); // clear retiring domains from the queue
      res.burntDropped += burnt.length;
    } catch (err) {
      res.failures.push({
        step: "drop-burnt",
        subTag: clientTag,
        reason: err instanceof Error ? err.message : "failed to clear burnt domains",
        domains: burnt,
      });
    }
  }

  if (unmatched.length > 0) {
    // Compound-tag domains carrying no sub-client tag in Bison — can't be
    // routed to a recipient. Surfaced as a real failure so it doesn't vanish.
    res.failures.push({
      step: "no-subtag",
      subTag: clientTag,
      reason: "domains carry no sub-client tag in Bison — cannot route to a recipient",
      domains: unmatched,
    });
  }

  for (const [subTag, subDomains] of buckets) {
    try {
      const { cc, bcc } = await fetchClientRecipients(subTag);
      const sent = await sendWhitelistEmail({ clientTag: subTag, domains: subDomains, to: cc, bcc });
      if (!sent.sent) {
        res.failures.push({ step: "send", subTag, reason: sent.reason || "email not sent", domains: subDomains });
        continue;
      }
      await markSent(clientTag, subDomains);
      res.sentEmails++;
      res.sentDomains += subDomains.length;
    } catch (err) {
      res.failures.push({
        step: "send",
        subTag,
        reason: err instanceof Error ? err.message : "recipient lookup / send failed",
        domains: subDomains,
      });
    }
  }

  return res;
}
