import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { internalFetch } from "@/lib/replacement/internal-fetch";
import { logEvents } from "@/lib/replacement/store";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 300;

// POST /api/replacement/wrong-instance/untag — Spencer's cap-aware branch
// (2026-08-24): a client tag sitting in the WRONG group, when the client is
// already at/over cap in its correct group, gets its misplaced domains
// UNTAGGED back to that instance's reserve instead of moved (moving would
// overfill the correct side).
//
// Same recipe as the true-up trim, and the same crucial property: the domain
// is HEALTHY. No vendor cancellation, no lifecycle write — getHandledDomains
// reads domain_replacement_state only, so an untagged domain re-enters the
// reserve pool the fill already draws from.
//
//   1. detach from the client's campaigns (source instance only)
//   2. remove the client tag — surgical (instance, id) inboxes, because the
//      same tag legitimately exists on the correct-group side
//   3. clear the redirect
//
// Guard: a domain that ALSO exists on another instance is a duplicate — it is
// refused here (clearing its redirect would hit the live copy too; redirects
// are domain-level at the provider). The duplicate-cleanup cron owns those.
//
// Body: { clientTag, sourceInstance, domains: string[] }

interface Body {
  clientTag?: string;
  sourceInstance?: string;
  domains?: string[];
}

type StepState = "done" | "failed" | "skipped";
interface Step { label: string; state: StepState; note?: string }

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    const clientTag = (body.clientTag || "").trim();
    const sourceInstance = (body.sourceInstance || "").trim();
    const domains = (body.domains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (!clientTag || !isInstanceSlug(sourceInstance) || domains.length === 0) {
      return NextResponse.json({ error: "clientTag, sourceInstance and domains are required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Duplicate guard — re-checked server-side, never trusted from the client.
    const skippedDuplicates: string[] = [];
    {
      const { data, error } = await supabase
        .from("deliverability_domains")
        .select("instance,domain")
        .in("domain", domains)
        .neq("instance", sourceInstance);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        if (!skippedDuplicates.includes(r.domain)) skippedDuplicates.push(r.domain);
      }
    }
    const eligible = domains.filter((d) => !skippedDuplicates.includes(d));
    if (eligible.length === 0) {
      return NextResponse.json({
        error: "every requested domain also exists on another instance — those are duplicates; the duplicate-cleanup cron handles them",
        skippedDuplicates,
      }, { status: 400 });
    }

    const steps: Step[] = [];
    const callJson = async (path: string, payload: unknown) => {
      try {
        const res = await internalFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.error) return { ok: false as const, error: json?.error || `HTTP ${res.status}` };
        return { ok: true as const, json };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : "request failed" };
      }
    };

    // Marker first — a run that dies mid-way still leaves a trace.
    await logEvents([{
      instance: sourceInstance as BisonInstanceSlug,
      clientTag,
      eventType: "proposed",
      detail: `wrong-instance untag: returning ${eligible.length} to reserve in ${sourceInstance} (correct group at cap)`,
    }]).catch(() => {});

    // 1. Detach from campaigns — discover returns the plan, posting it back
    //    performs the removal (two calls by contract).
    const iq = `instances=${sourceInstance}`;
    const plan = await callJson(`/api/deliverability/remove-from-campaigns?${iq}`, { domains: eligible, discover: true });
    const planCampaigns = plan.ok && Array.isArray((plan.json as { campaigns?: unknown[] })?.campaigns)
      ? (plan.json as { campaigns: unknown[] }).campaigns
      : [];
    const det = planCampaigns.length > 0
      ? await callJson(`/api/deliverability/remove-from-campaigns?${iq}`, { domains: eligible, campaigns: planCampaigns })
      : plan;
    steps.push({
      label: `Detach ${eligible.length} domain(s) from ${planCampaigns.length} campaign(s)`,
      state: det.ok ? "done" : "failed",
      note: det.ok ? undefined : det.error,
    });

    // 2. Untag — explicit (instance, id) inboxes so the correct-group side's
    //    identical tag is never touched.
    const inboxes: { instance: string; id: number }[] = [];
    for (const domain of eligible) {
      let off = 0;
      while (true) {
        const { data, error } = await supabase
          .from("deliverability_inboxes")
          .select("id")
          .eq("instance", sourceInstance)
          .eq("domain", domain)
          .range(off, off + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const r of data as { id: number }[]) inboxes.push({ instance: sourceInstance, id: r.id });
        if (data.length < 1000) break;
        off += 1000;
      }
    }
    const untag = inboxes.length > 0
      ? await callJson("/api/deliverability/bulk-tags", { action: "remove", tagNames: [clientTag], inboxes })
      : { ok: true as const, json: {} };
    steps.push({
      label: `Remove ${clientTag} tag from ${inboxes.length} inbox(es)`,
      state: untag.ok ? "done" : "failed",
      note: untag.ok ? undefined : untag.error,
    });

    // 3. Clear the redirect — safe only because duplicates were refused above.
    const redir = await callJson("/api/deliverability/change-redirect", {
      dryRun: false, domains: eligible, clearRedirect: true,
    });
    steps.push({ label: "Clear redirect", state: redir.ok ? "done" : "failed", note: redir.ok ? undefined : redir.error });

    const ok = steps.every((s) => s.state !== "failed");
    await logEvents(
      eligible.map((d) => ({
        instance: sourceInstance as BisonInstanceSlug,
        domain: d,
        clientTag,
        eventType: ok ? ("removed" as const) : ("error" as const),
        detail: ok
          ? "wrong-instance untag — healthy, returned to reserve untagged, redirect cleared, NOT scheduled for deletion"
          : `wrong-instance untag incomplete: ${steps.filter((s) => s.state === "failed").map((s) => s.label).join(", ")}`,
      })),
    ).catch(() => {});

    return NextResponse.json({ ok, untagged: ok ? eligible.length : 0, skippedDuplicates, steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : "wrong-instance untag failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
