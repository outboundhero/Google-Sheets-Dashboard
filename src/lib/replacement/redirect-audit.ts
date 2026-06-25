// Redirect audit — compares each assigned domain's redirect against the correct
// client website in the Client Tracker sheet (tab "Client Tracker", col B = client
// abbreviation/tag, col C = Website). Surfaces mismatches for the dashboard so
// Spencer can approve (fix) or disapprove (ignore). Read-only here; the fix is a
// separate approved action.
import { getSheetsClient } from "@/lib/google-sheets";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ALL_INSTANCE_SLUGS } from "@/lib/bison-instances";

const CLIENT_TRACKER_ID = "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const CLIENT_TRACKER_TAB = "Client Tracker";

const norm = (u?: string | null) =>
  !u ? "" : String(u).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
const looselyMatches = (a: string, b: string) =>
  !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));

export type RedirectIssueKind = "wrong" | "missing" | "multitag";
export interface RedirectIssue {
  instance: string;
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
      multiTag.push({ instance: dm.instance, domain: dm.domain, clientTag: ctags.join(", "), current: dm.redirect_url, expected: null, kind: "multitag" });
      continue;
    }
    const tag = ctags[0];
    const expected = websites.get(tag);
    if (!expected) continue;                   // no website on file — can't judge/fix
    const current = dm.redirect_url;
    if (!current) {
      missing.push({ instance: dm.instance, domain: dm.domain, clientTag: tag, current: null, expected, kind: "missing" });
      continue;
    }
    if (looselyMatches(norm(current), norm(expected))) { okCount++; continue; }
    wrong.push({ instance: dm.instance, domain: dm.domain, clientTag: tag, current, expected, kind: "wrong" });
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
