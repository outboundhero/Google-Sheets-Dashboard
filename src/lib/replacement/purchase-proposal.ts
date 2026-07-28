// Auto-purchase proposals (Spencer's Loom #12; user-approved flow 2026-07-29):
// when an instance's reserve is short, GENERATE a capped batch of .com/.co
// candidate names and hold them as a PENDING proposal + Slack notify. Nothing
// is ever bought here — the human Approve in LeadSync drives the actual chain
// (Porkbun check → register → inventory sync → Inboxing order) from the
// browser via the existing endpoints. No click, no money spent.
import { getSupabaseAdmin } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";
import { generateDomainCandidates } from "@/lib/openai-domains";
import { computePurchasePlan } from "./purchase-plan";
import { getCapacityLimits } from "./bison-capacity";

/** Max domains per proposal per instance (user 2026-07-29: 25). */
const BATCH_CAP = Math.max(1, Number(process.env.AUTO_PURCHASE_BATCH_CAP ?? 25));

export interface PurchaseProposal {
  id: number;
  instance: string;
  domains: string[];
  status: "pending" | "approved" | "rejected";
  note: string | null;
  results: Record<string, string> | null; // domain -> outcome after approval
  createdAt: string;
  decidedAt: string | null;
}

function mentionPrefix(): string {
  const ids = (process.env.SLACK_LOW_DOMAIN_MENTIONS || "U070H18FNLA,U06UYNAV01X")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => `<@${id}>`).join(" ");
}
function channelId(): string | undefined {
  return process.env.SLACK_REPLACEMENT_REPORT_CHANNEL_ID
    || process.env.SLACK_OUTBOUND_CHANNEL_ID
    || process.env.SLACK_LEAD_SYNC_CHANNEL_ID
    || "C0B84LMSVMH";
}

const mapRow = (r: Record<string, unknown>): PurchaseProposal => ({
  id: r.id as number,
  instance: r.instance as string,
  domains: (r.domains as string[]) ?? [],
  status: r.status as PurchaseProposal["status"],
  note: (r.note as string) ?? null,
  results: (r.results as Record<string, string>) ?? null,
  createdAt: r.created_at as string,
  decidedAt: (r.decided_at as string) ?? null,
});

export async function listProposals(limit = 50): Promise<PurchaseProposal[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_purchase_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(mapRow);
}

export interface GenerateResult {
  created: PurchaseProposal[];
  skipped: { instance: string; reason: string }[];
  capacityAlerts: { instance: string; current: number; capacity: number; incoming: number }[];
  alerted: boolean;
}

const MAILBOXES_PER_DOMAIN = 49; // Inboxing standard order size

/** Propose a capped batch per short instance (skips instances that already
 *  have a pending proposal). Generates candidate names only — buys nothing. */
export async function generateProposals(): Promise<GenerateResult> {
  const supabase = getSupabaseAdmin();
  const plan = await computePurchasePlan();
  const pending = (await listProposals(100)).filter((p) => p.status === "pending");
  const capacityLimits = await getCapacityLimits(); // dashboard-editable, env fallback

  const created: PurchaseProposal[] = [];
  const skipped: GenerateResult["skipped"] = [];
  const capacityAlerts: GenerateResult["capacityAlerts"] = [];
  // names already staged (open proposals + this run) — passed as the generator's
  // exclusion set so instances never propose the same name twice
  const taken: string[] = pending.flatMap((p) => p.domains);
  for (const inst of plan.byInstance) {
    if (inst.toBuy <= 0) continue;
    if (pending.some((p) => p.instance === inst.instance)) {
      skipped.push({ instance: inst.instance, reason: "pending proposal already open" });
      continue;
    }
    const want = Math.min(inst.toBuy, BATCH_CAP);

    // Bison capacity gate (Spencer 2026-07-29): if the new mailboxes won't fit
    // the instance's sender-account limit, DON'T propose — alert instead so
    // Nick/Spencer ask for more capacity in #outboundhero-bison.
    const capacity = capacityLimits[inst.instance] ?? 0;
    if (capacity > 0) {
      const { count } = await supabase
        .from("deliverability_inboxes")
        .select("id", { count: "exact", head: true })
        .eq("instance", inst.instance);
      const current = count ?? 0;
      const incoming = want * MAILBOXES_PER_DOMAIN;
      if (current + incoming > capacity) {
        capacityAlerts.push({ instance: inst.instance, current, capacity, incoming });
        skipped.push({ instance: inst.instance, reason: `Bison at capacity (${current}/${capacity} senders; +${incoming} won't fit)` });
        continue;
      }
    }

    let names: string[];
    try {
      names = (await generateDomainCandidates({
        mode: "niche",
        tlds: [".com", ".co"],
        count: want,
        niche: "commercial cleaning",
        examples: taken.slice(-120),
      })).filter((n) => !taken.includes(n)).slice(0, want);
    } catch (e) {
      skipped.push({ instance: inst.instance, reason: `name generation failed: ${e instanceof Error ? e.message : "error"}` });
      continue;
    }
    if (names.length === 0) { skipped.push({ instance: inst.instance, reason: "no names generated" }); continue; }

    const { data, error } = await supabase
      .from("replacement_purchase_proposals")
      .insert({
        instance: inst.instance,
        domains: names,
        status: "pending",
        note: `reserve short ${inst.toBuy} (cap deficit ${inst.capDeficit} + floor ${inst.reserveFloor} − reserve ${inst.availableReserve}); proposing ${names.length}`,
      })
      .select("*")
      .single();
    if (error) { skipped.push({ instance: inst.instance, reason: error.message }); continue; }
    taken.push(...names);
    created.push(mapRow(data as Record<string, unknown>));
  }

  let alerted = false;
  if (created.length > 0) {
    const lines = [`*🛒 Domain purchase proposal${created.length === 1 ? "" : "s"} — LeadSync* ${mentionPrefix()}`];
    for (const p of created) {
      lines.push(`• *${p.instance}*: ${p.domains.length} × .com/.co candidates (${p.note ?? "reserve short"})`);
    }
    lines.push("_Nothing is bought until someone clicks Approve: LeadSync → Replacement → Purchase proposals._");
    const slack = await postSlackMessage(lines.join("\n"), channelId());
    alerted = slack.ok;
  }
  if (capacityAlerts.length > 0) {
    const lines = [`*🚨 EmailBison at capacity — LeadSync* ${mentionPrefix()}`];
    for (const c of capacityAlerts) {
      lines.push(`• *${c.instance}*: ${c.current.toLocaleString()} of ${c.capacity.toLocaleString()} sender accounts — the next order (+${c.incoming.toLocaleString()}) won't fit.`);
    }
    lines.push("Please message *#outboundhero-bison* to get more sender-account capacity (≈10k per bump), then re-run the proposal.");
    await postSlackMessage(lines.join("\n"), channelId());
  }
  return { created, skipped, capacityAlerts, alerted };
}

/** Record the human decision (+ per-domain outcomes from the approval run). */
export async function decideProposal(
  id: number,
  status: "approved" | "rejected",
  results?: Record<string, string>,
): Promise<PurchaseProposal> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("replacement_purchase_proposals")
    .update({ status, results: results ?? null, decided_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapRow(data as Record<string, unknown>);
}
