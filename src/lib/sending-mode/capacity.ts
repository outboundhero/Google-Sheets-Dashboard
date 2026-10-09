// Sends per day a client can do now vs under the throttle limit, from the
// dashboard's copy of Bison (deliverability_inboxes, refreshed by the
// deliverability crawl): every connected inbox on a domain carrying the
// client tag, capped by the client's sending campaigns' daily caps. Shared by
// the throttle pass (its "never push a client under target" check) and the
// throttle preview, so the two always agree.
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

export interface SendCapacity {
  accounts: number;
  lowered: number;          // above the throttle limit → would be lowered to it
  perDayNow: number;
  perDayThrottled: number;
  /** perDayThrottled ÷ perDayNow — the share of sending the throttle keeps. */
  keepRatio: number;
}

const SENDING = new Set(["active", "launching", "launch processing"]);
const disconnected = (status: string | null) =>
  /disconnect|reconnection|login failed|auth failed|not connected/i.test(String(status || ""));

export async function sendCapacity(tags: string[], throttleLimit: number): Promise<Map<string, SendCapacity>> {
  const supabase = getSupabaseAdmin();
  const out = new Map<string, SendCapacity>();
  if (tags.length === 0) return out;

  const { data: camps, error: campErr } = await supabase
    .from("campaigns").select("client_tag, status, max_emails_per_day").in("client_tag", tags);
  if (campErr) throw new Error(campErr.message);

  for (const tag of tags) {
    const { data: doms, error } = await supabase
      .from("deliverability_domains").select("instance, domain")
      .in("instance", ALL_INSTANCE_SLUGS).contains("tags", [tag]);
    if (error) throw new Error(error.message);
    const domList = (doms || []) as { instance: string; domain: string }[];
    const keys = new Set(domList.map((x) => `${x.instance}:${x.domain}`));
    const names = [...new Set(domList.map((x) => x.domain))];
    const limits: number[] = [];
    // ~50 inboxes a domain: page every slice, a single read stops at 1,000 rows.
    for (let i = 0; i < names.length; i += 50) {
      for (let off = 0; ; off += 1000) {
        const { data: ib, error: e } = await supabase
          .from("deliverability_inboxes").select("instance, domain, status, daily_limit")
          .in("domain", names.slice(i, i + 50)).order("id").range(off, off + 999);
        if (e) throw new Error(e.message);
        for (const x of (ib || []) as { instance: string; domain: string; status: string | null; daily_limit: number | null }[]) {
          if (keys.has(`${x.instance}:${x.domain}`) && !disconnected(x.status)) limits.push(Number(x.daily_limit ?? 0));
        }
        if (!ib || ib.length < 1000) break;
      }
    }

    const active = ((camps || []) as { client_tag: string | null; status: string | null; max_emails_per_day: number | null }[])
      .filter((c) => String(c.client_tag || "").trim().toUpperCase() === tag && SENDING.has(String(c.status || "").toLowerCase()));
    const caps = active.map((c) => Number(c.max_emails_per_day || 0));
    const campaignCap = active.length && caps.every((c) => c > 0) ? caps.reduce((a, b) => a + b, 0) : null;
    const ceiling = (n: number) => (!active.length ? 0 : campaignCap === null ? n : Math.min(n, campaignCap));
    const perDayNow = ceiling(limits.reduce((s, l) => s + l, 0));
    const perDayThrottled = ceiling(limits.reduce((s, l) => s + Math.min(l, throttleLimit), 0));

    out.set(tag, {
      accounts: limits.length,
      lowered: limits.filter((l) => l > throttleLimit).length,
      perDayNow,
      perDayThrottled,
      keepRatio: perDayNow > 0 ? perDayThrottled / perDayNow : 1,
    });
  }
  return out;
}
