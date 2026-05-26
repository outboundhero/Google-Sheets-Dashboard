import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstances } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

/**
 * POST /api/deliverability/conform-tags?instances=<csv>
 *
 * For every (instance, domain) in scope, ensure every sender on that domain
 * has every tag that the domain has in LeadSync — i.e. push domain.tags down
 * to all of its senders so the whole domain is tag-consistent.
 *
 * LeadSync is the source of truth (the domain row's tags column is built by
 * rebuild_domain_stats() from every sender's tags). This route walks each
 * sender, finds tags they're missing relative to their domain, and attaches
 * those tags via Bison's /tags/attach-to-sender-emails endpoint.
 *
 * This is essentially the bulk, on-demand equivalent of what
 * /api/webhooks/bison-reconnect does for a single sender on reconnect.
 *
 * Phase 1 — Plan: { dryRun: true } returns counts + a sample without writing
 *   anything to Bison.
 * Phase 2 — Apply: { dryRun: false } actually performs the attachments,
 *   one Bison call per (instance, tag) batch.
 */

interface DomainRow {
  instance: BisonInstanceSlug;
  domain: string;
  tags: string[] | null;
}

interface InboxRow {
  id: number;
  instance: BisonInstanceSlug;
  domain: string;
  email: string | null;
  status: string | null;
  tags: { id: number; name: string }[] | null;
}

interface BisonTag { id: number; name: string }

interface PerInstance {
  instance: BisonInstanceSlug;
  domainsAffected: number;
  sendersAffected: number;
  attachmentsPlanned: number;
}

interface PlanSampleRow {
  instance: BisonInstanceSlug;
  domain: string;
  sender_email: string | null;
  sender_id: number;
  missing_tags: string[];
}

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instances = resolveInstances(searchParams);
    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false; // default to dry-run for safety
    const skipDisconnected = body?.skipDisconnected !== false; // default true
    const supabase = getSupabaseAdmin();

    // 1. Domains with non-empty tags, scoped to requested instances.
    const { data: rawDomains, error: dErr } = await supabase
      .from("deliverability_domains")
      .select("instance, domain, tags")
      .in("instance", instances);
    if (dErr) throw new Error(`domains: ${dErr.message}`);
    const domains = (rawDomains || []).filter(
      (d): d is DomainRow => Array.isArray((d as DomainRow).tags) && ((d as DomainRow).tags?.length ?? 0) > 0,
    );
    // Map: instance → domain → wantedTagSet (uppercased for case-insensitive compare)
    const wantedByInstance = new Map<BisonInstanceSlug, Map<string, Set<string>>>();
    for (const d of domains) {
      let domMap = wantedByInstance.get(d.instance);
      if (!domMap) {
        domMap = new Map();
        wantedByInstance.set(d.instance, domMap);
      }
      domMap.set(d.domain, new Set((d.tags ?? []).map((t) => t.toUpperCase())));
    }

    // 2. Inboxes for those (instance, domain) pairs. Paginate per instance.
    const inboxesByInstance = new Map<BisonInstanceSlug, InboxRow[]>();
    for (const inst of instances) {
      const all: InboxRow[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_inboxes")
          .select("id, instance, domain, email, status, tags")
          .eq("instance", inst)
          .range(offset, offset + 999);
        if (error) throw new Error(`inboxes: ${error.message}`);
        if (!data || data.length === 0) break;
        all.push(...(data as InboxRow[]));
        if (data.length < 1000) break;
        offset += 1000;
      }
      inboxesByInstance.set(inst, all);
    }

    // 3. For each instance, compute the plan: tagName → senderIds-that-need-it
    //    Also collect per-instance + per-domain stats.
    const planByInstanceTag = new Map<BisonInstanceSlug, Map<string, Set<number>>>();
    const perInstanceStats = new Map<BisonInstanceSlug, PerInstance>();
    const sample: PlanSampleRow[] = [];
    let totalAttachments = 0;

    for (const inst of instances) {
      const domMap = wantedByInstance.get(inst);
      if (!domMap) {
        perInstanceStats.set(inst, { instance: inst, domainsAffected: 0, sendersAffected: 0, attachmentsPlanned: 0 });
        continue;
      }
      const inboxes = inboxesByInstance.get(inst) || [];
      const tagToSenders = new Map<string, Set<number>>();
      const affectedDomains = new Set<string>();
      const affectedSenders = new Set<number>();
      let instAttachments = 0;

      for (const sender of inboxes) {
        if (skipDisconnected && looksDisconnected((sender.status ?? "").toLowerCase())) continue;
        const wanted = domMap.get(sender.domain);
        if (!wanted || wanted.size === 0) continue;
        const has = new Set<string>(
          Array.isArray(sender.tags)
            ? sender.tags.map((t) => (t?.name ?? "").toUpperCase()).filter(Boolean)
            : [],
        );
        const missing: string[] = [];
        for (const w of wanted) {
          if (!has.has(w)) missing.push(w);
        }
        if (missing.length === 0) continue;

        // Stats
        affectedDomains.add(sender.domain);
        affectedSenders.add(sender.id);
        instAttachments += missing.length;

        // Plan: tag → senders
        // Use the ORIGINAL casing from the domain row, not the uppercased compare key.
        for (const tagU of missing) {
          // Find the original-case name from the wanted set (the set holds uppercased,
          // but we have the original from the domain row tags — fetch it).
          // For simplicity, use the uppercased version; resolveBisonTagIds below will
          // match by lowercased name and create if missing, so casing is tolerated.
          let bag = tagToSenders.get(tagU);
          if (!bag) { bag = new Set(); tagToSenders.set(tagU, bag); }
          bag.add(sender.id);
        }

        // Sample for the preview UI — keep first 100 rows so the dialog stays light
        if (sample.length < 100) {
          sample.push({
            instance: inst,
            domain: sender.domain,
            sender_email: sender.email,
            sender_id: sender.id,
            missing_tags: missing,
          });
        }
      }

      planByInstanceTag.set(inst, tagToSenders);
      totalAttachments += instAttachments;
      perInstanceStats.set(inst, {
        instance: inst,
        domainsAffected: affectedDomains.size,
        sendersAffected: affectedSenders.size,
        attachmentsPlanned: instAttachments,
      });
    }

    // ─── Dry run: stop here, return the plan ───
    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        instances,
        totals: {
          domainsAffected: [...perInstanceStats.values()].reduce((s, p) => s + p.domainsAffected, 0),
          sendersAffected: [...perInstanceStats.values()].reduce((s, p) => s + p.sendersAffected, 0),
          attachmentsPlanned: totalAttachments,
        },
        perInstance: [...perInstanceStats.values()],
        sample,
      });
    }

    // ─── Apply: resolve tag IDs per instance (creating any that don't exist), then attach ───
    let applied = 0;
    let failed = 0;
    const failures: { instance: string; tag: string; reason: string }[] = [];

    for (const [inst, tagToSenders] of planByInstanceTag) {
      if (tagToSenders.size === 0) continue;

      // List current Bison tags (one call) to resolve name → id.
      const tagsRes = await bisonFetch(inst, `/tags`);
      if (!tagsRes.ok) {
        const reason = `Failed to list tags: ${tagsRes.status}`;
        for (const tag of tagToSenders.keys()) {
          failures.push({ instance: inst, tag, reason });
          failed++;
        }
        continue;
      }
      const tagsJson = await tagsRes.json();
      const currentTags: BisonTag[] = tagsJson.data || [];
      const byUpperName = new Map(currentTags.map((t) => [t.name.toUpperCase(), t]));

      for (const [tagU, senderIdSet] of tagToSenders) {
        let resolved = byUpperName.get(tagU);
        if (!resolved) {
          // Recreate — Bison sometimes drops orphan tags. Use first uppercase variant.
          const createRes = await bisonFetch(inst, `/tags`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: tagU }),
          });
          if (createRes.ok) {
            const created = await createRes.json();
            const newTag: BisonTag = created.data || created;
            if (newTag?.id) {
              resolved = newTag;
              byUpperName.set(tagU, newTag);
            }
          }
          if (!resolved) {
            failures.push({ instance: inst, tag: tagU, reason: `Could not resolve or create tag` });
            failed++;
            continue;
          }
        }

        // Attach in batches of 100 senders per call.
        const ids = [...senderIdSet];
        let okThisTag = 0;
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          const attachRes = await bisonFetch(inst, `/tags/attach-to-sender-emails`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag_ids: [resolved.id], sender_email_ids: batch }),
          });
          if (attachRes.ok) {
            okThisTag += batch.length;
          } else {
            const txt = await attachRes.text().catch(() => "");
            failures.push({
              instance: inst,
              tag: resolved.name,
              reason: `attach batch ${i}-${i + batch.length}: ${attachRes.status} ${txt.slice(0, 150)}`,
            });
          }
        }
        applied += okThisTag;
        if (okThisTag < ids.length) failed += ids.length - okThisTag;
      }
    }

    return NextResponse.json({
      dryRun: false,
      instances,
      applied,
      failed,
      failures: failures.slice(0, 50),
      perInstance: [...perInstanceStats.values()],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function looksDisconnected(status: string): boolean {
  return (
    status.includes("disconnect") ||
    status.includes("reconnection") ||
    status.includes("login failed") ||
    status.includes("auth failed")
  );
}
