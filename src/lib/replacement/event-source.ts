// Which automation wrote a replacement_events row — derived from the detail
// prefixes the writers already use (no schema change). Shared by the domain
// history API and the live System-activity feed so both label events the
// same way. Safe to import client-side (pure function, no server deps).
export function sourceOf(detail: string | null | undefined, kind?: string | null): string {
  const d = (detail || "").toLowerCase();
  if (d.startsWith("true-up fill")) return "true-up fill";
  if (d.startsWith("true-up trim") || d.startsWith("trimmed")) return "true-up trim";
  if (d.startsWith("cross-instance move")) return "cross-instance move";
  if (d.startsWith("duplicate cleanup")) return "duplicate cleanup";
  if (d.startsWith("burnt-reserve sweep")) return "burnt-reserve sweep";
  if (d.startsWith("warmup graduation")) return "warmup graduation";
  if (d.startsWith("orphan-attach")) return "orphan attach";
  if (d.startsWith("mode changed")) return "settings";
  if (d.startsWith("stripped lingering") || d.startsWith("strip-removed")) return "stale-tag strip";
  if (d.startsWith("conform:")) return "redirect conform";
  if (d.startsWith("wrong-instance")) return "wrong-instance";
  if (d.startsWith("auto-runner")) return "auto-runner";
  if (d.startsWith("deleted from bison")) return "deletion executor";
  if (d.startsWith("dashboard retry")) return "manual retry";
  if (kind === "cancel_queued") return "cancel bridge";
  return "replacement";
}

/** Human verb for an event type, for feeds. */
export function verbOf(kind: string): string {
  switch (kind) {
    case "detected": return "flagged";
    case "proposed": return "started";
    case "tagged": return "tagged";
    case "redirect_set": return "redirect set";
    case "attached": return "attached to campaigns";
    case "removed": return "removed";
    case "cancel_queued": return "queued for deletion";
    case "skipped": return "skipped";
    case "error": return "FAILED";
    case "ramped": return "ramped out of warmup";
    case "mode_changed": return "mode changed";
    default: return kind;
  }
}
