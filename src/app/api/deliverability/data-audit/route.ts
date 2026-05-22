import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, ALL_INSTANCE_SLUGS } from "@/lib/bison";
import { BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 60;

/** Pull the `meta.total` count from a Bison list endpoint (1 cheap request). */
async function bisonTotal(instance: BisonInstanceSlug, path: string): Promise<number | null> {
  try {
    const res = await bisonFetch(instance, path);
    if (!res.ok) return null;
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const total = payload?.meta?.total;
    return typeof total === "number" ? total : null;
  } catch {
    return null;
  }
}

async function storedCount(
  table: "deliverability_inboxes" | "deliverability_domains",
  instance: BisonInstanceSlug,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("instance", instance);
  return count ?? 0;
}

export async function GET() {
  try {
    const rows = await Promise.all(
      ALL_INSTANCE_SLUGS.map(async (instance) => {
        const [actualInboxes, storedInboxes, storedDomains] = await Promise.all([
          bisonTotal(instance, "/sender-emails?page=1&per_page=1"),
          storedCount("deliverability_inboxes", instance),
          storedCount("deliverability_domains", instance),
        ]);
        const staleInboxes =
          actualInboxes != null ? Math.max(0, storedInboxes - actualInboxes) : null;
        return {
          instance,
          label: BISON_INSTANCES[instance].label,
          actualInboxes,        // live count from Bison
          storedInboxes,        // count in our Supabase
          staleInboxes,         // stored - actual (rows to be pruned)
          storedDomains,        // domains in our Supabase
        };
      }),
    );

    const sum = (key: "actualInboxes" | "storedInboxes" | "staleInboxes" | "storedDomains") =>
      rows.reduce((acc, r) => acc + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);

    return NextResponse.json({
      perInstance: rows,
      totals: {
        actualInboxes: sum("actualInboxes"),
        storedInboxes: sum("storedInboxes"),
        staleInboxes: sum("staleInboxes"),
        storedDomains: sum("storedDomains"),
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
