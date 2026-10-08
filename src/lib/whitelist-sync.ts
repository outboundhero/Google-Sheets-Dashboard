// Daily safety net: every domain assigned to an active client reaches that
// client's sheet Domains tab and its whitelist email.
//
// Spencer 2026-10-08 (JPNYC, Proofpoint quarantine): he had to send JPNYC's
// domains to the sheet and whitelist by hand. The replacement runner and the
// true-up fill do both steps, but every other way a domain lands on a client
// skips them: "+ Add Tags", inbox orders that arrive pre-tagged, moves, tags
// set straight in Bison, and reassigned domains (whitelisted for the previous
// client, never for the new one). 298 domains on 40 active clients had never
// been queued for their client on 2026-10-08.
//
// Instead of patching each path, this compares what IS assigned against what
// was ever queued, once a day before the 6:30 AM PT batch:
//   assigned  = tagged with an active client's tag, has inboxes, not Burnt,
//               not removed / leaving (handled set)
//   missing   = no whitelist_queue row for that client + domain, any status
//   skipped   = whitelist-exempt clients, clients inside their churn blackout
// Missing domains are appended to the client's Domains tab (send-to-sheet
// dedupes rows already there) and queued; the existing whitelist-queue cron
// sends them at 6:30.
//
// It also checks each active client's ReplyRouter setup, because a client
// with no recipients can never be whitelisted — that used to surface only as
// a failed send the morning after.
import { getSupabaseAdmin } from "@/lib/supabase";
import { getClientTrackerData } from "@/lib/google-sheets";
import { getConfig } from "@/lib/sheets-config";
import { getHandledDomains } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { getChurnBlackoutMap } from "@/lib/replacement/churn-guard";
import { isWhitelistExempt } from "@/lib/whitelist-exempt";
import { fetchClientRecipients } from "@/lib/whitelist-email";

export interface SyncClient {
  clientTag: string;
  /** Tracked sheet tag send-to-sheet is called with (null = no sheet found). */
  sheetTag: string | null;
  domains: string[];
  /** How many of these were whitelisted for a different client before. */
  reassigned: number;
}

export interface RecipientProblem {
  clientTag: string;
  reason: string;
}

export interface WhitelistSyncPlan {
  activeClients: number;
  clients: SyncClient[];
  totalDomains: number;
  recipientProblems: RecipientProblem[];
  skipped: { clientTag: string; reason: string }[];
}

const bare = (tag: string) => (tag.split(":")[0] || tag).trim().toUpperCase();
const parts = (tag: string) =>
  bare(tag).split("/").flatMap((p) => p.split(" & ")).map((p) => p.trim()).filter(Boolean);

async function readAll<T>(fetchPage: (off: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await fetchPage(off);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function buildWhitelistSyncPlan(): Promise<WhitelistSyncPlan> {
  const supabase = getSupabaseAdmin();
  const [tracker, config, handled, churn] = await Promise.all([
    getClientTrackerData(),
    getConfig(),
    getHandledDomains(),
    getChurnBlackoutMap(),
  ]);

  const active = new Set(
    tracker.filter((r) => /active/i.test(r.status) && r.clientAbbr).map((r) => bare(r.clientAbbr)),
  );

  const skipped: WhitelistSyncPlan["skipped"] = [];
  const eligible = new Set<string>();
  for (const tag of active) {
    if (isWhitelistExempt(tag)) { skipped.push({ clientTag: tag, reason: "whitelist-exempt" }); continue; }
    const c = churn.get(tag);
    if (c?.blocked) { skipped.push({ clientTag: tag, reason: `churn blackout — ${c.reason}` }); continue; }
    eligible.add(tag);
  }

  const domains = await readAll<{ domain: string; instance: string; tags: string[] | null; inbox_count: number | null }>(
    (off) => supabase.from("deliverability_domains").select("domain, instance, tags, inbox_count").order("domain").range(off, off + 999),
  );
  const queued = await readAll<{ client_tag: string; domain: string }>(
    (off) => supabase.from("whitelist_queue").select("client_tag, domain").order("domain").range(off, off + 999),
  );
  const queuedFor = new Set(queued.map((r) => `${bare(r.client_tag)}|${r.domain.toLowerCase()}`));
  const queuedAnywhere = new Set(queued.map((r) => r.domain.toLowerCase()));

  // client tag → missing domains (a domain on two instances counts once)
  const missing = new Map<string, Set<string>>();
  for (const d of domains) {
    if (!d.inbox_count || hasBurntTag(d.tags)) continue;
    if (handled.has(`${d.instance}:${d.domain}`)) continue;
    const domain = d.domain.toLowerCase();
    for (const raw of d.tags || []) {
      const tag = bare(String(raw));
      if (!eligible.has(tag)) continue;
      if (queuedFor.has(`${tag}|${domain}`)) continue;
      if (!missing.has(tag)) missing.set(tag, new Set());
      missing.get(tag)!.add(domain);
    }
  }

  // The tracked sheet each tag writes to: exact tag, its ": Leads" form, or a
  // combined sheet listing the tag among its parts ("JPCIN / JPCHI"). Master
  // views are read-only collections, never a client's own Domains tab.
  const sheets = config.sheets.filter((s) => !s.masterView);
  const sheetTagFor = (tag: string): string | null => {
    const hit =
      sheets.find((s) => bare(s.clientTag) === tag) ??
      sheets.find((s) => parts(s.clientTag).includes(tag));
    return hit ? hit.clientTag : null;
  };

  const clients: SyncClient[] = [...missing.entries()]
    .map(([clientTag, set]) => {
      const list = [...set].sort();
      return {
        clientTag,
        sheetTag: sheetTagFor(clientTag),
        domains: list,
        reassigned: list.filter((d) => queuedAnywhere.has(d)).length,
      };
    })
    .sort((a, b) => b.domains.length - a.domains.length);

  // ReplyRouter setup for every eligible client — the whitelist email can only
  // go to people listed there.
  const recipientProblems: RecipientProblem[] = [];
  for (const tag of [...eligible].sort()) {
    try {
      const r = await fetchClientRecipients(tag);
      if (r.cc.length === 0 && r.bcc.length === 0) {
        recipientProblems.push({ clientTag: tag, reason: "set up in ReplyRouter but has no CC or BCC contacts" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "lookup failed";
      recipientProblems.push({
        clientTag: tag,
        reason: /404/.test(msg) ? "not set up in ReplyRouter" : `ReplyRouter lookup failed: ${msg}`,
      });
    }
  }

  return {
    activeClients: active.size,
    clients,
    totalDomains: clients.reduce((s, c) => s + c.domains.length, 0),
    recipientProblems,
    skipped,
  };
}
