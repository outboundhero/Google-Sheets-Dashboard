import { NextResponse } from "next/server";
import { getThresholdConfig, updateThresholdConfig } from "@/lib/replacement/threshold-groups-store";
import { defaultThresholdConfig } from "@/lib/replacement/threshold-groups";
import type {
  Condition, ConditionGroup, ConditionOp, MetricField, ThresholdSegment,
} from "@/lib/replacement/threshold-groups";

// GET /api/replacement/threshold-groups  → current segmented config
// PUT /api/replacement/threshold-groups {enabled?, segments?} → save (admin-only via middleware)

const FIELDS: MetricField[] = [
  "sent", "reply_10", "reply_15", "reply_30",
  "bounce_10", "bounce_15", "bounce_30", "bounce_30f15", "surbl", "spamhaus",
];
const OPS: ConditionOp[] = ["gte", "gt", "lte", "lt", "is_true", "is_false"];

function sanitizeCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const field = r.field as MetricField;
  const op = r.op as ConditionOp;
  if (!FIELDS.includes(field) || !OPS.includes(op)) return null;
  const c: Condition = { field, op };
  if (op !== "is_true" && op !== "is_false") {
    const v = Number(r.value);
    if (Number.isNaN(v)) return null;
    c.value = v;
  }
  return c;
}

function sanitizeGroup(raw: unknown, i: number): ConditionGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const conditions = Array.isArray(r.conditions)
    ? (r.conditions.map(sanitizeCondition).filter(Boolean) as Condition[])
    : [];
  return {
    id: typeof r.id === "string" && r.id ? r.id : `grp-${Date.now()}-${i}`,
    name: typeof r.name === "string" ? r.name : `Group ${i + 1}`,
    conditions,
  };
}

function sanitizeSegment(raw: unknown, i: number): ThresholdSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const clientTags = Array.isArray(r.clientTags)
    ? r.clientTags.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : [];
  const groups = Array.isArray(r.groups)
    ? (r.groups.map(sanitizeGroup).filter(Boolean) as ConditionGroup[])
    : [];
  return {
    id: typeof r.id === "string" && r.id ? r.id : `seg-${Date.now()}-${i}`,
    name: typeof r.name === "string" ? r.name : `Segment ${i + 1}`,
    clientTags,
    isDefault: Boolean(r.isDefault),
    groups,
  };
}

export async function GET(request: Request) {
  try {
    // ?defaults=1 → hand back Spencer's cleaning seed without touching what's saved
    if (new URL(request.url).searchParams.get("defaults") === "1") {
      return NextResponse.json(defaultThresholdConfig());
    }
    return NextResponse.json(await getThresholdConfig());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { enabled?: unknown; segments?: unknown };
    const patch: { enabled?: boolean; segments?: ThresholdSegment[] } = {};

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

    if (body.segments !== undefined) {
      if (!Array.isArray(body.segments)) {
        return NextResponse.json({ error: "segments must be an array" }, { status: 400 });
      }
      const segments = body.segments.map(sanitizeSegment).filter(Boolean) as ThresholdSegment[];
      // exactly one default segment
      const defaults = segments.filter((s) => s.isDefault);
      if (defaults.length === 0 && segments.length > 0) segments[0].isDefault = true;
      if (defaults.length > 1) {
        let seen = false;
        for (const s of segments) {
          if (s.isDefault && seen) s.isDefault = false;
          if (s.isDefault) seen = true;
        }
      }
      patch.segments = segments;
    }

    return NextResponse.json(await updateThresholdConfig(patch));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
