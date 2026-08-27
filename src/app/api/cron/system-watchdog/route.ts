import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";
import { pipelineAlertChannel } from "@/lib/pipeline-alerts";
import { Redis } from "@upstash/redis";
import { GET as conformDry } from "@/app/api/cron/redirect-conform/route";
import { GET as uploadDry } from "@/app/api/cron/inbox-orders-upload/route";
import { getSyncMetadata, isSyncStale } from "@/lib/leads-store";
import { ALL_INSTANCE_SLUGS, INSTANCE_SHORT_LABELS, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/system-watchdog — hourly: LeadSync inspects ITSELF for the
// discrepancy classes Nick and Spencer used to find by eye and flag to us —
// stale data, things silently not working, queues stuck, decisions waiting —
// and posts what's wrong to the shared team-client channel.
//
// Vicky 2026-08-27 (refining the Aug-26 meeting ask): "they mean our job
// should be done by LeadSync — post in Slack what's wrong." So this is not
// only human-decision escalation: every check below is something a person
// previously discovered manually.
//
// Slack discipline: ONE digest, posted when the finding-set changes or at
// most once every 24h as a reminder; silent when everything is clean.
// ?dry=1 previews without posting.

const DIGEST_KEY = "cron:system-watchdog:last-digest";
const REMINDER_HOURS = 24;

interface Finding { area: string; line: string; count: number }

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function callDry(handler: (req: Request) => Promise<Response>, path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await handler(new Request(`http://internal${path}`));
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const dryRun = new URL(request.url).searchParams.get("dry") === "1";
    const supabase = getSupabaseAdmin();
    const findings: Finding[] = [];
    const add = (area: string, count: number, line: string) => {
      if (count > 0) findings.push({ area, count, line });
    };

    // 1. Stale client tags: a removed domain still carrying its client tag
    //    (the bug behind every inflated count in August).
    {
      const removed: { instance: string; domain: string; assigned_client_tag: string | null }[] = [];
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("domain_replacement_state")
          .select("instance,domain,assigned_client_tag").eq("state", "removed").range(off, off + 999);
        if (!data || data.length === 0) break;
        removed.push(...(data as typeof removed)); if (data.length < 1000) break;
      }
      const byKey = new Map(removed.map((r) => [`${r.instance}:${r.domain}`, (r.assigned_client_tag || "").toUpperCase()]));
      let stale = 0;
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("deliverability_domains").select("instance,domain,tags").range(off, off + 999);
        if (!data || data.length === 0) break;
        for (const d of data as { instance: string; domain: string; tags: string[] | null }[]) {
          const tag = byKey.get(`${d.instance}:${d.domain}`);
          if (tag && (d.tags || []).some((t) => String(t).trim().toUpperCase() === tag)) stale++;
        }
        if (data.length < 1000) break;
      }
      add("stale tags", stale, `${stale} removed domain(s) still carry their client tag (strip cron should be clearing these)`);
    }

    // 2. Burnt-tagged domains still assigned to a client — a client is sending
    //    on something a human marked Burnt.
    {
      let n = 0;
      const { data: knownRows } = await supabase.from("client_redirects").select("client_tag");
      const known = new Set((knownRows || []).map((r) => String(r.client_tag).toUpperCase()));
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("deliverability_domains").select("tags").range(off, off + 999);
        if (!data || data.length === 0) break;
        for (const d of data as { tags: string[] | null }[]) {
          const tags = (d.tags || []).map((t) => String(t).trim());
          if (tags.some((t) => t.toLowerCase() === "burnt") && tags.some((t) => known.has(t.toUpperCase()))) n++;
        }
        if (data.length < 1000) break;
      }
      add("burnt in use", n, `${n} domain(s) tagged Burnt are still assigned to a client`);
    }

    // 3. Deletion queue stuck: pending rows past due by > 6h (executor runs
    //    every 15 min — anything this old is wedged, not waiting).
    {
      const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
      const { data } = await supabase.from("duplicate_domain_deletions")
        .select("domain").eq("status", "pending").lt("scheduled_at", cutoff).limit(500);
      add("deletions stuck", (data || []).length, `${(data || []).length} queued deletion(s) overdue by 6h+ — executor may be wedged`);
    }

    // 4. Redirect decisions waiting on a human (conform's custom bucket).
    {
      const j = await callDry(conformDry, "/api/cron/redirect-conform?dry=1");
      const custom = (j?.byKind as { custom?: number } | undefined)?.custom ?? 0;
      add("redirect decisions", custom, `${custom} domain(s) point somewhere different from the tracker sheet on purpose — needs a human call`);
    }

    // 5. Inboxing orders active but absent from Bison (the 487 class).
    {
      const j = await callDry(uploadDry, "/api/cron/inbox-orders-upload?dry=1");
      const n = (j?.toUpload as number | undefined) ?? 0;
      add("orders not in Bison", n, `${n} active Inboxing order(s) whose domain is in NO Bison instance`);
    }

    // 6. Open pipeline failures older than 24h — alerted once, then ignored.
    {
      const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data } = await supabase.from("pipeline_alerts")
        .select("source,client_tag").eq("status", "open").lt("created_at", cutoff).limit(50);
      add("ignored failures", (data || []).length, `${(data || []).length} pipeline failure(s) open for 24h+ without retry/dismiss`);
    }

    // 7. Replacement errors in the last 24h (auto mode must not fail silently).
    {
      const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { data } = await supabase.from("replacement_events")
        .select("client_tag").eq("event_type", "error").gte("created_at", cutoff).limit(100);
      add("run errors", (data || []).length, `${(data || []).length} replacement step error(s) in the last 24h — retry from the dashboard`);
    }

    // 8. Lead-sheet sync stale or erroring — the Google Sheets side, not the
    //    Bison side (Vicky 2026-08-27: the watchdog watches ALL of LeadSync).
    {
      try {
        const meta = await getSyncMetadata();
        if (isSyncStale(meta)) {
          add("lead sync stale", 1, `lead-sheet sync is stale (last full sync: ${meta.lastSyncAt ?? "never"})`);
        }
        const errs = meta.errors?.length ?? 0;
        add("lead sync errors", errs, `${errs} tracked sheet(s) failed in the last lead sync`);
      } catch { /* Redis unreachable — the stale check itself would be noise */ }
    }

    // 9. Deliverability crawl stale per instance — everything downstream
    //    (flags, counts, duplicates) reads this data.
    {
      const staleDays = 3;
      const staleInstances: string[] = [];
      for (const slug of ALL_INSTANCE_SLUGS) {
        const { data } = await supabase.from("deliverability_domains")
          .select("synced_at").eq("instance", slug).order("synced_at", { ascending: false }).limit(1);
        const last = data?.[0]?.synced_at ? new Date(data[0].synced_at).getTime() : 0;
        if (Date.now() - last > staleDays * 86_400_000) staleInstances.push(INSTANCE_SHORT_LABELS[slug as BisonInstanceSlug] ?? slug);
      }
      add("deliverability crawl stale", staleInstances.length,
        `deliverability data older than ${staleDays}d on: ${staleInstances.join(", ")} — flags/counts are running blind there`);
    }

    // 10. Campaign sync stale per instance (6-hourly crons).
    {
      const staleInstances: string[] = [];
      for (const slug of ALL_INSTANCE_SLUGS) {
        const { data } = await supabase.from("campaigns")
          .select("synced_at").eq("instance", slug).order("synced_at", { ascending: false }).limit(1);
        const last = data?.[0]?.synced_at ? new Date(data[0].synced_at).getTime() : 0;
        if (Date.now() - last > 12 * 3600_000) staleInstances.push(INSTANCE_SHORT_LABELS[slug as BisonInstanceSlug] ?? slug);
      }
      add("campaign sync stale", staleInstances.length,
        `campaign data older than 12h on: ${staleInstances.join(", ")}`);
    }

    // 11. Whitelist emails stuck — queued rows should send at the next 6:30am
    //     PT batch; older than 48h means the batch is failing silently.
    {
      const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
      const { data } = await supabase.from("whitelist_queue")
        .select("domain").eq("status", "queued").lt("queued_at", cutoff).limit(200);
      add("whitelist stuck", (data || []).length, `${(data || []).length} whitelist email(s) queued for 48h+ without sending`);
    }

    // ── Operation-outcome checks (Vicky 2026-08-27: watch the PROCESSES too —
    //    tag add/remove, moves, campaign attach — not just the end state). ──

    // 12. Partial tag application: a client-tagged domain where only SOME of
    //     its inboxes carry the tag — a bulk add/remove that half-landed.
    //     conform-tags should top these up twice daily; a persistent count
    //     means tag operations are failing.
    {
      const { data: knownRows } = await supabase.from("client_redirects").select("client_tag");
      const known = new Set((knownRows || []).map((r) => String(r.client_tag).toUpperCase()));
      const domTag = new Map<string, string>();
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("deliverability_domains").select("instance,domain,tags").range(off, off + 999);
        if (!data || data.length === 0) break;
        for (const d of data as { instance: string; domain: string; tags: string[] | null }[]) {
          const tag = (d.tags || []).map((t) => String(t).trim()).find((t) => known.has(t.toUpperCase()));
          if (tag) domTag.set(`${d.instance}:${d.domain}`, tag.toUpperCase());
        }
        if (data.length < 1000) break;
      }
      const cover = new Map<string, { withTag: number; total: number }>();
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("deliverability_inboxes").select("instance,domain,tags").range(off, off + 999);
        if (!data || data.length === 0) break;
        for (const i of data as { instance: string; domain: string; tags: { name?: string }[] | null }[]) {
          const key = `${i.instance}:${i.domain}`;
          const want = domTag.get(key);
          if (!want) continue;
          const c = cover.get(key) ?? { withTag: 0, total: 0 };
          c.total++;
          if ((i.tags || []).some((t) => String(t?.name ?? t).trim().toUpperCase() === want)) c.withTag++;
          cover.set(key, c);
        }
        if (data.length < 1000) break;
      }
      let partial = 0;
      for (const c of cover.values()) if (c.withTag > 0 && c.withTag < c.total) partial++;
      add("partial tags", partial, `${partial} domain(s) where only some inboxes carry the client tag — a tag add/remove half-landed`);
    }

    // 13 + 15. One scan: moves stuck mid-flight, and tagged-but-never-sent.
    {
      interface D { instance: string; domain: string; tags: string[] | null; inbox_count: number | null; total_sent: number | null; domain_created_at: string | null }
      const all: D[] = [];
      for (let off = 0; ; off += 1000) {
        const { data } = await supabase.from("deliverability_domains")
          .select("instance,domain,tags,inbox_count,total_sent,domain_created_at").range(off, off + 999);
        if (!data || data.length === 0) break;
        all.push(...(data as D[]));
        if (data.length < 1000) break;
      }
      // 13. Mid-move stuck: present on 2 instances, one side has ZERO inboxes
      //     and that empty row is older than 24h — an upload was queued and the
      //     senders never landed (partial move nobody finished).
      const byDomain = new Map<string, D[]>();
      for (const d of all) byDomain.set(d.domain, [...(byDomain.get(d.domain) ?? []), d]);
      let midMove = 0;
      for (const list of byDomain.values()) {
        if (list.length !== 2) continue;
        const empty = list.find((d) => (d.inbox_count ?? 0) === 0);
        const full = list.find((d) => (d.inbox_count ?? 0) > 0);
        if (!empty || !full) continue;
        const age = empty.domain_created_at ? Date.now() - new Date(empty.domain_created_at).getTime() : 0;
        if (age > 24 * 3600_000) midMove++;
      }
      add("moves stuck", midMove, `${midMove} move(s) stuck mid-flight 24h+ (uploaded to the target, senders never landed) — re-run Move or investigate`);

      // 15. Tagged ≥45d and never sent one email — attached to a client but
      //     never launched (the 162-domain class behind the stuck campaigns).
      const { data: knownRows } = await supabase.from("client_redirects").select("client_tag");
      const known = new Set((knownRows || []).map((r) => String(r.client_tag).toUpperCase()));
      let neverSent = 0;
      for (const d of all) {
        if (!(d.tags || []).some((t) => known.has(String(t).trim().toUpperCase()))) continue;
        if ((d.total_sent ?? 0) > 0) continue;
        const age = d.domain_created_at ? (Date.now() - new Date(d.domain_created_at).getTime()) / 86_400_000 : 0;
        if (age >= 45) neverSent++;
      }
      add("never launched", neverSent, `${neverSent} client-tagged domain(s) ≥45d old with ZERO sends — attached but never launched (check their campaigns)`);
    }

    // 14. Campaign-attach queue backlog: deferred attaches that failed or have
    //     been waiting 48h+ — senders that never made it into their campaigns.
    {
      const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
      const { data: failedRows } = await supabase.from("replacement_attach_queue").select("id").eq("status", "failed").limit(200);
      const { data: oldPending } = await supabase.from("replacement_attach_queue")
        .select("id").eq("status", "pending").lt("created_at", cutoff).limit(200);
      const n = (failedRows || []).length + (oldPending || []).length;
      add("attach backlog", n, `${n} campaign-attach job(s) failed or waiting 48h+ — senders not in their campaigns`);
    }

    // 16. Cross-client contamination lingering: the 72h cycle should clear
    //     wrong-campaign memberships; rows older than 5 days mean it can't.
    {
      try {
        const cutoff = new Date(Date.now() - 5 * 86_400_000).toISOString();
        const { data, error } = await supabase.from("cross_tag_audit").select("domain").lt("created_at", cutoff).limit(200);
        if (!error) add("cross-client lingering", (data || []).length, `${(data || []).length} domain(s) flagged in another client's campaigns for 5d+ — the auto-cycle isn't clearing them`);
      } catch { /* table shape drift — skip rather than false-alarm */ }
    }

    const signature = findings.map((f) => `${f.area}:${f.count}`).join("|") || "clean";

    let slack: { posted: boolean; reason: string } = { posted: false, reason: findings.length === 0 ? "all clean" : "unchanged, reminder not due" };
    const redis = getRedis();
    let last: { signature: string; postedAt: string } | null = null;
    if (redis) { try { last = await redis.get(DIGEST_KEY); } catch { last = null; } }
    // 8am PT morning run (repo convention: fixed UTC-8 → 15:00 UTC hour; the
    // hourly :55 schedule makes this the 15:55 tick). Spencer's "wake up and
    // verify everything worked": mornings always post — an explicit all-clear
    // when nothing is wrong, the full digest when something is.
    const morning = new Date().getUTCHours() === 15;
    const reminderDue = !last || Date.now() - new Date(last.postedAt).getTime() > REMINDER_HOURS * 3600_000 || morning;

    if (!dryRun && findings.length === 0 && morning) {
      const res = await postSlackMessage(
        ":white_check_mark: *LeadSync morning check — all clear.* Duplicates 0 pending past due, no stale data, no stuck queues, no unhandled errors.",
        pipelineAlertChannel(),
      );
      slack = { posted: res.ok, reason: res.ok ? "morning all-clear" : `slack failed: ${res.reason}` };
    }

    if (!dryRun && findings.length > 0 && (last?.signature !== signature || reminderDue)) {
      const lines = [
        `:mag: *LeadSync self-check — ${findings.length} thing${findings.length === 1 ? "" : "s"} need${findings.length === 1 ? "s" : ""} attention*`,
        ...findings.map((f) => `• ${f.line}`),
        "_Details on the LeadSync dashboard. This check runs hourly; it re-posts when something changes._",
      ];
      const res = await postSlackMessage(lines.join("\n"), pipelineAlertChannel());
      slack = { posted: res.ok, reason: res.ok ? (last?.signature !== signature ? "findings changed" : "daily reminder") : `slack failed: ${res.reason}` };
      if (res.ok && redis) { try { await redis.set(DIGEST_KEY, { signature, postedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
    }

    return NextResponse.json({ dryRun, findings, signature, slack });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "system-watchdog failed" }, { status: 500 });
  }
}
