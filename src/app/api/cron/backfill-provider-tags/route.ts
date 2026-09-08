import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import { logEvents } from "@/lib/replacement/store";

// One-off, operator-triggered (2026-09-08): every Inboxing-ordered domain that
// reached Bison since the Premium wave landed WITHOUT the "Inboxing" tag on its
// senders (Inboxing only stamps tags at creation since Ramon's change).
// LeadSync keys provider detection and movable-reserve on that tag, so 562
// domains were invisible as Inboxing stock. Adds the missing provider tag (and
// the US-IP marker for Premium-account domains) to the senders in Bison via
// the same attach-to-sender-emails call the bulk-tag dialog uses; tag IDs are
// resolved/created per instance by NAME.
//   ?dry=1 preview · ?instance= one workspace · ?limit= domains per run (default 60)
export const maxDuration = 600;

const PACE_MS = 600;

async function tagIdByName(instance: BisonInstanceSlug, name: string): Promise<number> {
  for (let page = 1; page <= 20; page++) {
    const res = await bisonFetch(instance, `/tags?page=${page}&per_page=100`);
    if (!res.ok) throw new Error(`tags list HTTP ${res.status} on ${instance}`);
    const j = await res.json();
    const data: { id: number; name: string }[] = (Array.isArray(j) ? j[0] : j)?.data || [];
    const hit = data.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    if (data.length < 100) break;
  }
  const c = await bisonFetch(instance, "/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  if (!c.ok) throw new Error(`create tag "${name}" HTTP ${c.status} on ${instance}`);
  const cj = await c.json();
  return (cj?.data ?? cj).id;
}

export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    const dry = p.get("dry") === "1";
    const only = p.get("instance") || "";
    const limit = Math.max(1, Math.min(200, Number(p.get("limit")) || 60));
    const supabase = getSupabaseAdmin();

    const { data: orders } = await supabase.from("inbox_orders").select("domain,inboxing_account").eq("provider", "inboxing").eq("status", "active");
    const account = new Map((orders || []).map((o) => [o.domain.toLowerCase(), o.inboxing_account || "ohco"]));

    const targets: { instance: BisonInstanceSlug; domain: string; tags: string[] }[] = [];
    for (let off = 0; ; off += 1000) {
      const { data } = await supabase.from("deliverability_domains").select("instance,domain,tags").order("domain").range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const d of data) {
        if (!isInstanceSlug(d.instance) || (only && d.instance !== only)) continue;
        const acc = account.get(d.domain.toLowerCase());
        if (!acc) continue;
        const have = new Set(((d.tags || []) as string[]).map((t) => t.trim().toLowerCase()));
        const want = (acc === "sst" ? ["Inboxing", "US-IP"] : ["Inboxing"]).filter((t) => !have.has(t.toLowerCase()));
        if (want.length) targets.push({ instance: d.instance, domain: d.domain, tags: want });
      }
      if (data.length < 1000) break;
    }
    const batch = targets.slice(0, limit);
    if (dry) return NextResponse.json({ dryRun: true, missing: targets.length, thisRun: batch.length, sample: batch.slice(0, 8) });

    const tagIds = new Map<string, number>();
    const results: { instance: string; domain: string; tags: string[]; senders: number; ok: boolean; error?: string }[] = [];
    for (const t of batch) {
      try {
        const { data: inb } = await supabase.from("deliverability_inboxes").select("id").eq("instance", t.instance).eq("domain", t.domain);
        const ids = (inb || []).map((r) => r.id as number);
        if (ids.length === 0) { results.push({ ...t, senders: 0, ok: false, error: "no senders in mirror" }); continue; }
        const tag_ids: number[] = [];
        for (const name of t.tags) {
          const k = `${t.instance}:${name}`;
          if (!tagIds.has(k)) tagIds.set(k, await tagIdByName(t.instance, name));
          tag_ids.push(tagIds.get(k)!);
        }
        const res = await bisonFetch(t.instance, "/tags/attach-to-sender-emails", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag_ids, sender_email_ids: ids }),
        });
        if (!res.ok) { results.push({ ...t, senders: ids.length, ok: false, error: `HTTP ${res.status}` }); continue; }
        const { data: row } = await supabase.from("deliverability_domains").select("tags").eq("instance", t.instance).eq("domain", t.domain).maybeSingle();
        const merged = [...new Set([...((row?.tags || []) as string[]), ...t.tags])];
        await supabase.from("deliverability_domains").update({ tags: merged }).eq("instance", t.instance).eq("domain", t.domain);
        results.push({ ...t, senders: ids.length, ok: true });
        await new Promise((r) => setTimeout(r, PACE_MS));
      } catch (e) {
        results.push({ ...t, senders: 0, ok: false, error: e instanceof Error ? e.message : "error" });
      }
    }
    const ok = results.filter((r) => r.ok);
    await logEvents(ok.map((r) => ({ instance: r.instance as BisonInstanceSlug, domain: r.domain, eventType: "tagged" as const, detail: `bulk-tags add by backfill-provider-tags: [${r.tags.join(", ")}] (provider tag backfill)` }))).catch(() => {});
    return NextResponse.json({ missing: targets.length, thisRun: batch.length, tagged: ok.length, failed: results.filter((r) => !r.ok), remaining: Math.max(0, targets.length - ok.length) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
