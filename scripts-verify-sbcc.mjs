// Verify the SBCC offboarding numbers shown in the dialog against
// Supabase (campaigns + deliverability_inboxes) and Bison (tags).
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apiKey = process.env.OUTBOUNDHERO_API_KEY;
if (!url || !key || !apiKey) { console.error("missing env"); process.exit(1); }

const supabase = createClient(url, key, { auth: { persistSession: false } });
const TAG = "SBCC";
const INSTANCE = "outboundhero";

// Active (non-archived, non-paused) campaigns for SBCC in outboundhero.
const { data: camps, error: e1 } = await supabase
  .from("campaigns")
  .select("id, name, status")
  .eq("instance", INSTANCE)
  .eq("client_tag", TAG)
  .not("status", "in", '("archived","paused")');
if (e1) throw new Error(e1.message);

console.log(`active campaigns (non-archived, non-paused): ${camps.length}`);
for (const c of camps) console.log(`  ${c.id}  status=${c.status}  ${c.name}`);

// Inboxes carrying the SBCC tag in outboundhero (jsonb contains).
const needle = JSON.stringify([{ name: TAG }]);
let offset = 0;
const inboxes = [];
while (true) {
  const { data, error } = await supabase
    .from("deliverability_inboxes")
    .select("id, domain, email")
    .eq("instance", INSTANCE)
    .filter("tags", "cs", needle)
    .range(offset, offset + 999);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) break;
  inboxes.push(...data);
  if (data.length < 1000) break;
  offset += 1000;
}
const domains = new Set(inboxes.map((i) => i.domain));
console.log(`\ninboxes tagged ${TAG}: ${inboxes.length}`);
console.log(`unique domains: ${domains.size}`);

// Bison cross-check: ask Bison directly for SBCC's tag and count senders.
const tagsRes = await fetch("https://app.outboundhero.co/api/tags", {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const tagsJson = await tagsRes.json();
const sbccTag = (tagsJson.data || []).find((t) => t.name.toUpperCase() === TAG);
console.log(`\nBison tag ${TAG}: id=${sbccTag?.id || "MISSING"}`);
if (sbccTag) {
  // Count via the senders-by-tag endpoint, page 1 meta.total.
  const r = await fetch(
    `https://app.outboundhero.co/api/sender-emails?tag_ids[]=${sbccTag.id}&page=1&per_page=15`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const j = await r.json();
  const payload = Array.isArray(j) ? j[0] : j;
  console.log(`Bison senders tagged SBCC (total per meta): ${payload.meta?.total ?? "?"}`);
}
