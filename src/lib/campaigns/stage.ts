// Derive a campaign's stage + set-role from its Bison name. Names look like
// "DBSNJ: SEGs [Nurture 3] (Cleaning Client)" or "SC: Google + Custom (Non-Cleaning Client)".
// Stage is auto-derived but manually correctable (stage_override on the row).

export type CampaignStage = string; // "Main" | "Nurture 1" | "Nurture 2" | ...
export type SetRole = "google_custom" | "outlook" | "segs" | null;

/** "[Nurture 3]" → "Nurture 3"; "[Nurture]" → "Nurture 1"; none → "Main". */
export function deriveStage(name: string): CampaignStage {
  const m = /\[\s*nurture\s*(\d+)?\s*\]/i.exec(name || "");
  if (m) return m[1] ? `Nurture ${m[1]}` : "Nurture 1";
  return "Main";
}

/** Which campaign in the standard 3-set: Google + Custom, Outlook, SEGs. */
export function deriveSetRole(name: string): SetRole {
  const n = (name || "").toLowerCase();
  if (/\bsegs?\b/.test(n)) return "segs";
  if (/outlook/.test(n)) return "outlook";
  if (/g(oogle|mail)\s*\+?\s*custom|\bgoogle\b|\bgmail\b/.test(n)) return "google_custom";
  return null;
}

/** Best-effort classification embedded in the name, e.g. "(Cleaning Client)".
 *  The Client Tracker sheet is the source of truth; this is only a fallback. */
export function classificationFromName(name: string): string | null {
  const m = /\(([^)]*client[^)]*)\)/i.exec(name || "");
  if (!m) return null;
  const inside = m[1].toLowerCase();
  if (inside.includes("non-cleaning") || inside.includes("non cleaning")) return "Non-cleaning";
  if (inside.includes("cleaning")) return "Cleaning";
  if (inside.includes("internal")) return "Internal";
  if (inside.includes("os")) return "OS";
  return null;
}

/** Numeric sort key for stages: Main=0, Nurture N=N. */
export function stageOrder(stage: string): number {
  if (/^main$/i.test(stage)) return 0;
  const m = /nurture\s*(\d+)/i.exec(stage);
  return m ? Number(m[1]) : 99;
}
