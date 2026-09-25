import { NextResponse } from "next/server";
import { POST as moveDomains } from "@/app/api/deliverability/move-domains/route";
import { POST as untagToReserve } from "@/app/api/replacement/wrong-instance/untag/route";
import { detectWrongInstance } from "@/lib/replacement/wrong-instance";
import { logEvents } from "@/lib/replacement/store";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// GET /api/cron/wrong-instance-move — twice a day, do what someone was doing
// by hand on the "Wrong instance — move to the right one" card (Spencer
// 2026-09-25: "can we please make sure this works for us automatically 2X per
// day so that we don't have to worry about it").
//
// Per flagged client, per source instance, the card offers exactly two
// actions and this picks the same one it would:
//   • target is AT CAP  → untag the misplaced domains back to reserve. Moving
//     them would put the client over its tier cap, so the card says "untag
//     instead" and so do we.
//   • otherwise         → move the Inboxing-provisioned domains across. The
//     upload is async, so a client needs several runs to finish; that is
//     normal and the next run picks up whatever hasn't landed.
//
// Left alone deliberately:
//   • hidden tags (someone chose to hide them on the card)
//   • duplicates — the hourly duplicate-cleanup cron owns those
//   • non-Inboxing domains — no API to move them, they need a person
//
// One client per run per source, newest flag first, so a bad detection can
// never cascade across the fleet unattended. ?dry=1 previews, ?tag= targets
// one client, ?limit= raises the per-run cap.

const DEFAULT_LIMIT = 3;

export async function GET(request: Request) {
  const startedAt = Date.now();
  try {
    const params = new URL(request.url).searchParams;
    const dryRun = params.get("dry") === "1";
    const onlyTag = (params.get("tag") || "").trim().toUpperCase() || null;
    const limit = Math.max(1, Math.min(20, Number(params.get("limit")) || DEFAULT_LIMIT));

    const detected = await detectWrongInstance();
    const flagged = (detected.flagged || []).filter((c) => !c.hidden);
    const candidates = onlyTag
      ? flagged.filter((c) => c.clientTag.trim().toUpperCase() === onlyTag)
      : flagged;

    const actions: {
      clientTag: string; sourceInstance: string; targetInstance: string;
      action: "untag" | "move" | "skipped"; domains: number; detail: string;
    }[] = [];
    let handled = 0;

    for (const client of candidates) {
      if (handled >= limit) break;
      let didSomething = false;

      for (const g of client.groups) {
        // At cap → untag back to reserve rather than pushing the client over.
        if (g.atCap) {
          const domains = g.untagDomains ?? [];
          if (domains.length === 0) continue;
          if (dryRun) {
            actions.push({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, targetInstance: g.targetInstance, action: "untag", domains: domains.length, detail: `would untag ${domains.length} — ${g.targetLabel} at cap ${g.targetTagged}/${g.targetCap}` });
            didSomething = true;
            continue;
          }
          const res = await untagToReserve(new Request("http://internal/cron/wrong-instance-move", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, domains }),
          }));
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          const ok = res.ok && !json.error;
          actions.push({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, targetInstance: g.targetInstance, action: ok ? "untag" : "skipped", domains: domains.length, detail: ok ? `untagged ${domains.length} back to reserve — ${g.targetLabel} at cap ${g.targetTagged}/${g.targetCap}` : `untag failed: ${json.error || res.status}` });
          await logEvents([{
            instance: g.sourceInstance as BisonInstanceSlug, clientTag: client.clientTag,
            eventType: ok ? "proposed" : "error",
            detail: `wrong-instance: ${ok ? `untagged ${domains.length} domain(s) back to reserve` : `untag failed — ${json.error || res.status}`} (${g.sourceLabel}, ${g.targetLabel} at cap ${g.targetTagged}/${g.targetCap})`,
            signals: { kind: "wrong_instance_cron", action: "untag", domains: domains.length },
          }]).catch(() => undefined);
          didSomething = true;
          continue;
        }

        // Otherwise move the Inboxing-provisioned ones. Non-Inboxing domains
        // have no move API and are reported, never touched.
        const domains = g.inboxingDomains ?? [];
        if (domains.length === 0) {
          if ((g.otherDomains?.length ?? 0) > 0) {
            actions.push({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, targetInstance: g.targetInstance, action: "skipped", domains: g.otherDomains.length, detail: `${g.otherDomains.length} non-Inboxing — needs a person` });
          }
          continue;
        }
        if (dryRun) {
          actions.push({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, targetInstance: g.targetInstance, action: "move", domains: domains.length, detail: `would move ${domains.length} ${g.sourceLabel} → ${g.targetLabel}` });
          didSomething = true;
          continue;
        }
        const res = await moveDomains(new Request("http://internal/cron/wrong-instance-move", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: false, domains, targetInstance: g.targetInstance, platformConnectionId: g.platformConnectionId }),
        }));
        const json = (await res.json().catch(() => ({}))) as { results?: { domain: string; status: string }[]; error?: string };
        const rows = json.results ?? [];
        const uploading = rows.filter((r) => r.status !== "failed").length;
        const ok = res.ok && !json.error;
        actions.push({ clientTag: client.clientTag, sourceInstance: g.sourceInstance, targetInstance: g.targetInstance, action: ok ? "move" : "skipped", domains: domains.length, detail: ok ? `${uploading} uploading ${g.sourceLabel} → ${g.targetLabel} (lands asynchronously)` : `move failed: ${json.error || res.status}` });
        await logEvents([{
          instance: g.targetInstance as BisonInstanceSlug, clientTag: client.clientTag,
          eventType: ok ? "proposed" : "error",
          detail: `wrong-instance: ${ok ? `${uploading} of ${domains.length} domain(s) uploading ${g.sourceLabel} → ${g.targetLabel}` : `move failed — ${json.error || res.status}`}`,
          signals: { kind: "wrong_instance_cron", action: "move", domains: domains.length, uploading },
        }]).catch(() => undefined);
        didSomething = true;
      }

      if (didSomething) handled++;
    }

    return NextResponse.json({
      dryRun,
      flaggedClients: flagged.length,
      clientsHandled: handled,
      limit,
      actions,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "wrong-instance-move failed" }, { status: 500 });
  }
}
