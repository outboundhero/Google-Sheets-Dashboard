// Hand off selected domains from the Domains page to the Inbox Orders page in a
// new tab. One domain → the single-create dialog pre-filled; many → the bulk
// dialog seeded via localStorage (URLs can't carry hundreds of domains safely).

export const BULK_PREFILL_KEY = "inbox-orders:bulk-prefill";

export function sendDomainsToInboxOrders(domains: string[]): void {
  const list = Array.from(new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));
  if (list.length === 0) return;
  if (list.length === 1) {
    window.open(`/deliverability/inbox-orders?create=1&domain=${encodeURIComponent(list[0])}`, "_blank", "noopener");
    return;
  }
  try {
    localStorage.setItem(BULK_PREFILL_KEY, JSON.stringify({ domains: list, ts: Date.now() }));
  } catch { /* storage may be unavailable — bulk dialog will just open empty */ }
  window.open("/deliverability/inbox-orders?bulk=1", "_blank", "noopener");
}
