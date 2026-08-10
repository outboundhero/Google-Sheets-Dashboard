// US / Canada timezones for the bulk schedule editor. Campaigns on any other
// timezone are "locked" by default (shown, not auto-changed) per §24. Arizona
// (America/Phoenix, no DST) is offered as a normal option — no special rule.

export const US_CA_TIMEZONES: [string, string][] = [
  ["America/Los_Angeles", "Pacific"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona (no DST)"],
  ["America/Chicago", "Central"],
  ["America/New_York", "Eastern"],
  ["America/Halifax", "Atlantic"],
  ["America/St_Johns", "Newfoundland"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
];

const US_CA_SET = new Set(US_CA_TIMEZONES.map(([v]) => v));

export function isUsCaTimezone(tz: string | null | undefined): boolean {
  return !!tz && US_CA_SET.has(tz);
}

export function timezoneLabel(tz: string | null | undefined): string {
  if (!tz) return "";
  const found = US_CA_TIMEZONES.find(([v]) => v === tz);
  return found ? found[1] : tz.split("/").pop()!.replace(/_/g, " ");
}
