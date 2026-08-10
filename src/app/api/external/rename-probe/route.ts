import { NextResponse } from "next/server";
import { bisonFetch } from "@/lib/bison";

// TEMP: find the Bison campaign-rename endpoint. Duplicates a source (draft copy),
// tries rename candidates, verifies, then deletes the draft. Remove after.
export const maxDuration = 60;
const TOKEN = process.env.EXTERNAL_API_TOKEN || "outboundhero2024";
const NEW_NAME = "ZZZ_RENAME_PROBE_OK";

async function call(path: string, method: string, body?: unknown) {
  try {
    const res = await bisonFetch("outboundhero", path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    let j: unknown = null; try { j = t ? JSON.parse(t) : null; } catch {}
    return { method, path, status: res.status, ok: res.ok, body: j ?? t.slice(0, 200) };
  } catch (e) { return { method, path, status: 0, ok: false, error: e instanceof Error ? e.message : "x" }; }
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const src = new URL(request.url).searchParams.get("id") || "1509";
  // 1. duplicate source → draft copy
  const dup = await call(`/campaigns/${src}/duplicate`, "POST", {});
  const newId = (dup.body as { data?: { id?: number } })?.data?.id;
  if (!newId) return NextResponse.json({ step: "duplicate", dup });

  // 2. try rename candidates
  const candidates: [string, string][] = [
    [`/campaigns/${newId}/update`, "PATCH"],
    [`/campaigns/${newId}`, "POST"],
    [`/campaigns/${newId}/general-settings`, "PUT"],
    [`/campaigns/${newId}/general-settings`, "POST"],
    [`/campaigns/${newId}/settings`, "PUT"],
    [`/campaigns/${newId}/settings`, "POST"],
    [`/campaigns/${newId}/rename`, "POST"],
    [`/campaigns/${newId}/rename`, "PATCH"],
    [`/campaigns/${newId}/details`, "PUT"],
    [`/campaigns/${newId}/update`, "POST"],
  ];
  const attempts = [];
  let renamed = false;
  for (const [p, m] of candidates) {
    const r = await call(p, m, { name: NEW_NAME });
    attempts.push({ method: m, path: p.replace(`${newId}`, "{id}"), status: r.status });
    if (r.ok) { attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], WORKED: true } as never; renamed = true; break; }
  }
  // 3. verify current name
  const after = await call(`/campaigns/${newId}`, "GET");
  const curName = (after.body as { data?: { name?: string } })?.data?.name;

  // 4. cleanup
  const del = await call(`/campaigns/${newId}`, "DELETE");

  return NextResponse.json({ newId, renamed, currentNameAfter: curName, attempts, deleted: del.status });
}
