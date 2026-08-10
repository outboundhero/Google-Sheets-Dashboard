import { NextResponse } from "next/server";
import { bisonFetch } from "@/lib/bison";
import { isInstanceSlug } from "@/lib/bison-instances";

// TEMP Phase-0 discovery harness for the Campaign Management build — probes what
// the Bison REST API supports for duplicate / create / schedule / leads, which
// this codebase has never exercised. Token-guarded (Bearer EXTERNAL_API_TOKEN),
// middleware-exempt via /api/external. Mutating ops require confirm=yes and only
// ever create clearly-named DRAFT campaigns (never launched). DELETE THIS ROUTE
// after the spike.
export const maxDuration = 60;
const TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";
const TEST_NAME = "ZZZ_LEADSYNC_API_SPIKE_DELETE";

async function call(instance: Parameters<typeof bisonFetch>[0], method: string, path: string, body?: unknown) {
  try {
    const res = await bisonFetch(instance, path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { method, path, status: res.status, ok: res.ok, body: json ?? (text ? text.slice(0, 700) : null) };
  } catch (e) {
    return { method, path, status: 0, ok: false, error: e instanceof Error ? e.message : "err" };
  }
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "access";
  const instance = url.searchParams.get("instance") || "outboundhero";
  if (!isInstanceSlug(instance)) return NextResponse.json({ error: "bad instance" }, { status: 400 });
  const id = url.searchParams.get("id");
  const name = url.searchParams.get("name") || TEST_NAME;
  const confirm = url.searchParams.get("confirm") === "yes";
  const needId = () => { if (!id) throw new Error("id required"); return id; };
  const needConfirm = () => { if (!confirm) throw new Error("add confirm=yes — this MUTATES Bison"); };

  try {
    if (op === "access") {
      const r = await call(instance, "GET", "/campaigns?per_page=5&page=1");
      const b = r.body as { data?: Record<string, unknown>[]; meta?: unknown } | null;
      const first = b?.data?.[0];
      return NextResponse.json({ op, instance, status: r.status, meta: b?.meta,
        firstCampaignKeys: first ? Object.keys(first) : null, sample: first,
        list: (b?.data || []).map((c) => ({ id: c.id, name: c.name, status: c.status })) });
    }
    if (op === "inspect") {
      const r = await call(instance, "GET", `/campaigns/${needId()}`);
      const data = (r.body as { data?: Record<string, unknown> } | null)?.data ?? r.body;
      return NextResponse.json({ op, id, status: r.status, keys: data && typeof data === "object" ? Object.keys(data) : null, data });
    }
    if (op === "sequence") {
      return NextResponse.json({ op, id, result: await call(instance, "GET", `/campaigns/v1.1/${needId()}/sequence-steps`) });
    }
    if (op === "leads") {
      const attempts = [];
      for (const p of [`/campaigns/${needId()}/leads?per_page=1`, `/campaigns/${id}/lead-list?per_page=1`, `/leads?campaign_id=${id}&per_page=1`]) {
        attempts.push(await call(instance, "GET", p));
      }
      return NextResponse.json({ op, id, attempts });
    }
    if (op === "duplicate") {
      needId(); needConfirm();
      const candidates: [string, string, unknown][] = [
        ["POST", `/campaigns/${id}/duplicate`, { name }],
        ["POST", `/campaigns/${id}/duplicate`, null],
        ["POST", `/campaigns/${id}/clone`, { name }],
        ["POST", `/campaigns/${id}/copy`, { name }],
        ["POST", `/campaigns/duplicate`, { campaign_id: Number(id), name }],
      ];
      const attempts = [];
      for (const [m, p, b] of candidates) { const r = await call(instance, m, p, b); attempts.push(r); if (r.ok) break; }
      return NextResponse.json({ op, sourceId: id, attempts });
    }
    if (op === "create") {
      needConfirm();
      return NextResponse.json({ op, attempt: await call(instance, "POST", "/campaigns", { name }) });
    }
    if (op === "schedule") {
      needId(); needConfirm();
      const payload = { start_time: "09:00", end_time: "17:00", timezone: "America/Los_Angeles" };
      const candidates: [string, string, unknown][] = [
        ["PATCH", `/campaigns/${id}`, payload],
        ["PUT", `/campaigns/${id}`, payload],
        ["POST", `/campaigns/${id}/schedule`, payload],
        ["PATCH", `/campaigns/${id}/settings`, payload],
        ["POST", `/campaigns/${id}/settings`, payload],
      ];
      const attempts = [];
      for (const [m, p, b] of candidates) { const r = await call(instance, m, p, b); attempts.push(r); if (r.ok) break; }
      return NextResponse.json({ op, id, attempts });
    }
    if (op === "delete") {
      needId(); needConfirm();
      const attempts = [await call(instance, "DELETE", `/campaigns/${id}`)];
      if (!attempts[0].ok) attempts.push(await call(instance, "PATCH", `/campaigns/${id}/archive`));
      return NextResponse.json({ op, id, attempts });
    }
    return NextResponse.json({ error: `unknown op: ${op}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
