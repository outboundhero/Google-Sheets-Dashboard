"use client";

import { useState } from "react";
import { Plus, X, Filter as FilterIcon, Eraser } from "lucide-react";

// A focused multi-condition filter builder (AND/OR + Clear) reused by the
// Domains tables. Generic over the row type via a field registry.

export type FilterFieldType = "text" | "enum" | "date" | "bool";

export interface FilterField<R> {
  key: string;
  label: string;
  type: FilterFieldType;
  options?: [string, string][]; // enum
  get: (row: R) => string | number | boolean | null; // date → ISO/ms; bool → boolean
}

export interface FilterCondition {
  id: number;
  fieldKey: string;
  op: string;
  value: string;
}

export type FilterMode = "AND" | "OR";

const OPS_BY_TYPE: Record<FilterFieldType, [string, string][]> = {
  text: [["contains", "contains"], ["ncontains", "does not contain"], ["eq", "equals"]],
  enum: [["is", "is"], ["isnot", "is not"]],
  date: [["lt", "before (<)"], ["lte", "on or before (≤)"], ["eq", "on (=)"], ["gte", "on or after (≥)"], ["gt", "after (>)"]],
  bool: [["is", "is"]],
};

function toMs(v: string | number | boolean | null): number | null {
  if (v == null || typeof v === "boolean") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
function dayStart(ms: number): number { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

function evalCondition<R>(row: R, c: FilterCondition, field: FilterField<R>): boolean {
  if (!c.value && field.type !== "bool") return true; // empty value → ignored
  const raw = field.get(row);
  if (field.type === "text") {
    const s = String(raw ?? "").toLowerCase();
    const v = c.value.toLowerCase();
    if (c.op === "contains") return s.includes(v);
    if (c.op === "ncontains") return !s.includes(v);
    if (c.op === "eq") return s === v;
  } else if (field.type === "enum") {
    const s = String(raw ?? "");
    if (c.op === "is") return s === c.value;
    if (c.op === "isnot") return s !== c.value;
  } else if (field.type === "date") {
    const rowMs = toMs(raw);
    const valMs = toMs(c.value);
    if (rowMs == null || valMs == null) return false;
    if (c.op === "eq") return dayStart(rowMs) === dayStart(valMs);
    if (c.op === "lt") return rowMs < valMs;
    if (c.op === "lte") return dayStart(rowMs) <= dayStart(valMs);
    if (c.op === "gt") return rowMs > valMs;
    if (c.op === "gte") return dayStart(rowMs) >= dayStart(valMs);
  } else if (field.type === "bool") {
    return Boolean(raw) === (c.value === "yes");
  }
  return true;
}

/** Apply conditions (combined AND/OR) to rows. */
export function applyFilters<R>(rows: R[], conditions: FilterCondition[], mode: FilterMode, fields: FilterField<R>[]): R[] {
  const active = conditions.filter((c) => c.fieldKey && (c.value || fields.find((f) => f.key === c.fieldKey)?.type === "bool"));
  if (active.length === 0) return rows;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  return rows.filter((row) => {
    const evals = active.map((c) => {
      const f = byKey.get(c.fieldKey);
      return f ? evalCondition(row, c, f) : true;
    });
    return mode === "AND" ? evals.every(Boolean) : evals.some(Boolean);
  });
}

export function DomainFilterBuilder<R>({ fields, conditions, setConditions, mode, setMode }: {
  fields: FilterField<R>[];
  conditions: FilterCondition[];
  setConditions: (c: FilterCondition[]) => void;
  mode: FilterMode;
  setMode: (m: FilterMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = conditions.filter((c) => c.value || fields.find((f) => f.key === c.fieldKey)?.type === "bool").length;

  // Derive the next id from the current rows (rather than a counter) so loading
  // a saved search's conditions can never collide with a freshly-added row.
  const addRow = () => {
    const nextId = conditions.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    setConditions([...conditions, { id: nextId, fieldKey: fields[0].key, op: OPS_BY_TYPE[fields[0].type][0][0], value: fields[0].type === "bool" ? "yes" : "" }]);
  };
  const removeRow = (id: number) => setConditions(conditions.filter((c) => c.id !== id));
  const clearAll = () => setConditions([]);
  const patch = (id: number, p: Partial<FilterCondition>) => setConditions(conditions.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const onFieldChange = (id: number, fieldKey: string) => {
    const f = fields.find((x) => x.key === fieldKey)!;
    patch(id, { fieldKey, op: OPS_BY_TYPE[f.type][0][0], value: f.type === "bool" ? "yes" : "" });
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs font-medium hover:text-foreground">
          <FilterIcon className="h-3.5 w-3.5" /> Filters
          {activeCount > 0 && <span className="rounded-full bg-primary/15 text-primary px-1.5 text-[10px]">{activeCount}</span>}
          <span className="text-[10px] text-muted-foreground">{open ? "hide" : "show"}</span>
        </button>
        {activeCount > 0 && (
          <button onClick={clearAll} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <Eraser className="h-3 w-3" /> Clear filters
          </button>
        )}
      </div>
      {open && (
        <div className="border-t px-3 py-2.5 space-y-2">
          {conditions.length > 1 && (
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Match</span>
              {(["AND", "OR"] as FilterMode[]).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded border px-2 py-0.5 ${mode === m ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/30 hover:bg-muted/50"}`}>
                  {m === "AND" ? "all (AND)" : "any (OR)"}
                </button>
              ))}
            </div>
          )}
          {conditions.map((c) => {
            const f = fields.find((x) => x.key === c.fieldKey) || fields[0];
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-1.5">
                <select value={c.fieldKey} onChange={(e) => onFieldChange(c.id, e.target.value)} className="text-xs rounded border bg-background px-1.5 py-1 outline-none">
                  {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select value={c.op} onChange={(e) => patch(c.id, { op: e.target.value })} className="text-xs rounded border bg-background px-1.5 py-1 outline-none">
                  {OPS_BY_TYPE[f.type].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {f.type === "enum" ? (
                  <select value={c.value} onChange={(e) => patch(c.id, { value: e.target.value })} className="text-xs rounded border bg-background px-1.5 py-1 outline-none min-w-[120px]">
                    <option value="">any…</option>
                    {(f.options || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : f.type === "bool" ? (
                  <select value={c.value} onChange={(e) => patch(c.id, { value: e.target.value })} className="text-xs rounded border bg-background px-1.5 py-1 outline-none">
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                ) : f.type === "date" ? (
                  <input type="date" value={c.value} onChange={(e) => patch(c.id, { value: e.target.value })} className="text-xs rounded border bg-background px-1.5 py-1 outline-none" />
                ) : (
                  <input value={c.value} onChange={(e) => patch(c.id, { value: e.target.value })} placeholder="value" className="text-xs rounded border bg-background px-2 py-1 outline-none min-w-[140px]" />
                )}
                <button onClick={() => removeRow(c.id)} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
              </div>
            );
          })}
          <button onClick={addRow} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
            <Plus className="h-3 w-3" /> Add filter
          </button>
        </div>
      )}
    </div>
  );
}
