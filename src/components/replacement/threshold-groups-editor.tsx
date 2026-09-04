"use client";

// Segmented threshold-group editor. Renders the per-client-tag rule-sets Spencer
// asked for: conditions AND'd inside a group, groups OR'd within a segment, and
// segments keyed by client tag (default = commercial cleaning / janitorial).
// Spencer Aug-11: the config is STATIC (read-only summary) until "Edit groups";
// segments/groups can be DUPLICATED (e.g. copy the cleaning defaults onto SC)
// instead of rebuilding from scratch. The flagged-domain preview moved out to
// the FlaggedDomainsCard — this card is configuration only.
import { useState, useEffect } from "react";
import { Plus, Trash2, Loader2, Save, Power, RotateCcw, Layers, Pencil, Copy, X } from "lucide-react";
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

/** One condition as compact text for the read-only view, e.g. "Reply rate 15d < 1.6%". */
function condText(c: Condition): string {
  const f = FIELD_OPTIONS.find((x) => x.value === c.field)?.label ?? c.field;
  if (isBoolField(c.field)) return `${f} ${c.op === "is_true" ? "is listed" : "is clean"}`;
  const op = NUM_OPS.find((o) => o.value === c.op)?.label ?? c.op;
  return `${f} ${op} ${c.value ?? "—"}${isPercentField(c.field) ? "%" : ""}`;
}

export function ThresholdGroupsEditor() {
  const [cfg, setCfg] = useState<ThresholdConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | "cleaning" | "non-cleaning">("all");
  const [tagSearch, setTagSearch] = useState("");
  const [sortAZ, setSortAZ] = useState(false);

  // Company type (Nick 8/4 doc #6): the four internal tags are the only
  // non-cleaning segments — same set true-up excludes (INTERNAL_TAGS there;
  // that lib is server-only, so the list is mirrored here).
  const NON_CLEANING = new Set(["OH", "SC", "DM4PM", "SI"]);
  const segType = (seg: ThresholdSegment): "cleaning" | "non-cleaning" =>
    !seg.isDefault && seg.clientTags.length > 0 && seg.clientTags.every((t) => NON_CLEANING.has(t.toUpperCase()))
      ? "non-cleaning" : "cleaning";
  const visibleSegments = (segments: ThresholdSegment[]): ThresholdSegment[] => {
    const q = tagSearch.trim().toUpperCase();
    let out = segments.filter((s) =>
      (typeFilter === "all" || segType(s) === typeFilter) &&
      (!q || s.name.toUpperCase().includes(q) || s.clientTags.some((t) => t.toUpperCase().includes(q))));
    if (sortAZ) out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  };

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
  // Duplicate a whole segment (deep copy, fresh ids) — Spencer: "duplicate this
  // and put it over to SC ... then we can edit once we've already duplicated".
  // Tags start blank so the copy can't shadow the source's tags by accident.
  const duplicateSegment = (segId: string) => {
    setEditing(true);
    patchCfg((c) => {
      const src = c.segments.find((s) => s.id === segId);
      if (!src) return c;
      const copy: ThresholdSegment = {
        id: uid(),
        name: `${src.name} (copy)`,
        clientTags: [],
        isDefault: false,
        groups: src.groups.map((g) => ({ id: uid(), name: g.name, conditions: g.conditions.map((cd) => ({ ...cd })) })),
      };
      const idx = c.segments.findIndex((s) => s.id === segId);
      const segments = [...c.segments];
      segments.splice(idx + 1, 0, copy);
      return { ...c, segments };
    });
  };
  const addGroup = (segId: string) =>
    patchSeg(segId, (s) => ({ ...s, groups: [...s.groups, { id: uid(), name: `Group ${s.groups.length + 1}`, conditions: [{ field: "sent", op: "gte", value: 500 }] }] }));
  const duplicateGroup = (segId: string, grpId: string) =>
    patchSeg(segId, (s) => {
      const src = s.groups.find((g) => g.id === grpId);
      if (!src) return s;
      const copy: ConditionGroup = { id: uid(), name: `${src.name} (copy)`, conditions: src.conditions.map((cd) => ({ ...cd })) };
      const idx = s.groups.findIndex((g) => g.id === grpId);
      const groups = [...s.groups];
      groups.splice(idx + 1, 0, copy);
      return { ...s, groups };
    });
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
      setCfg(d); setSavedAt(true); setEditing(false); setTimeout(() => setSavedAt(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = async () => {
    setEditing(false); setError(null);
    // discard unsaved changes — reload the stored config
    try {
      const res = await fetch("/api/replacement/threshold-groups");
      const d = await res.json();
      if (!d?.error) setCfg(d);
    } catch { /* keep local state if the refetch fails */ }
  };

  const resetDefaults = async () => {
    const res = await fetch("/api/replacement/threshold-groups?defaults=1");
    const d = await res.json();
    if (!d?.error) setCfg((c) => ({ ...d, enabled: c?.enabled ?? false }));
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
          {open && cfg && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="gap-2">
              <Pencil className="h-3.5 w-3.5" /> Edit groups
            </Button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground -mt-1">
          Conditions inside a group are <b>AND</b>ed; groups within a segment are <b>OR</b>ed — any one group triggers replacement.
          A domain is matched to the first non-default segment that claims one of its tags, otherwise the default (cleaning) segment.
          Blank metrics are never treated as 0.
        </p>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {/* Read-only summary — the config stays static until "Edit groups".
            Filter/sort + company-type column: Nick's 8/4 doc, item 6. */}
        {open && cfg && !editing && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(["all", "cleaning", "non-cleaning"] as const).map((t) => (
                <button key={t} onClick={() => setTypeFilter(t)}
                  className={`rounded-full border px-2.5 py-0.5 ${typeFilter === t ? "bg-foreground text-background font-medium" : "text-muted-foreground"}`}>
                  {t === "all" ? "All types" : t}
                </button>
              ))}
              <input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Filter by name / client tag…"
                className="h-7 w-52 rounded-md border bg-background px-2" />
              <button onClick={() => setSortAZ((v) => !v)}
                className={`rounded-full border px-2.5 py-0.5 ${sortAZ ? "bg-foreground text-background font-medium" : "text-muted-foreground"}`}>
                sort A–Z
              </button>
            </div>
            {visibleSegments(cfg.segments).map((seg) => (
              <div key={seg.id} className="rounded-xl border p-3 bg-muted/20 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{seg.name}</span>
                  <Badge variant="outline" className={segType(seg) === "cleaning" ? "border-sky-500/30 text-sky-500" : "border-zinc-500/40 text-zinc-400"}>
                    {segType(seg)}
                  </Badge>
                  {seg.isDefault ? (
                    <Badge variant="outline" className="border-sky-500/30 text-sky-500">default · cleaning/janitorial</Badge>
                  ) : seg.clientTags.length > 0 ? (
                    <Badge variant="outline">{seg.clientTags.join(", ")}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">no tags</Badge>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => duplicateSegment(seg.id)} className="gap-1 h-6 px-2 text-[11px] text-muted-foreground ml-auto" title="Duplicate this segment (then edit the copy)">
                    <Copy className="h-3 w-3" /> duplicate
                  </Button>
                </div>
                {seg.groups.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">No groups — this segment never triggers a replacement.</div>
                ) : (
                  seg.groups.map((g, gi) => (
                    <div key={g.id} className="text-xs text-muted-foreground">
                      {gi > 0 && <span className="font-semibold mr-1.5 text-[10px]">OR</span>}
                      {/* Numbered so flag reasons can just say "Group N" */}
                      <span className="text-foreground font-medium">Group {gi + 1} · {g.name}:</span>{" "}
                      {g.conditions.map(condText).join("  AND  ")}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        )}

        {open && cfg && editing && (
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
                  <div className="flex items-center gap-1 ml-auto">
                    <Button size="sm" variant="ghost" onClick={() => duplicateSegment(seg.id)} className="gap-1 text-muted-foreground" title="Duplicate this segment">
                      <Copy className="h-3.5 w-3.5" /> duplicate
                    </Button>
                    {!seg.isDefault && (
                      <Button size="sm" variant="ghost" onClick={() => removeSegment(seg.id)} className="text-destructive gap-1">
                        <Trash2 className="h-3.5 w-3.5" /> segment
                      </Button>
                    )}
                  </div>
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
                        <Button size="sm" variant="ghost" onClick={() => duplicateGroup(seg.id, g.id)} className="text-muted-foreground h-7 px-2" title="Duplicate this group">
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
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
              <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving} className="gap-1.5">
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save groups
              </Button>
            </div>
          </div>
        )}
        {savedAt && <span className="text-xs text-emerald-500">Saved</span>}
      </CardContent>
    </Card>
  );
}
