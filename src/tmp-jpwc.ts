import { getSupabaseAdmin } from "@/lib/supabase";
import { computeTrueUp } from "@/lib/replacement/true-up";

async function main() {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("deliverability_domains")
    .select("instance, domain, inbox_count, total_sent")
    .contains("tags", ["JPWC"]);
  console.log(`domains tagged JPWC: ${data?.length ?? 0}`);
  const byInst = new Map<string, number>();
  for (const d of data || []) byInst.set(d.instance, (byInst.get(d.instance) ?? 0) + 1);
  for (const [i, n] of byInst) console.log(`  ${i}: ${n} domains`);

  const t = await computeTrueUp();
  const rows = t.rows.filter((r) => r.clientTag === "JPWC");
  for (const r of rows) {
    console.log(`\nJPWC/${r.instance}: staying=${r.staying}/${r.cap} fillShort=${r.fillShort} trimNeeded=${r.trimNeeded ?? 0}`);
    console.log(`  blockers: ${r.blockers.join("; ") || "(none)"}`);
    console.log(`  targetCampaigns: ${r.targetCampaigns.map((c) => c.name).join(", ") || "(none)"}`);
  }

  // Who is OVER cap — trim test candidates
  const over = t.rows.filter((r) => (r.trimNeeded ?? 0) > 0)
    .sort((a, b) => (b.trimNeeded ?? 0) - (a.trimNeeded ?? 0));
  console.log(`\n=== clients OVER cap (trim candidates): ${over.length} ===`);
  for (const r of over.slice(0, 10)) {
    console.log(`  ${r.clientTag}/${r.instance}: have=${r.staying} cap=${r.cap} trim=${r.trimNeeded} candidates=${r.trimCandidates?.length ?? 0}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
