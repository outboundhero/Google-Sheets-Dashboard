// Redirect audit — compares each assigned domain's redirect against the correct
// client website in the Client Tracker sheet (tab "Client Tracker", col B = client
// abbreviation/tag, col C = Website). Surfaces mismatches for the dashboard so
// Spencer can approve (fix) or disapprove (ignore). Read-only here; the fix is a
// separate approved action.
import { getSheetsClient } from "@/lib/google-sheets";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, type BisonInstanceSlug, type BisonGroup } from "@/lib/bison-instances";
import { getAllocations } from "@/lib/client-tag-allocations";

const CLIENT_TRACKER_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";

// Which instance to DISPLAY for a domain. The Client Tag Allocation sheet is the
// source of truth for the GROUP (1 = OH+CO, 2 = FR+OC). The tier (b2b/b2c) comes
// from where the domain physically sits (a b2b domain is on a b2b instance). So a
// DM4PM domain physically on FacilityReach (group 2) but allocated to group 1
// shows as B2B1·OH — the client's real home — not B2B2·FR. The physical instance
// is still kept internally for the Fix/decision logic. `mismatch` = the domain
// physically sits in a different group than the client is allocated to.
function resolveDisplay(physicalSlug: string, allocGroup: BisonGroup | null): { display: string; mismatch: boolean } {
  const phys = BISON_INSTANCES[physicalSlug as BisonInstanceSlug];
  if (!phys) return { display: physicalSlug, mismatch: false };
  const group = allocGroup ?? phys.group;
  const slug = ALL_INSTANCE_SLUGS.find((s) => BISON_INSTANCES[s].group === group && BISON_INSTANCES[s].tier === phys.tier);
  return { display: slug ?? physicalSlug, mismatch: allocGroup != null && allocGroup !== phys.group };
}

const norm = (u?: string | null) =>
  !u ? "" : String(u).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
const looselyMatches = (a: string, b: string) =>
  !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));

export type RedirectIssueKind = "wrong" | "missing" | "multitag";
export interface RedirectIssue {
  instance: string;        // physical instance (where the domain lives — used for Fix/decisions)
  displayInstance: string; // instance to SHOW (group from allocation sheet + domain's tier)
  mismatch: boolean;       // domain physically sits in a different group than the client is allocated to
  domain: string;
  clientTag: string;       // for multitag, the joined tags
  current: string | null;  // current redirect
  expected: string | null; // correct URL from the tracker (null for multitag)
  kind: RedirectIssueKind;
}

/** Read the Client Tracker: returns the website per tag + the full tag universe. */
export async function readClientTracker(): Promise<{ websites: Map<string, string>; allTags: Set<string> }> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CLIENT_TRACKER_ID,
    range: `'${CLIENT_TRACKER_TAB}'!A2:C`,
  });
  const websites = new Map<string, string>();
  const allTags = new Set<string>();
  for (const row of res.data.values || []) {
    const tag = (row[1] || "").trim().toUpperCase();
    if (!tag) continue;
    allTags.add(tag);
    const site = (row[2] || "").trim();
    if (site) websites.set(tag, site);
  }
  return { websites, allTags };
}

/**
 * clientTag(UPPER) → redirect URL, the way every replacement path must resolve it.
 *
 * Two sources, sheet wins: the Client Tracker "Website" column is the source of
 * truth (Nick 2026-08-22) and `client_redirects` is the fallback for tags the
 * sheet doesn't carry. A sheet read failure changes nothing (fail-open) — we
 * simply serve the table, which is what the old behaviour was.
 *
 * This lives here, shared, because plan.ts and true-up.ts each had their own
 * copy and they drifted: plan.ts was fixed to read the sheet, true-up.ts was
 * not. 17 FacilityReach clients have no `client_redirects` row but a perfectly
 * good website in the tracker, so the fill blocked them with "no redirect URL
 * for tag" — refusing to allocate out of 267 usable reserve domains while 6
 * clients sat short (2026-08-29). One implementation, one behaviour.
 */
export async function loadRedirectsByTag(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const byTag = new Map<string, string>();

  const { data: redirectRows } = await supabase.from("client_redirects").select("client_tag,redirect_url");
  for (const row of (redirectRows || []) as { client_tag: string; redirect_url: string }[]) {
    if (row.client_tag) byTag.set(row.client_tag.toUpperCase(), row.redirect_url);
  }

  try {
    const { websites } = await readClientTracker();
    for (const [tag, site] of websites) {
      const s = site.trim();
      // Skip junk cells: blanks, anything with whitespace (a note, not a URL),
      // and anything without a dot (not a hostname).
      if (!s || /\s/.test(s) || !s.includes(".")) continue;
      byTag.set(tag.toUpperCase(), /^https?:\/\//i.test(s) ? s : `https://${s}`);
    }
  } catch (e) {
    console.error("[redirects] tracker website read failed; using client_redirects only:", e);
  }

  return byTag;
}

interface DomRow { instance: string; domain: string; tags: string[] | null; redirect_url: string | null }

export interface RedirectAuditResult {
  wrong: RedirectIssue[];
  missing: RedirectIssue[];
  multiTag: RedirectIssue[];
  okCount: number;
  scanned: number;
}

export async function auditRedirects(): Promise<RedirectAuditResult> {
  const supabase = getSupabaseAdmin();
  const { websites, allTags } = await readClientTracker();
  // Allocation sheet = source of truth for the client tag's group.
  const { map: allocMap } = await getAllocations();

  // already-decided (fixed/ignored) domains — exclude so they don't re-appear
  const decided = new Set<string>();
  {
    let off = 0;
    while (true) {
      const { data } = await supabase.from("redirect_audit_decisions").select("instance,domain").range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const d of data) decided.add(`${d.instance}:${d.domain}`);
      if (data.length < 1000) break;
      off += 1000;
    }
  }

  // all domains
  const domains: DomRow[] = [];
  let off = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deliverability_domains")
      .select("instance,domain,tags,redirect_url")
      .in("instance", ALL_INSTANCE_SLUGS)
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    domains.push(...(data as DomRow[]));
    if (data.length < 1000) break;
    off += 1000;
  }

  const wrong: RedirectIssue[] = [], missing: RedirectIssue[] = [], multiTag: RedirectIssue[] = [];
  let okCount = 0, scanned = 0;

  for (const dm of domains) {
    if (decided.has(`${dm.instance}:${dm.domain}`)) continue;
    let tags = dm.tags;
    if (typeof tags === "string") { try { tags = JSON.parse(tags); } catch { tags = []; } }
    const ctags = (tags || []).map((t) => String(t).trim().toUpperCase()).filter((t) => allTags.has(t));
    if (ctags.length === 0) continue;          // reserve / unassigned — skip
    scanned++;

    if (ctags.length > 1) {
      // Multiple client tags → can't pick one allocation; show physical instance.
      const { display } = resolveDisplay(dm.instance, null);
      multiTag.push({ instance: dm.instance, displayInstance: display, mismatch: false, domain: dm.domain, clientTag: ctags.join(", "), current: dm.redirect_url, expected: null, kind: "multitag" });
      continue;
    }
    const tag = ctags[0];
    const { display, mismatch } = resolveDisplay(dm.instance, allocMap[tag] ?? null);
    const expected = websites.get(tag);
    if (!expected) continue;                   // no website on file — can't judge/fix
    const current = dm.redirect_url;
    if (!current) {
      missing.push({ instance: dm.instance, displayInstance: display, mismatch, domain: dm.domain, clientTag: tag, current: null, expected, kind: "missing" });
      continue;
    }
    if (looselyMatches(norm(current), norm(expected))) { okCount++; continue; }
    wrong.push({ instance: dm.instance, displayInstance: display, mismatch, domain: dm.domain, clientTag: tag, current, expected, kind: "wrong" });
  }

  const sortFn = (a: RedirectIssue, b: RedirectIssue) => a.clientTag.localeCompare(b.clientTag) || a.domain.localeCompare(b.domain);
  wrong.sort(sortFn); missing.sort(sortFn); multiTag.sort(sortFn);
  return { wrong, missing, multiTag, okCount, scanned };
}

/** Record an approve(fix)/disapprove(ignore) decision so the domain drops off. */
export async function recordRedirectDecision(entries: { instance: string; domain: string; decision: "fixed" | "ignored"; expectedUrl?: string | null }[]): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("redirect_audit_decisions").upsert(
    entries.map((e) => ({ instance: e.instance, domain: e.domain, decision: e.decision, expected_url: e.expectedUrl ?? null, decided_at: new Date().toISOString() })),
    { onConflict: "instance,domain" },
  );
  if (error) throw new Error(error.message);
}
