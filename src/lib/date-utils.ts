const PST_OFFSET_MIN = -8 * 60;

export function pstDateString(d: Date): string {
  const pst = new Date(d.getTime() + (PST_OFFSET_MIN + d.getTimezoneOffset()) * 60000);
  return pst.toISOString().slice(0, 10);
}

export function isPstToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return pstDateString(d) === pstDateString(new Date());
}

export function isPstTodayOrYesterday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const target = pstDateString(d);
  return target === pstDateString(now) || target === pstDateString(yesterday);
}

// TEMP TEST: widened window — matches any date >= 2026-05-05 PST.
// TODO: revert to isPstTodayOrYesterday once UI verified.
const TEST_CUTOFF_PST = "2026-05-05";
export function isPstWithinTestWindow(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return pstDateString(d) >= TEST_CUTOFF_PST;
}
