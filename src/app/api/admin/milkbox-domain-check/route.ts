import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient, getSupabaseAdmin } from "@/lib/supabase";
import { listDomains, milkboxRawGet } from "@/lib/milkbox";

export const maxDuration = 60;

// GET /api/admin/milkbox-domain-check?domains=a.com,b.com  (admin only)
//
// What MilkBox itself says about a domain, straight from GET /domains/{id}:
// redirect_url, status/active, and nameserver_check. Our mirror only stores
// the redirect we *observe* over HTTP, so when a client's redirect looks
// missing (CVJLOU, Nick 2026-09-23 — three MilkBox domains answering 403 with
// no redirect) there was no way to tell apart:
//   redirect_url null           → our PATCH never landed (our bug)
//   set + nameserver not ok     → DNS never pointed at MilkBox (nothing serves)
//   set + nameserver ok         → MilkBox is not serving it (their side)
// Read-only: two GETs per domain, nothing is written anywhere.

interface Row {
  domain: string;
  found: boolean;
  milkboxId?: string;
  redirectUrl?: string | null;
  status?: string | null;
  active?: boolean | null;
  nameserverStatus?: string | null;
  observedNameservers?: string[];
  mirrorRedirect?: string | null;
  tags?: string[];
  verdict: string;
  raw?: unknown;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const supabaseAuth = createServerSupabaseClient(cookieStore);
  const { data: { user } } = await supabaseAuth.auth.getUser();
  const role = user?.app_metadata?.role || user?.user_metadata?.role;
  if (!user || role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const names = (url.searchParams.get("domains") || "")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean).slice(0, 25);
  const includeRaw = url.searchParams.get("raw") === "1";
  if (names.length === 0) {
    return NextResponse.json({ error: "domains=a.com,b.com required (max 25)" }, { status: 400 });
  }

  try {
    // MilkBox ids by name (the order table often has no row for domains Nick
    // or the vendor created by hand, so resolve by name against their list).
    const list = await listDomains();
    const idByName = new Map(list.map((d) => [d.name.toLowerCase(), String(d.id)]));

    // What our mirror believes, for the side-by-side.
    const supabase = getSupabaseAdmin();
    const { data: mirror } = await supabase
      .from("deliverability_domains")
      .select("domain, redirect_url, tags")
      .in("domain", names);
    const mirrorByName = new Map(
      ((mirror || []) as { domain: string; redirect_url: string | null; tags: string[] | null }[])
        .map((m) => [m.domain.toLowerCase(), m]),
    );

    const rows: Row[] = [];
    for (const domain of names) {
      const m = mirrorByName.get(domain);
      const id = idByName.get(domain);
      if (!id) {
        rows.push({
          domain, found: false, mirrorRedirect: m?.redirect_url ?? null, tags: m?.tags ?? [],
          verdict: "not on MilkBox — we cannot set its redirect through the API",
        });
        continue;
      }
      const { status: http, body } = await milkboxRawGet(`/domains/${encodeURIComponent(id)}`);
      const data = (body as { data?: Record<string, unknown> } | null)?.data ?? null;
      if (http < 200 || http >= 300 || !data) {
        rows.push({ domain, found: true, milkboxId: id, verdict: `MilkBox GET /domains/{id} returned HTTP ${http}`, raw: includeRaw ? body : undefined });
        continue;
      }
      const ns = (data.nameserver_check ?? null) as { status?: string; observed_nameservers?: string[] } | null;
      const redirectUrl = (data.redirect_url ?? null) as string | null;
      const nsStatus = ns?.status ?? null;
      const verdict = !redirectUrl
        ? "no redirect at MilkBox — our update never landed"
        : nsStatus && nsStatus !== "ok"
          ? `redirect set but nameserver_check = ${nsStatus} — DNS is not pointing at MilkBox, so nothing serves it`
          : "redirect set and nameservers look fine — if the domain still does not redirect, it is MilkBox's serving side";
      rows.push({
        domain, found: true, milkboxId: id, redirectUrl,
        status: (data.status ?? null) as string | null,
        active: (data.active ?? null) as boolean | null,
        nameserverStatus: nsStatus,
        observedNameservers: ns?.observed_nameservers ?? [],
        mirrorRedirect: m?.redirect_url ?? null,
        tags: m?.tags ?? [],
        verdict,
        raw: includeRaw ? data : undefined,
      });
    }

    return NextResponse.json({ checked: rows.length, milkboxDomainsListed: list.length, rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "milkbox-domain-check failed" }, { status: 500 });
  }
}
