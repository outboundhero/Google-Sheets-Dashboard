"use client";

// Segmented threshold-group editor. Renders the per-client-tag rule-sets Spencer
// asked for: conditions AND'd inside a group, groups OR'd within a segment, and
// segments keyed by client tag (default = commercial cleaning / janitorial).
// Self-contained: reads/writes /api/replacement/threshold-groups and previews via
// /api/replacement/detect-groups. Additive — does not touch the flat guardrails.
import { useState, useEffect } from "react";
import { Plus, Trash2, RefreshCw, Loader2, Save, Power, RotateCcw, Layers } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type {
  ThresholdConfig, ThresholdSegment, ConditionGroup, Condition, MetricField, ConditionOp,
} from "@/lib/replacement/threshold-groups";

const FIELD_OPTIONS: { value: MetricField; label: string; bool?: boolean }[] = [
  { value: "sent", label: "Emails sent" },
  { value: "reply_15", label: "Reply rate 15d" },
  { value: "reply_30", label: "Reply rate 30d" },
  { value: "reply_10", label: "Reply rate 10d" },
  { value: "bounce_30f15", label: "Bounce 30d (fallback 15d)" },
  { value: "bounce_30", label: "Bounce rate 30d" },
  { value: "bounce_15", label: "Bounce rate 15d" },
  { value: "bounce_10", label: "Bounce rate 10d" },
  { value: "surbl", label: "SURBL", bool: true },
  { value: "spamhaus", label: "Spamhaus DBL", bool: true },
];
const NUM_OPS: { value: ConditionOp; label: string }[] = [
  { value: "gte", label: "≥" }, { value: "gt", label: ">" },
  { value: "lte", label: "≤" }, { value: "lt", label: "<" },
];
const BOOL_OPS: { value: ConditionOp; label: string }[] = [
  { value: "is_true", label: "is listed" }, { value: "is_false", label: "is clean" },
];
const isBoolField = (f: MetricField) => f === "surbl" || f === "spamhaus";
const isPercentField = (f: MetricField) => f.startsWith("reply") || f.startsWith("bounce");
const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`);

interface GroupCandidate {
  instance: string; domain: string; clientTag: string | null;
  sent: number; reply_15: number | null; reply_30: number | null; bounce_30f15: number | null;
  segmentName: string; groupName: string; reasons: string[];
}
interface PreviewResp {
  enabled: boolean; scanned: number; flaggedCount: number;
  byInstance: Record<string, number>; bySegment: Record<string, number>;
  candidates: GroupCandidate[];
}

export function ThresholdGroupsEditor() {
  const [cfg, setCfg] = useState<ThresholdConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/replacement/threshold-groups")
      .then((r) => r.json())
      .then((d) => (d?.error ? setError(d.error) : setCfg(d)))
      .catch((e) => setError(String(e)));
  }, []);

  // immutable helpers -------------------------------------------------------
  const patchCfg = (fn: (c: ThresholdConfig) => ThresholdConfig) =>
    setCfg((c) => (c ? fn(c) : c));
  const patchSeg = (segId: string, fn: (s: ThresholdSegment) => ThresholdSegment) =>
    patchCfg((c) => ({ ...c, segments: c.segments.map((s) => (s.id === segId ? fn(s) : s)) }));
  const patchGrp = (segId: string, grpId: string, fn: (g: ConditionGroup) => ConditionGroup) =>
    patchSeg(segId, (s) => ({ ...s, groups: s.groups.map((g) => (g.id === grpId ? fn(g) : g)) }));

  const addSegment = () =>
    patchCfg((c) => ({ ...c, segments: [...c.segments, { id: uid(), name: "New segment", clientTags: [], isDefault: false, groups: [] }] }));
  const removeSegment = (segId: string) =>
    patchCfg((c) => ({ ...c, segments: c.segments.filter((s) => s.id !== segId) }));
  const addGroup = (segId: string) =>
    patchSeg(segId, (s) => ({ ...s, groups: [...s.groups, { id: uid(), name: `Group ${s.groups.length + 1}`, conditions: [{ field: "sent", op: "gte", value: 500 }] }] }));
  const removeGroup = (segId: string, grpId: string) =>
    patchSeg(segId, (s) => ({ ...s, groups: s.groups.filter((g) => g.id !== grpId) }));
  const addCondition = (segId: string, grpId: string) =>
    patchGrp(segId, grpId, (g) => ({ ...g, conditions: [...g.conditions, { field: "reply_15", op: "lt", value: 1.5 }] }));
  const removeCondition = (segId: string, grpId: string, i: number) =>
    patchGrp(segId, grpId, (g) => ({ ...g, conditions: g.conditions.filter((_, idx) => idx !== i) }));
  const patchCondition = (segId: string, grpId: string, i: number, patch: Partial<Condition>) =>
    patchGrp(segId, grpId, (g) => ({
      ...g,
      conditions: g.conditions.map((c, idx) => {
        if (idx !== i) return c;
        const next = { ...c, ...patch };
        // switching between numeric/bool fields → snap op + value to valid state
        if (patch.field) {
          const bool = isBoolField(patch.field);
          const opOk = (bool ? BOOL_OPS : NUM_OPS).some((o) => o.value === next.op);
          if (!opOk) next.op = bool ? "is_true" : "lt";
          if (bool) delete next.value;
          else if (next.value == null) next.value = 0;
        }
        return next;
      }),
    }));

  const save = async () => {
    if (!cfg) return;
    setSaving(true); setError(null); setSavedAt(false);
    try {
      const res = await fetch("/api/replacement/threshold-groups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: cfg.enabled, segments: cfg.segments }),
      });
      const d = await res.json();
      if (d?.error) throw new Error(d.error);
      setCfg(d); setSavedAt(true); setTimeout(() => setSavedAt(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = async () => {
    const res = await fetch("/api/replacement/threshold-groups?defaults=1");
    const d = await res.json();
    if (!d?.error) setCfg((c) => ({ ...d, enabled: c?.enabled ?? false }));
  };

  const runPreview = async () => {
    setPreviewing(true); setError(null);
    try {
      const res = await fetch("/api/replacement/detect-groups");
      const d = await res.json();
      if (d?.error) throw new Error(d.error);
      setPreview(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  const opsFor = (f: MetricField) => (isBoolField(f) ? BOOL_OPS : NUM_OPS);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <button className="flex items-center gap-2 text-sm font-medium" onClick={() => setOpen((o) => !o)}>
            <Layers className="h-4 w-4" />
            Threshold groups — per-client-tag rules
            <Badge variant="outline" className={cfg?.enabled ? "border-emerald-500/30 text-emerald-500" : "border-muted-foreground/30 text-muted-foreground"}>
              {cfg?.enabled ? "active" : "off"}
            </Badge>
          </button>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={runPreview} disabled={previewing} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${previewing ? "animate-spin" : ""}`} />
              {previewing ? "Scanning…" : "Run group preview"}
            </Button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground -mt-1">
          Conditions inside a group are <b>AND</b>ed; groups within a segment are <b>OR</b>ed — any one group triggers replacement.
          A domain is matched to the first non-default segment that claims one of its tags, otherwise the default (cleaning) segment.
          Blank metrics are never treated as 0.
        </p>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {open && cfg && (
          <div className="space-y-4">
            {cfg.segments.map((seg) => (
              <div key={seg.id} className="rounded-xl border p-4 space-y-3 bg-muted/20">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={seg.name}
                    onChange={(e) => patchSeg(seg.id, (s) => ({ ...s, name: e.target.value }))}
                    className="text-sm font-medium px-2 py-1 rounded-lg border bg-background min-w-[220px]"
                  />
                  {seg.isDefault ? (
                    <Badge variant="outline" className="border-sky-500/30 text-sky-500">default · cleaning/janitorial</Badge>
                  ) : (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      tags
                      <input
                        value={seg.clientTags.join(", ")}
                        onChange={(e) => patchSeg(seg.id, (s) => ({ ...s, clientTags: e.target.value.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) }))}
                        placeholder="SC, OH"
                        className="text-sm px-2 py-1 rounded-lg border bg-background w-40"
                      />
                    </label>
                  )}
                  {!seg.isDefault && (
                    <Button size="sm" variant="ghost" onClick={() => removeSegment(seg.id)} className="text-destructive gap-1 ml-auto">
                      <Trash2 className="h-3.5 w-3.5" /> segment
                    </Button>
                  )}
                </div>

                {seg.groups.length === 0 && (
                  <div className="text-xs text-muted-foreground italic">No groups — this segment never triggers a replacement.</div>
                )}

                {seg.groups.map((g, gi) => (
                  <div key={g.id}>
                    {gi > 0 && <div className="text-[10px] font-semibold text-muted-foreground my-1.5">OR</div>}
                    <div className="rounded-lg border bg-background p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          value={g.name}
                          onChange={(e) => patchGrp(seg.id, g.id, (grp) => ({ ...grp, name: e.target.value }))}
                          className="text-xs font-medium px-2 py-1 rounded border bg-background flex-1"
                        />
                        <Button size="sm" variant="ghost" onClick={() => removeGroup(seg.id, g.id)} className="text-destructive h-7 px-2">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {g.conditions.map((c, ci) => (
                        <div key={ci} className="flex flex-wrap items-center gap-1.5">
                          {ci > 0 && <span className="text-[10px] font-semibold text-muted-foreground w-7">AND</span>}
                          {ci === 0 && <span className="w-7" />}
                          <select
                            value={c.field}
                            onChange={(e) => patchCondition(seg.id, g.id, ci, { field: e.target.value as MetricField })}
                            className="text-xs px-2 py-1 rounded border bg-background"
                          >
                            {FIELD_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                          </select>
                          <select
                            value={c.op}
                            onChange={(e) => patchCondition(seg.id, g.id, ci, { op: e.target.value as ConditionOp })}
                            className="text-xs px-2 py-1 rounded border bg-background"
                          >
                            {opsFor(c.field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          {!isBoolField(c.field) && (
                            <div className="flex items-center gap-1">
                              <input
                                type="number" step="any"
                                value={c.value ?? ""}
                                onChange={(e) => patchCondition(seg.id, g.id, ci, { value: e.target.value === "" ? undefined : Number(e.target.value) })}
                                className="w-24 text-xs px-2 py-1 rounded border bg-background"
                              />
                              {isPercentField(c.field) && <span className="text-[11px] text-muted-foreground">%</span>}
                            </div>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => removeCondition(seg.id, g.id, ci)} className="text-muted-foreground h-7 px-1.5">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => addCondition(seg.id, g.id)} className="gap-1 h-7 text-xs text-muted-foreground">
                        <Plus className="h-3 w-3" /> condition (AND)
                      </Button>
                    </div>
                  </div>
                ))}

                <Button size="sm" variant="outline" onClick={() => addGroup(seg.id)} className="gap-1 h-7 text-xs">
                  <Plus className="h-3 w-3" /> group (OR)
                </Button>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={addSegment} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> segment
              </Button>
              <Button size="sm" variant="outline" onClick={resetDefaults} className="gap-1">
                <RotateCcw className="h-3.5 w-3.5" /> reset to defaults
              </Button>
              <label className="flex items-center gap-2 text-sm ml-auto">
                <Button
                  size="sm"
                  variant={cfg.enabled ? "default" : "outline"}
                  onClick={() => patchCfg((c) => ({ ...c, enabled: !c.enabled }))}
                  className="gap-1.5"
                >
                  <Power className="h-3.5 w-3.5" /> {cfg.enabled ? "Groups ON" : "Groups OFF"}
                </Button>
              </label>
              <Button size="sm" onClick={save} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save groups
              </Button>
              {savedAt && <span className="text-xs text-emerald-500">Saved</span>}
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-2 pt-1">
            {!preview.enabled ? (
              <div className="text-xs text-muted-foreground italic">Groups are OFF — turn them on and save to preview.</div>
            ) : (
              <>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span className="text-muted-foreground">Scanned <b className="text-foreground">{preview.scanned.toLocaleString()}</b></span>
                  <span className="text-muted-foreground">Would flag <b className="text-amber-500">{preview.flaggedCount.toLocaleString()}</b></span>
                  {Object.entries(preview.bySegment).map(([k, v]) => (
                    <span key={k} className="text-muted-foreground">{k}: <b className="text-foreground">{v}</b></span>
                  ))}
                </div>
                {preview.candidates.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-muted-foreground">
                        <tr>
                          <th className="text-left px-2 py-1.5">Domain</th>
                          <th className="text-left px-2 py-1.5">Tag</th>
                          <th className="text-left px-2 py-1.5">Segment · group</th>
                          <th className="text-right px-2 py-1.5">Sent</th>
                          <th className="text-right px-2 py-1.5">R15/30</th>
                          <th className="text-left px-2 py-1.5">Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.candidates.slice(0, 200).map((c) => (
                          <tr key={`${c.instance}:${c.domain}`} className="border-t">
                            <td className="px-2 py-1.5 font-mono">{c.domain}</td>
                            <td className="px-2 py-1.5">{c.clientTag ?? "—"}</td>
                            <td className="px-2 py-1.5">{c.segmentName} · <span className="text-muted-foreground">{c.groupName}</span></td>
                            <td className="px-2 py-1.5 text-right">{c.sent.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right">{c.reply_15 ?? "—"}/{c.reply_30 ?? "—"}</td>
                            <td className="px-2 py-1.5 text-muted-foreground">{c.reasons.join(" · ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.candidates.length > 200 && (
                      <div className="px-2 py-1.5 text-[11px] text-muted-foreground">+{preview.candidates.length - 200} more…</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
