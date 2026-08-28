import { bisonGetWithRetry } from "@/lib/attach-campaigns";
import type { BisonInstanceSlug } from "@/lib/bison-instances";

// Exact count of sender inboxes ATTACHED to a campaign, matching what Bison shows.
//
// Why not meta.total: GET /campaigns/{id}/sender-emails?per_page=1 returns a
// meta.total that UNDER-reports for some campaigns (observed 245 where Bison had
// 994 attached) — it reflects a subset, not the full attached set. The rest of
// the codebase enumerates a campaign's real attached senders by cursor-walking
// every page (see fetchCampaignSenderEmails), so we count the same way. per_page
// is set large to keep the walk to a few requests even for big campaigns.
//
// Returns null on failure so callers keep the previously-stored value rather than
// overwriting it with a wrong number.

const PER_PAGE = 200;
const MAX_PAGES = 200; // safety cap (~40k senders) against a runaway cursor

export async function countCampaignSenders(instance: BisonInstanceSlug, campaignId: number): Promise<number | null> {
  let total = 0;
  let cursor: string | null = null;
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const qs = cursor
        ? `pagination_type=cursor&per_page=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}`
        : `pagination_type=cursor&per_page=${PER_PAGE}`;
      const res = await bisonGetWithRetry(instance, `/campaigns/${campaignId}/sender-emails?${qs}`);
      const json = await res.json().catch(() => null);
      const data = Array.isArray(json?.data) ? json.data : [];
      total += data.length;
      const next = (json?.meta?.next_cursor as string | null) ?? null;
      if (!next || data.length === 0) break;
      cursor = next;
    }
    return total;
  } catch {
    return null;
  }
}
