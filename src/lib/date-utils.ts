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
