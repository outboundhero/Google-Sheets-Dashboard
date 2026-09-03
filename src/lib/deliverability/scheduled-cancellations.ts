// Staged domain wind-down + scheduled vendor-cancel (Spencer 2026-07-29):
//   On confirm (done in the schedule-cancellation route): throttle to 1/day +
//   remove from all campaigns IMMEDIATELY. Then a two-stage queue, driven by
//   the fire-scheduled-cancellations cron:
//     stage "pending_cancel" → at fire_at, cancel the domain at its vendor
//        (Inboxing/MilkBox/ScaledMail) → on success move to "pending_delete"
//        with a 10-min buffer.
//     stage "pending_delete" → after the buffer, delete the domain's sender
//        accounts from its EmailBison instance (a cancelled domain must also
//        leave Bison).
// Delayed mode schedules the cancel +3 days; immediate mode cancels inline in
// the route and only the delete is queued here. Idempotent throughout.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { deleteDomainFromInstance } from "@/lib/deliverability/delete-domain";

export const DEFAULT_CANCEL_GRACE_DAYS = 3;
const DELETE_BUFFER_MIN = 10;   // gap between vendor-cancel and Bison sender delete
const RETRY_MIN = 30;           // reschedule a failed stage this many minutes out
const MAX_ATTEMPTS = 6;

type Stage = "pending_cancel" | "pending_delete" | "done" | "failed";

/** Which instances a domain currently has inboxes in (delete is per-instance). */
async function instancesForDomains(domains: string[]): Promise<Map<string, BisonInstanceSlug[]>> {
  const supabase = getSupabaseAdmin();
  const out = new Map<string, BisonInstanceSlug[]>();
  for (const domain of domains) {
    const { data } = await supabase
      .from("deliverability_inboxes")
      .select("instance")
      .eq("domain", domain);
    const set = new Set<BisonInstanceSlug>();
    for (const r of data || []) if (isInstanceSlug(r.instance)) set.add(r.instance);
    out.set(domain, [...set]);
  }
  return out;
}

/** Queue the delayed vendor-cancel (+graceDays) for each (instance, domain). */
export async function enqueueScheduledCancel(
  domains: string[],
  graceDays = DEFAULT_CANCEL_GRACE_DAYS,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const byDomain = await instancesForDomains(domains);
  const fireAt = new Date(Date.now() + graceDays * 86_400_000).toISOString();
  const rows: { instance: string; domain: string; stage: Stage; fire_at: string }[] = [];
  for (const domain of domains) {
    const insts = byDomain.get(domain) || [];
    // if we can't see any instance yet, still schedule against all (cancel is
    // by-domain at the vendor; delete step re-resolves live)
    for (const inst of insts.length ? insts : ALL_INSTANCE_SLUGS) {
      rows.push({ instance: inst, domain: domain.toLowerCase(), stage: "pending_cancel", fire_at: fireAt });
    }
  }
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from("scheduled_cancellations")
    .upsert(rows.map((r) => ({ ...r, attempts: 0, updated_at: new Date().toISOString() })), { onConflict: "instance,domain" });
  if (error) throw new Error(error.message);
  return rows.length;
}

/** Queue only the Bison sender-delete (immediate mode already cancelled at the
 *  vendor inline) — fires after the 10-min buffer. */
export async function enqueueDeleteOnly(domains: string[]): Promise<number> {
  const supabase = getSupabaseAdmin();
  const byDomain = await instancesForDomains(domains);
  const fireAt = new Date(Date.now() + DELETE_BUFFER_MIN * 60_000).toISOString();
  const rows: { instance: string; domain: string; stage: Stage; fire_at: string }[] = [];
  for (const domain of domains) {
    for (const inst of byDomain.get(domain) || []) {
      rows.push({ instance: inst, domain: domain.toLowerCase(), stage: "pending_delete", fire_at: fireAt });
    }
  }
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from("scheduled_cancellations")
    .upsert(rows.map((r) => ({ ...r, attempts: 0, updated_at: new Date().toISOString() })), { onConflict: "instance,domain" });
  if (error) throw new Error(error.message);
  return rows.length;
}

export interface CancelProcessResult {
  cancelled: number;
  deleted: number;
  rescheduled: number;
  exhausted: number;
  /** ScaledMail has no cancel API — these need a manual cancel via their
   *  Slack channel. Collected per run and posted as a copy-paste digest
   *  (Nick 2026-09-02). Senders still get deleted from Bison as usual. */
  scaledmailManual: string[];
  /** Porkbun-direct domains (no vendor) — auto-renew switched off so the
   *  registration lapses instead of silently renewing. */
  renewOff: number;
}

/** Cron worker: advance every due row through the cancel → delete state machine. */
export async function processDueCancellations(): Promise<CancelProcessResult> {
  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const res: CancelProcessResult = { cancelled: 0, deleted: 0, rescheduled: 0, exhausted: 0, scaledmailManual: [], renewOff: 0 };

  const { data, error } = await supabase
    .from("scheduled_cancellations")
    .select("*")
    .in("stage", ["pending_cancel", "pending_delete"])
    .lte("fire_at", nowIso)
    .order("fire_at", { ascending: true })
    .limit(25);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length === 0) return res;

  const { POST: cancelPOST } = await import("@/app/api/deliverability/cancel-domains/route");

  for (const row of rows) {
    const attempts = (row.attempts ?? 0) + 1;
    const bump = (patch: Record<string, unknown>) =>
      supabase.from("scheduled_cancellations").update({ ...patch, attempts, updated_at: new Date().toISOString() })
        .eq("instance", row.instance).eq("domain", row.domain);

    try {
      if (row.stage === "pending_cancel") {
        // vendor cancel via the proven route handler (routes to provider, retries)
        const req = new Request("http://internal/api/deliverability/cancel-domains", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false, domains: [row.domain] }),
        });
        const r = await cancelPOST(req);
        // route returns { results:[{domain,status}], counts }. one domain in →
        // read its status: canceled | alreadyGone | skipped | failed.
        const d = (await r.json().catch(() => ({}))) as { results?: { status?: string; error?: string }[] };
        const st = d.results?.[0]?.status;
        const why = d.results?.[0]?.error || "";
        const ok = r.ok && (st === "canceled" || st === "alreadyGone" || st === "skipped");
        if (ok && st === "skipped") {
          // A vendor-less skip still needs its money tap closed:
          if (/scaledmail/i.test(why)) {
            res.scaledmailManual.push(row.domain); // manual cancel via their Slack — digest below
          } else if (/no provider tag/i.test(why)) {
            // Porkbun-direct (.info era) — no vendor to cancel; stop the renewal.
            try {
              const { setAutoRenew } = await import("@/lib/porkbun");
              await setAutoRenew(row.domain, false);
              res.renewOff++;
            } catch (e) {
              console.error(`[cancellations] porkbun auto-renew off failed for ${row.domain}:`, e);
            }
          }
        }
        if (ok) {
          await bump({ stage: "pending_delete", fire_at: new Date(Date.now() + DELETE_BUFFER_MIN * 60_000).toISOString() });
          res.cancelled++;
        } else if (attempts >= MAX_ATTEMPTS) {
          await bump({ stage: "failed", note: "vendor cancel failed after retries" });
          res.exhausted++;
        } else {
          await bump({ fire_at: new Date(Date.now() + RETRY_MIN * 60_000).toISOString() });
          res.rescheduled++;
        }
      } else if (row.stage === "pending_delete") {
        if (!isInstanceSlug(row.instance)) { await bump({ stage: "done", note: "unknown instance" }); continue; }
        const del = await deleteDomainFromInstance(row.instance, row.domain);
        if (del.remainingInBison === 0 && del.failed === 0) {
          await bump({ stage: "done", note: `deleted ${del.inboxesDeleted} sender(s)` });
          res.deleted++;
        } else if (attempts >= MAX_ATTEMPTS) {
          await bump({ stage: "failed", note: `delete stuck: ${del.remainingInBison} remaining` });
          res.exhausted++;
        } else {
          await bump({ fire_at: new Date(Date.now() + RETRY_MIN * 60_000).toISOString() });
          res.rescheduled++;
        }
      }
    } catch (e) {
      if (attempts >= MAX_ATTEMPTS) { await bump({ stage: "failed", note: e instanceof Error ? e.message : "error" }); res.exhausted++; }
      else { await bump({ fire_at: new Date(Date.now() + RETRY_MIN * 60_000).toISOString() }); res.rescheduled++; }
    }
  }

  // ScaledMail digest (Nick 2026-09-02: "each of the domains in a list format
  // so we can easily copy and paste to cancel manually through the ScaledMail
  // Slack channel"). Same channel the cancel summaries already post to.
  if (res.scaledmailManual.length > 0) {
    const { postSlackMessage } = await import("@/lib/slack");
    const channel = process.env.CANCEL_DOMAINS_SLACK_CHANNEL_ID || "C0B84LMSVMH";
    await postSlackMessage(
      `📋 *ScaledMail — cancel manually* (no API on their side; Bison senders already deleted). Copy-paste for their Slack channel:\n\`\`\`\n${[...new Set(res.scaledmailManual)].sort().join("\n")}\n\`\`\``,
      channel,
    ).catch(() => {});
  }

  return res;
}

export interface ScheduledCancelRow {
  instance: string; domain: string; stage: string; fireAt: string; attempts: number; note: string | null;
}
export async function listScheduledCancellations(): Promise<ScheduledCancelRow[]> {
  const { data } = await getSupabaseAdmin()
    .from("scheduled_cancellations")
    .select("instance,domain,stage,fire_at,attempts,note")
    .in("stage", ["pending_cancel", "pending_delete"])
    .order("fire_at", { ascending: true })
    .limit(500);
  return (data || []).map((r) => ({ instance: r.instance, domain: r.domain, stage: r.stage, fireAt: r.fire_at, attempts: r.attempts, note: r.note }));
}
