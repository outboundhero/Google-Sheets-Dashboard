// Shared SURBL / Spamhaus cell badge for the three Domains tables.
// listed === true → red "listed"; false → green "clean"; null/undefined → "—".

export function BlacklistBadge({ listed, checkedAt }: { listed: boolean | null | undefined; checkedAt?: string | null }) {
  const title = checkedAt ? `checked ${new Date(checkedAt).toLocaleString()}` : "not checked yet";
  if (listed === true) {
    return <span title={title} className="inline-flex items-center rounded-md border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600">listed</span>;
  }
  if (listed === false) {
    return <span title={title} className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">clean</span>;
  }
  return <span title={title} className="text-[10px] text-muted-foreground">—</span>;
}
