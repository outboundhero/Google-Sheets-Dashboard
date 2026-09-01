import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { getHandledDomains, logEvents } from "@/lib/replacement/store";
import { hasBurntTag } from "@/lib/replacement/burnt-tag";
import { getKnownClientTags } from "@/lib/replacement/cross-tag-audit";
import { ALL_INSTANCE_SLUGS, type BisonInstanceSlug } from "@/lib/bison-instances";
import type { NewEvent } from "@/lib/replacement/store";

export const maxDuration = 300;

// GET /api/cron/limit-policy — Spencer's sender-limit ladder (2026-09-02),
// both stages in one daily audit:
//
//   RESERVE  — every sender on an UNASSIGNED Inboxing/MilkBox domain is set to
//              exactly 3/day, "without fail": drift in either direction is
//              corrected (an operator's stray 10 comes down, a warmup 2 comes
//              up). ScaledMail is out of scope per the spec.
//   ASSIGNED — a domain that has been client-tagged for 4+ calendar days AND
//              whose client has an actively-sending campaign in that instance
//              is raised to 5/day. Only raises to 5 — an operator's higher
//              custom limit is never pulled down by this stage. The tag date
//              comes from the replacement_events audit trail; domains with no
//              tagged event (pre-pipeline assignments) are skipped rather than
//              guessed at.
//
// Limits are a Bison setting: applied via the same bulk endpoint the manual
// Daily Limit button uses, mirror updated for the UI, one audit event per
// domain. Skips Burnt-tagged domains and anything in a deletion/cancel queue
// (no point tuning senders that are leaving). ?dry=1 previews. Capped per run
// so a bad read can't rewrite the fleet in one pass; the daily schedule
// drains any backlog.

const RESERVE_LIMIT = 3;
const ASSIGNED_LIMIT = 5;
const ASSIGNED_AFTER_DAYS = 4;
const RUN_CAP = 600; // inboxes per stage per run

const PROVIDER_TAGS = ["inboxing", "milkbox"];
const SENDING = new Set(["active", "sending", "running"]);

interface DomRow { instance: BisonInstanceSlug; domain: string; tags: string[] | null }
interface InboxRow { id: number; instance: BisonInstanceSlug; domain: string; daily_limit: number | null }

const hasProviderTag = (tags: string[] | null) =>
  (tags || []).some((t) => PROVIDER_TAGS.some((p) => String(t).toLowerCase().includes(p)));

async function applyLimit(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  targets: InboxRow[],
  limit: number,
): Promise<{ updated: number; failed: number }> {
  let updated = 0, failed = 0;
  const byInstance = new Map<BisonInstanceSlug, number[]>();
  for (const t of targets) {
    if (!byInstance.has(t.instance)) byInstance.set(t.instance, []);
    byInstance.get(t.instance)!.push(t.id);
  }
  for (const [instance, ids] of byInstance) {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await bisonFetch(instance, `/sender-emails/daily-limits/bulk`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender_email_ids: batch, daily_limit: limit }),
      });
      if (res.ok) {
        updated += batch.length;
        await supabase.from("deliverability_inboxes").update({ daily_limit: limit }).eq("instance", instance).in("id", batch);
      } else failed += batch.length;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { updated, failed };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dry") === "1";

    const supabase = getSupabaseAdmin();
    const [knownTags, handled] = await Promise.all([getKnownClientTags(), getHandledDomains()]);
    const knownUpper = new Set([...knownTags].map((t) => t.toUpperCase()));

    const doms: DomRow[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance, domain, tags")
        .in("instance", ALL_INSTANCE_SLUGS)
        .order("domain", { ascending: true })
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      doms.push(...(data as DomRow[]));
      if (data.length < 1000) break;
    }

    const clientTagOf = (tags: string[] | null) =>
      (tags || []).map((t) => String(t).trim().toUpperCase()).find((t) => knownUpper.has(t)) ?? null;

    const reserveDomains: DomRow[] = [];
    const assignedDomains: (DomRow & { clientTag: string })[] = [];
    for (const d of doms) {
      if (handled.has(`${d.instance}:${d.domain}`) || hasBurntTag(d.tags)) continue;
      if (!hasProviderTag(d.tags)) continue; // Inboxing/MilkBox only per spec
      const tag = clientTagOf(d.tags);
      if (tag === null) reserveDomains.push(d);
      else assignedDomains.push({ ...d, clientTag: tag });
    }

    // ── RESERVE stage: everyone to exactly 3 ────────────────────────────────
    const reserveTargets: InboxRow[] = [];
    for (let i = 0; i < reserveDomains.length && reserveTargets.length < RUN_CAP; i += 50) {
      const slice = reserveDomains.slice(i, i + 50);
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("id, instance, domain, daily_limit")
        .in("domain", slice.map((d) => d.domain))
        .neq("daily_limit", RESERVE_LIMIT);
      for (const r of (data || []) as InboxRow[]) {
        if (slice.some((d) => d.domain === r.domain && d.instance === r.instance)) reserveTargets.push(r);
      }
    }
    const reserveWork = reserveTargets.slice(0, RUN_CAP);

    // ── ASSIGNED stage: tagged 4+ days + actively-sending campaign → 5 ─────
    const { data: camps } = await supabase.from("campaigns").select("instance, client_tag, status").limit(10000);
    const activeKeys = new Set(
      ((camps || []) as { instance: string; client_tag: string | null; status: string }[])
        .filter((c) => c.client_tag && SENDING.has(String(c.status || "").toLowerCase()))
        .map((c) => `${c.client_tag!.trim().toUpperCase()}:${c.instance}`),
    );
    const eligible = assignedDomains.filter((d) => activeKeys.has(`${d.clientTag}:${d.instance}`));

    // Earliest tagged event per (instance, domain) — the audit trail is the
    // only source that proves WHEN the client tag landed.
    const taggedAt = new Map<string, string>();
    for (let i = 0; i < eligible.length; i += 100) {
      const slice = eligible.slice(i, i + 100);
      const { data } = await supabase
        .from("replacement_events")
        .select("instance, domain, created_at")
        .eq("event_type", "tagged")
        .in("domain", slice.map((d) => d.domain))
        .order("created_at", { ascending: true });
      for (const e of (data || []) as { instance: string; domain: string; created_at: string }[]) {
        const k = `${e.instance}:${e.domain}`;
        if (!taggedAt.has(k)) taggedAt.set(k, e.created_at);
      }
    }
    const cutoff = Date.now() - ASSIGNED_AFTER_DAYS * 86_400_000;
    const ripe = eligible.filter((d) => {
      const at = taggedAt.get(`${d.instance}:${d.domain}`);
      return at !== undefined && new Date(at).getTime() <= cutoff;
    });

    const assignedTargets: InboxRow[] = [];
    for (let i = 0; i < ripe.length && assignedTargets.length < RUN_CAP; i += 50) {
      const slice = ripe.slice(i, i + 50);
      const { data } = await supabase
        .from("deliverability_inboxes")
        .select("id, instance, domain, daily_limit")
        .in("domain", slice.map((d) => d.domain))
        .lt("daily_limit", ASSIGNED_LIMIT); // only raise — never pull a custom higher limit down
      for (const r of (data || []) as InboxRow[]) {
        if (slice.some((d) => d.domain === r.domain && d.instance === r.instance)) assignedTargets.push(r);
      }
    }
    const assignedWork = assignedTargets.slice(0, RUN_CAP);

    let reserveResult = { updated: 0, failed: 0 };
    let assignedResult = { updated: 0, failed: 0 };
    if (!dryRun) {
      reserveResult = await applyLimit(supabase, reserveWork, RESERVE_LIMIT);
      assignedResult = await applyLimit(supabase, assignedWork, ASSIGNED_LIMIT);

      const events: NewEvent[] = [];
      const perDomain = (rows: InboxRow[], detail: string) => {
        const by = new Map<string, number>();
        for (const r of rows) by.set(`${r.instance}:${r.domain}`, (by.get(`${r.instance}:${r.domain}`) || 0) + 1);
        for (const [k, n] of by) {
          const i = k.indexOf(":");
          events.push({ instance: k.slice(0, i) as BisonInstanceSlug, domain: k.slice(i + 1), eventType: "ramped", detail: detail.replace("{n}", String(n)) });
        }
      };
      if (reserveResult.updated > 0) perDomain(reserveWork, `limit policy: {n} reserve sender(s) set to ${RESERVE_LIMIT}/day (daily audit)`);
      if (assignedResult.updated > 0) perDomain(assignedWork, `limit policy: {n} sender(s) raised to ${ASSIGNED_LIMIT}/day (${ASSIGNED_AFTER_DAYS}d after client assignment, campaigns active)`);
      if (events.length > 0) await logEvents(events);
    }

    return NextResponse.json({
      dryRun,
      reserve: { domains: reserveDomains.length, inboxesOffPolicy: reserveTargets.length, processed: reserveWork.length, ...reserveResult },
      assigned: { eligibleDomains: eligible.length, ripeDomains: ripe.length, inboxesToRaise: assignedTargets.length, processed: assignedWork.length, ...assignedResult },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "limit-policy failed" }, { status: 500 });
  }
}
