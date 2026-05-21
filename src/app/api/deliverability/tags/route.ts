import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  ALL_INSTANCE_SLUGS,
  isInstanceSlug,
  parseGroup,
  instancesInGroup,
} from "@/lib/bison-instances";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const instancesParam = searchParams.get("instances");
    const groupParam = searchParams.get("group");

    let instances: string[];
    if (instancesParam) {
      instances = instancesParam.split(",").map((s) => s.trim()).filter(isInstanceSlug);
    } else if (groupParam) {
      const g = parseGroup(groupParam);
      instances = g ? instancesInGroup(g).map((i) => i.slug) : [...ALL_INSTANCE_SLUGS];
    } else {
      instances = [...ALL_INSTANCE_SLUGS];
    }
    if (instances.length === 0) instances = [...ALL_INSTANCE_SLUGS];

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("deliverability_inboxes")
      .select("tags")
      .in("instance", instances)
      .not("tags", "is", null);

    if (error) {
      console.error("[deliverability/tags] supabase error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const tagSet = new Set<string>();
    for (const row of data || []) {
      const t = (row as { tags?: unknown }).tags;
      if (Array.isArray(t)) {
        for (const item of t) {
          if (
            item &&
            typeof item === "object" &&
            "name" in item &&
            typeof (item as { name: unknown }).name === "string"
          ) {
            tagSet.add((item as { name: string }).name);
          }
        }
      }
    }

    return NextResponse.json(Array.from(tagSet).sort());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    console.error("[deliverability/tags]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
