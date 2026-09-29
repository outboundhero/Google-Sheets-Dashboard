import type { InboxOrder, InboxOrderProvider, InboxOrderStatus } from "@/types/inbox-order";

// "One order" the way a person places it — a single Create or Bulk Import
// submission — rebuilt from inbox_orders, which stores one row per domain and
// nothing that ties a submission together (provider_order_id and
// parent_order_id are empty on every row). A submission's rows are created
// seconds apart; separate submissions are hours apart. Across all 1,233 rows on
// 2026-09-30, 1,191 consecutive gaps were under 10s and all but 5 under a
// minute, and the next gap up was over an hour — any cutoff from 15 to 60
// minutes yields the same 19 orders. 30 sits in the middle of that.
export const BATCH_GAP_MS = 30 * 60 * 1000;

// The poll cron (every 6h) re-checks at most 100 still-pending orders per run,
// oldest-checked first, so with N pending a given order is checked every
// ceil(N/100) × 6h. Two hours of slack on top keeps "not checked" quiet unless
// LeadSync has genuinely stopped talking to the provider.
const POLL_EVERY_MS = 6 * 60 * 60 * 1000;
const POLL_BATCH = 100;
const POLL_SLACK_MS = 2 * 60 * 60 * 1000;
export function checkOverdueAfterMs(pendingAcrossAllInstances: number): number {
  return POLL_EVERY_MS * Math.max(1, Math.ceil(pendingAcrossAllInstances / POLL_BATCH)) + POLL_SLACK_MS;
}

// Created at the provider but not in any Bison instance after this long =
// stuck, not "still uploading". Uploads normally land within a day or two.
export const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export type MemberState =
  | "failed"      // provider could not set it up, not ordered again since
  | "stuck"       // set up at the provider, never reached Bison
  | "partial"     // in Bison, fewer mailboxes than ordered
  | "setting-up"  // provider still provisioning
  | "uploading"   // provisioned, on its way into Bison
  | "reordered"   // failed here, but ordered again later
  | "live"        // in Bison with every mailbox
  | "removed";    // deleted or swapped out afterwards — not a fault of the order

export interface BatchMember {
  id: string;
  domain: string;
  state: MemberState;
  mailboxesOrdered: number;
  /** From the last Bison sync; null when no instance has it yet. */
  mailboxesInBison: number | null;
  /** Instance label the mailboxes now sit in, when not the one ordered for. */
  movedTo: string | null;
  /** Plain-English reason, only where there is something to act on or wait for. */
  note: string | null;
}

export interface InboxOrderBatch {
  key: string;
  provider: InboxOrderProvider;
  instance: string;
  inboxingAccount: string | null;
  placedAt: string;
  domains: number;
  mailboxesOrdered: number;
  /** Domains with mailboxes in Bison (any instance), partial ones included. */
  live: number;
  partial: number;
  settingUp: number;
  uploading: number;
  stuck: number;
  failed: number;
  reordered: number;
  removed: number;
  /** Mailboxes ordered on the domains that are live — what should be in Bison. */
  mailboxesExpected: number;
  mailboxesInBison: number;
  missingMailboxes: number;
  /** Latest provider status check on anything still being set up. */
  lastCheckedAt: string | null;
  /** Something still being set up hasn't been checked within the poll cadence. */
  checkOverdue: boolean;
  /** Most recent Bison sync behind the mailbox counts. */
  bisonSyncedAt: string | null;
  members: BatchMember[];
}

export type BatchRow = Pick<
  InboxOrder,
  | "id" | "provider" | "instance" | "inboxing_account" | "status" | "setup_stage"
  | "failure_reason" | "domain" | "mailbox_count" | "created_at" | "completed_at" | "last_checked_at"
>;

/** Where a domain's mailboxes are in Bison, per the last deliverability sync. */
export interface BisonPresence { instance: string; mailboxes: number; syncedAt: string | null }

export interface LaterOrder { instance: string; status: InboxOrderStatus; created_at: string }

/**
 * Provider messages rewritten for someone reading the page, not the API.
 *
 * "Upload will be available in N" is Inboxing throttling uploads to Bison. It
 * was being shown in red on domains that had already landed — 265 of them on
 * 2026-09-30, the red text in Nick's screenshot — because the message is kept
 * after the upload later succeeds. It means "queued", never "failed".
 */
export function plainReason(raw: string | null): string | null {
  if (!raw) return null;
  if (/upload will be available/i.test(raw)) return "Waiting for a slot in Inboxing's upload queue";
  if (/exists in another Microsoft account/i.test(raw)) {
    return "Claimed by another Microsoft tenant — the provider has to release it";
  }
  if (/nameserver update not detected/i.test(raw)) return "Nameservers not updated yet";
  return raw;
}

const PENDING: ReadonlySet<InboxOrderStatus> = new Set(["pending", "swapping"]);
const REMOVED: ReadonlySet<InboxOrderStatus> = new Set(["deleted", "deleting", "swapped"]);

const STATE_ORDER: Record<MemberState, number> = {
  failed: 0, stuck: 1, partial: 2, "setting-up": 3, uploading: 4, reordered: 5, live: 6, removed: 7,
};

const days = (ms: number) => Math.max(1, Math.round(ms / 86_400_000));

/**
 * @param rows          order rows for the instances in view
 * @param inBison       per domain, every instance holding its mailboxes
 * @param laterOrders   every order row for the domains that failed, any instance
 * @param instanceLabel slug → display label, for "moved to" notes
 */
export function buildBatches(
  rows: BatchRow[],
  inBison: Map<string, BisonPresence[]>,
  laterOrders: Map<string, LaterOrder[]>,
  opts: { now?: number; checkOverdueMs: number; instanceLabel: (slug: string) => string },
): InboxOrderBatch[] {
  const now = opts.now ?? Date.now();
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Group: same provider + instance + Inboxing login, each row within
  // BATCH_GAP_MS of the previous one.
  const groups: BatchRow[][] = [];
  const open = new Map<string, { group: BatchRow[]; lastMs: number }>();
  for (const r of sorted) {
    const k = `${r.provider}|${r.instance}|${r.inboxing_account ?? ""}`;
    const t = new Date(r.created_at).getTime();
    const cur = open.get(k);
    if (cur && t - cur.lastMs <= BATCH_GAP_MS) {
      cur.group.push(r);
      cur.lastMs = t;
    } else {
      const group = [r];
      groups.push(group);
      open.set(k, { group, lastMs: t });
    }
  }

  const batches = groups.map((raw): InboxOrderBatch => {
    // A domain retried inside the same submission counts once — keep the
    // attempt that got furthest (anything over a failure, then the latest).
    const byDomain = new Map<string, BatchRow>();
    for (const r of raw) {
      const prev = byDomain.get(r.domain);
      if (!prev || (prev.status === "failed" && r.status !== "failed") ||
          ((prev.status === "failed") === (r.status === "failed") && r.created_at > prev.created_at)) {
        byDomain.set(r.domain, r);
      }
    }
    const group = [...byDomain.values()];
    const first = raw[0];

    const c = { live: 0, partial: 0, settingUp: 0, uploading: 0, stuck: 0, failed: 0, reordered: 0, removed: 0 };
    let mailboxesOrdered = 0, mailboxesExpected = 0, mailboxesInBison = 0, missingMailboxes = 0;
    let lastCheckedAt: string | null = null;
    let checkOverdue = false;
    let bisonSyncedAt: string | null = null;

    const members = group.map((r): BatchMember => {
      mailboxesOrdered += r.mailbox_count;
      const places = inBison.get(r.domain) || [];
      const home = places.find((p) => p.instance === r.instance) ?? places[0] ?? null;
      const n = home ? home.mailboxes : null;
      const movedTo = home && home.instance !== r.instance ? opts.instanceLabel(home.instance) : null;
      if (home?.syncedAt && (!bisonSyncedAt || home.syncedAt > bisonSyncedAt)) bisonSyncedAt = home.syncedAt;

      let state: MemberState;
      let note: string | null = null;

      // Any later attempt at the same domain owns the outcome, so a domain
      // that failed four times reads as failed once — on its latest order —
      // not on every order it was ever in (commercialcleaningelite.com).
      const again = r.status === "failed"
        ? (laterOrders.get(r.domain) || [])
            .filter((o) => o.created_at > r.created_at)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
        : undefined;

      if (REMOVED.has(r.status)) {
        state = "removed";
      } else if (again) {
        state = "reordered";
        note = `Ordered again ${again.created_at.slice(5, 10).replace("-", "/")} for ${opts.instanceLabel(again.instance)}`;
      } else if (n != null) {
        // In Bison. A row the provider marked failed whose mailboxes arrived
        // anyway did land — the provider's own 9/25 tally left it out.
        state = n < r.mailbox_count ? "partial" : "live";
        if (state === "partial") note = `${r.mailbox_count - n} mailbox${r.mailbox_count - n === 1 ? "" : "es"} didn't reach Bison`;
        else if (r.status === "failed") note = "Provider reported a failure, but the mailboxes are in Bison";
        if (movedTo) note = note ? `${note} · now on ${movedTo}` : `Moved to ${movedTo}`;
      } else if (r.status === "failed") {
        state = "failed";
        note = plainReason(r.failure_reason);
      } else if (PENDING.has(r.status)) {
        state = "setting-up";
        const checked = r.last_checked_at ? new Date(r.last_checked_at).getTime() : null;
        if (checked != null && (!lastCheckedAt || r.last_checked_at! > lastCheckedAt)) lastCheckedAt = r.last_checked_at;
        const since = checked ?? new Date(r.created_at).getTime();
        if (now - since > opts.checkOverdueMs) checkOverdue = true;
      } else {
        // Provisioned (active) but no instance has its mailboxes yet.
        const since = new Date(r.completed_at || r.created_at).getTime();
        if (now - since > STUCK_AFTER_MS) {
          state = "stuck";
          note = `Set up at the provider, but not in Bison after ${days(now - since)} days`;
        } else {
          state = "uploading";
          note = plainReason(r.failure_reason) ?? "Uploading to Bison";
        }
      }

      if (state === "removed") c.removed++;
      else if (state === "failed") c.failed++;
      else if (state === "reordered") c.reordered++;
      else if (state === "setting-up") c.settingUp++;
      else if (state === "uploading") c.uploading++;
      else if (state === "stuck") c.stuck++;
      else {
        c.live++;
        mailboxesExpected += r.mailbox_count;
        mailboxesInBison += n ?? 0;
        if (state === "partial") {
          c.partial++;
          missingMailboxes += r.mailbox_count - (n ?? 0);
        }
      }

      return { id: r.id, domain: r.domain, state, mailboxesOrdered: r.mailbox_count, mailboxesInBison: n, movedTo, note };
    });

    members.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.domain.localeCompare(b.domain));

    return {
      key: `${first.provider}|${first.instance}|${first.inboxing_account ?? ""}|${first.created_at}`,
      provider: first.provider,
      instance: first.instance,
      inboxingAccount: first.inboxing_account,
      placedAt: first.created_at,
      domains: group.length,
      mailboxesOrdered,
      ...c,
      mailboxesExpected,
      mailboxesInBison,
      missingMailboxes,
      lastCheckedAt,
      checkOverdue,
      bisonSyncedAt,
      members,
    };
  });

  return batches.sort((a, b) => b.placedAt.localeCompare(a.placedAt));
}
