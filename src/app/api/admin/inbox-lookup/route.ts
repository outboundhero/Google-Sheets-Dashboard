import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";
import { bisonFetch, resolveInstance } from "@/lib/bison";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

export const maxDuration = 30;

/**
 * GET /api/admin/inbox-lookup?instance=<slug>&email=<email>
 *      or ?instance=<slug>&senderId=<id>
 *
 * Live-checks a single sender against Bison and against LeadSync's cache
 * so you can spot-verify that the reconnect flow actually attached the
 * right tags + campaigns.
 *
 * Returns:
 *   bison_live: {
 *     id, email, status, type, tags: [{id, name}], created_at, updated_at
 *   }
 *   bison_campaigns: [{ id, name, status }]   // campaigns the sender is on
 *   supabase_cache: {
 *     tags: [{id, name}], domain, status, synced_at
 *   }
 *   pending_reconnect_history: recent rows from pending_reconnect_work for this sender
 *
 * Admin-only.
 */

interface BisonSender {
  id: number;
  email: string;
  status: string;
  type: string;
  tags?: { id: number; name: string }[];
  created_at?: string;
  updated_at?: string;
}

interface BisonCampaign {
  id: number;
  name: string;
  status: string;
}

async function findSenderByEmail(
  instance: BisonInstanceSlug,
  email: string,
): Promise<BisonSender | null> {
  // /sender-emails?search=<email>&pagination_type=cursor
  const res = await bisonFetch(
    instance,
    `/sender-emails?search=${encodeURIComponent(email)}&pagination_type=cursor`,
  );
  if (!res.ok) return null;
  const json = await res.json();
  const payload = Array.isArray(json) ? json[0] : json;
  const data: BisonSender[] = payload?.data || [];
  const wanted = email.toLowerCase();
  return data.find((s) => (s.email || "").toLowerCase() === wanted) || null;
}

async function findSenderById(
  instance: BisonInstanceSlug,
  id: number,
): Promise<BisonSender | null> {
  const res = await bisonFetch(instance, `/sender-emails/${id}`);
  if (!res.ok) return null;
  const json = await res.json();
  const data: BisonSender = (json?.data as BisonSender) || (json as BisonSender);
  return data && typeof data.id === "number" ? data : null;
}

async function fetchSenderCampaigns(
  instance: BisonInstanceSlug,
  id: number,
): Promise<BisonCampaign[]> {
  const out: BisonCampaign[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const qs = cursor
      ? `pagination_type=cursor&cursor=${encodeURIComponent(cursor)}`
      : `pagination_type=cursor`;
    const res = await bisonFetch(instance, `/sender-emails/${id}/campaigns?${qs}`);
    if (!res.ok) break;
    const json = await res.json();
    const payload = Array.isArray(json) ? json[0] : json;
    const data: BisonCampaign[] = payload?.data || [];
    out.push(...data);
    const next = payload?.meta?.next_cursor ?? null;
    if (!next || data.length === 0) break;
    cursor = next;
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    const supabaseAuth = createServerSupabaseClient(cookieStore);
    const { data: { user } } = await supabaseAuth.auth.getUser();
    const role = user?.app_metadata?.role || user?.user_metadata?.role;
    if (!user || role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const instance = resolveInstance(searchParams.get("instance"));
    const emailParam = (searchParams.get("email") || "").trim();
    const senderIdParam = parseInt(searchParams.get("senderId") || "", 10);

    let live: BisonSender | null = null;
    if (Number.isFinite(senderIdParam) && senderIdParam > 0) {
      live = await findSenderById(instance, senderIdParam);
    } else if (emailParam.length > 0) {
      live = await findSenderByEmail(instance, emailParam);
    } else {
      return NextResponse.json({ error: "Pass ?email= or ?senderId=" }, { status: 400 });
    }

    if (!live) {
      return NextResponse.json({
        instance,
        found_in_bison: false,
        note: "Sender not found on Bison",
      });
    }

    const campaigns = await fetchSenderCampaigns(instance, live.id);

    // Supabase cache view for context.
    const supabase = getSupabaseAdmin();
    const { data: cache } = await supabase
      .from("deliverability_inboxes")
      .select("id, domain, status, tags, synced_at")
      .eq("instance", instance)
      .eq("id", live.id)
      .maybeSingle();

    // Recent queue history for this sender.
    const { data: history } = await supabase
      .from("pending_reconnect_work")
      .select("id, status, attempts, enqueued_at, processed_at, last_error, result")
      .eq("instance", instance)
      .eq("sender_id", live.id)
      .order("enqueued_at", { ascending: false })
      .limit(5);

    return NextResponse.json({
      instance,
      found_in_bison: true,
      bison_live: {
        id: live.id,
        email: live.email,
        status: live.status,
        type: live.type,
        tags: live.tags || [],
        created_at: live.created_at,
        updated_at: live.updated_at,
      },
      bison_campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
      })),
      bison_campaign_count: campaigns.length,
      supabase_cache: cache
        ? {
            tags: (cache as { tags?: unknown }).tags ?? [],
            domain: (cache as { domain?: string }).domain,
            status: (cache as { status?: string }).status,
            synced_at: (cache as { synced_at?: string }).synced_at,
          }
        : null,
      pending_reconnect_history: history ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lookup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
