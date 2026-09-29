import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import * as inboxing from "@/lib/inboxing";
import { DEFAULT_INBOXING_ACCOUNT, toInboxingAccount, inboxingConnectionFor } from "@/lib/inboxing-accounts";
import { BISON_INSTANCES, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

const BUDGET_MS = 240_000; // stop starting new uploads well inside maxDuration
const PACE_MS = 300;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = "planned" | "sent" | "skipped" | "throttled" | "failed" | "not-attempted";

interface Result {
  id: string;
  domain: string;
  instance: string | null;
  outcome: Outcome;
  jobs?: number;
  detail?: string;
}

// POST /api/inbox-orders/batches/repush  { ids: string[], dryRun?: boolean }
//
// Re-sends a domain's mailboxes from Inboxing to Bison, for domains that
// landed short (fewer mailboxes in Bison than ordered) or never landed at
// all. The upload call is the same one the hourly upload cron uses. Inboxing
// queues a job for every mailbox on the domain, and the ones already in Bison
// are skipped, so only the missing ones get added — first live run
// 2026-09-29: 2 CleaningOutbound domains, 49 jobs each, 48→49 and 47→49 within
// 15 minutes, no duplicate senders, tags and status unchanged. Built for the
// 9/25 order: 90 FacilityReach domains came in with 32–48 of 49 mailboxes
// after Saturday's bulk upload.
//
// The target is the instance the domain's mailboxes are in now — not always
// the one it was ordered for, since domains get moved after they land.
export async function POST(request: Request) {
  const started = Date.now();
  try {
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown; dryRun?: unknown };
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0))]
      : [];
    const dryRun = body.dryRun === true;
    if (ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
    if (ids.length > 500) return NextResponse.json({ error: "at most 500 domains per request" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const rows: {
      id: string; provider: string; status: string; domain: string; instance: string;
      inboxing_account: string | null; provider_domain_id: string | null; mailbox_count: number;
    }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabase
        .from("inbox_orders")
        .select("id, provider, status, domain, instance, inboxing_account, provider_domain_id, mailbox_count")
        .in("id", ids.slice(i, i + 200));
      if (error) throw new Error(error.message);
      rows.push(...((data || []) as typeof rows));
    }

    // Where each domain's mailboxes are now, and how many.
    const where = new Map<string, { instance: string; mailboxes: number }[]>();
    const domains = [...new Set(rows.map((r) => r.domain))];
    for (let i = 0; i < domains.length; i += 200) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, inbox_count")
        .in("domain", domains.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const d of data || []) {
        const n = (d.inbox_count as number | null) ?? 0;
        if (n <= 0) continue;
        const list = where.get(d.domain as string) ?? [];
        list.push({ instance: d.instance as string, mailboxes: n });
        where.set(d.domain as string, list);
      }
    }

    const results: Result[] = [];
    for (const id of ids.filter((x) => !rows.some((r) => r.id === x))) {
      results.push({ id, domain: "", instance: null, outcome: "skipped", detail: "order not found" });
    }

    let first = true;
    for (const r of rows) {
      const skip = (detail: string, instance: string | null = null) =>
        results.push({ id: r.id, domain: r.domain, instance, outcome: "skipped", detail });

      if (r.provider !== "inboxing") { skip("only Inboxing orders can be re-pushed"); continue; }
      if (r.status !== "active") { skip(`order is ${r.status}, not active at the provider`); continue; }
      if (!r.provider_domain_id) { skip("no Inboxing domain id on the order"); continue; }

      const places = where.get(r.domain) ?? [];
      // In two instances with the short copy on the order's own instance is a
      // move that landed partway — move-domains points the order at the move
      // target. Completing that copy is what lets the duplicate cleanup retire
      // the old one: it waits for ~90% and logs "needs human" until then
      // (cleanharbormaintenance.com, 39/49 on FacilityReach, 2026-09-29).
      // Anything else in more than one place is left for the cleanup to judge.
      const own = places.find((p) => p.instance === r.instance);
      if (places.length > 2 || (places.length === 2 && (!own || own.mailboxes >= r.mailbox_count))) {
        skip(`in ${places.length} instances at once — let the duplicate cleanup settle it first`);
        continue;
      }
      const home = places.length === 2 ? own! : places[0];
      const target = home?.instance ?? r.instance;
      if (!isInstanceSlug(target)) { skip(`unknown instance ${target}`); continue; }
      const have = home?.mailboxes ?? 0;
      if (have >= r.mailbox_count) { skip("already has every mailbox in Bison", target); continue; }

      const account = toInboxingAccount(r.inboxing_account) ?? DEFAULT_INBOXING_ACCOUNT;
      const connection = inboxingConnectionFor(target as BisonInstanceSlug, account);
      if (!connection) { skip(`no Inboxing connection for ${BISON_INSTANCES[target].label} on the ${account} account`, target); continue; }

      const missing = r.mailbox_count - have;
      if (dryRun) {
        results.push({ id: r.id, domain: r.domain, instance: target, outcome: "planned", detail: `${have}/${r.mailbox_count} in Bison, ${missing} missing` });
        continue;
      }
      if (Date.now() - started > BUDGET_MS) {
        results.push({ id: r.id, domain: r.domain, instance: target, outcome: "not-attempted", detail: "ran out of time — run again" });
        continue;
      }
      if (!first) await delay(PACE_MS);
      first = false;
      try {
        const res = await inboxing.uploadDomainToPlatform(r.provider_domain_id, connection, account);
        results.push({ id: r.id, domain: r.domain, instance: target, outcome: "sent", jobs: res.jobsCreated, detail: `${missing} were missing` });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "upload failed";
        // Inboxing's per-domain upload cooldown — nothing wrong, just not yet.
        const throttled = /upload will be available/i.test(msg);
        results.push({
          id: r.id, domain: r.domain, instance: target,
          outcome: throttled ? "throttled" : "failed",
          detail: throttled ? msg.replace(/^.*?:\s*(?=Upload will be available)/i, "") : msg.slice(0, 300),
        });
      }
    }

    const count = (o: Outcome) => results.filter((x) => x.outcome === o).length;
    return NextResponse.json({
      dryRun,
      planned: count("planned"),
      sent: count("sent"),
      jobs: results.reduce((s, x) => s + (x.jobs ?? 0), 0),
      skipped: count("skipped"),
      throttled: count("throttled"),
      failed: count("failed"),
      notAttempted: count("not-attempted"),
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
