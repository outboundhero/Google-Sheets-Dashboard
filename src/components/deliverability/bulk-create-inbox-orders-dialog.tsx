"use client";

/**
 * Bulk create inbox orders from a CSV paste or file upload.
 *
 * - Provider, Bison instance, optional global tag/redirect URL → picked once at the top.
 * - Per-row CSV columns: `domain, companyName, clientTag`. Header row optional.
 *   Tabs also work as separator so users can copy/paste from Google Sheets/Excel.
 * - Submit fires the existing POST /api/inbox-orders once per row, with concurrency=3
 *   to stay under provider rate limits.
 * - Each row's status is rendered live: pending → running → created / failed.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";
import type { InboxOrderProvider, InboxOrderAlias } from "@/types/inbox-order";

const PROVIDER_MAILBOXES: Record<InboxOrderProvider, number> = {
  scaledmail: 25,
  milkbox: 50,
  inboxing: 49,
};

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i;

// "First Last" → {first_name, last_name}; null if it isn't at least two words.
function splitName(full: string): { first_name: string; last_name: string } | null {
  const parts = (full || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

interface ParsedRow {
  rowNo: number;
  domain: string;
  companyName: string;
  clientTag: string;
  name1: string;
  name2: string;
  errors: string[];
}

interface RowResult {
  domain: string;
  companyName: string;
  clientTag: string;
  status: "pending" | "running" | "created" | "failed";
  error?: string;
  orderId?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onComplete: () => void;
  defaultInstance?: BisonInstanceSlug;
}

const TEMPLATE_HEADER = "domain,companyName,clientTag,name1,name2";
const TEMPLATE_EXAMPLE =
  "domain,companyName,clientTag,name1,name2\ncleaninggrid7.com,Acme Building Services,BHS,Sarah Jones,Maria Lopez\njanitorcareco.info,Acme Building Services,BHS,Emily Carter,Sofia Ramirez";

export function BulkCreateInboxOrdersDialog({
  open,
  onOpenChange,
  onComplete,
  defaultInstance,
}: Props) {
  const [provider, setProvider] = useState<InboxOrderProvider>("milkbox");
  const [bisonInstance, setBisonInstance] = useState<BisonInstanceSlug>(
    defaultInstance ?? "outboundhero",
  );
  const [globalTag, setGlobalTag] = useState("");
  const [redirectUrl, setRedirectUrl] = useState("");
  // Sender names: auto female (default) or from the name1/name2 CSV columns.
  const [autoNames, setAutoNames] = useState(true);
  const [personaCount, setPersonaCount] = useState<1 | 2>(1);
  // Previewed (and editable) names + full per-mailbox aliases per domain,
  // populated by "Preview names". `expanded` = which domain's mailbox list is open.
  const [rowNames, setRowNames] = useState<Record<string, { name1: string; name2: string }>>({});
  const [rowAliases, setRowAliases] = useState<Record<string, InboxOrderAlias[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewingNames, setPreviewingNames] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RowResult[]>([]);
  const [done, setDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Inboxing only: which Porkbun account each domain belongs to (drives the
  // registrar) — resolved from the All Domains inventory.
  const [accountMap, setAccountMap] = useState<Record<string, { accountLabel: string | null; ok: boolean; reason: string | null }>>({});

  // Reset state on close + on (re-)open.
  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setResults([]);
      setDone(false);
      return;
    }
    if (defaultInstance) setBisonInstance(defaultInstance);
  }, [open, defaultInstance]);

  // Previewed names/aliases are tied to the current settings/rows — clear them
  // when any of those change so a stale preview can't be submitted.
  useEffect(() => { setRowNames({}); setRowAliases({}); setExpanded(null); }, [provider, autoNames, personaCount, csvText]);

  // Parse CSV/TSV. First row is treated as header iff it contains the literal
  // word "domain" (case-insensitive). All other lines are data rows.
  const parsed = useMemo<ParsedRow[]>(() => {
    if (!csvText.trim()) return [];
    const lines = csvText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (lines.length === 0) return [];

    const headerLikely = lines[0].toLowerCase().includes("domain");
    const dataLines = headerLikely ? lines.slice(1) : lines;

    return dataLines.map((line, i) => {
      const parts = line.split(/[,\t]/).map((p) => p.trim());
      const [domain = "", companyName = "", clientTag = "", name1 = "", name2 = ""] = parts;
      const normalized = domain.toLowerCase();
      const errors: string[] = [];
      if (!normalized) errors.push("Missing domain");
      else if (!DOMAIN_RE.test(normalized)) errors.push("Invalid domain format");
      if (provider === "milkbox" && !companyName) errors.push("MilkBox requires companyName");
      if (!autoNames) {
        if (!splitName(name1)) errors.push("name1 needs a first + last name");
        if (personaCount === 2 && !splitName(name2)) errors.push("name2 needs a first + last name");
      }
      return {
        rowNo: i + 1 + (headerLikely ? 1 : 0),
        domain: normalized,
        companyName,
        clientTag,
        name1,
        name2,
        errors,
      };
    });
  }, [csvText, provider, autoNames, personaCount]);

  const validRows = useMemo(() => parsed.filter((r) => r.errors.length === 0), [parsed]);
  const invalidCount = parsed.length - validRows.length;

  // Resolve each domain's Porkbun account (Inboxing orders only) so we can flag
  // which registrar it'll use + warn on unknowns before submitting.
  const domainsKey = useMemo(() => validRows.map((r) => r.domain).join(","), [validRows]);
  useEffect(() => {
    if (provider !== "inboxing") { setAccountMap({}); return; }
    const domains = validRows.map((r) => r.domain).filter(Boolean);
    if (domains.length === 0) { setAccountMap({}); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetch("/api/inbox-orders/resolve-accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!alive || d.error || !Array.isArray(d.results)) return;
          const m: Record<string, { accountLabel: string | null; ok: boolean; reason: string | null }> = {};
          for (const x of d.results) m[x.domain] = { accountLabel: x.accountLabel, ok: x.ok, reason: x.reason };
          setAccountMap(m);
        })
        .catch(() => {});
    }, 400);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, domainsKey]);

  const accountSummary = useMemo(() => {
    if (provider !== "inboxing") return null;
    const groups: Record<string, number> = {};
    let unknown = 0;
    for (const r of validRows) {
      const a = accountMap[r.domain];
      if (a && a.ok && a.accountLabel) groups[a.accountLabel] = (groups[a.accountLabel] || 0) + 1;
      else unknown++;
    }
    return { groups, unknown, mixed: Object.keys(groups).length > 1 };
  }, [provider, validRows, accountMap]);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  // Generate (auto) or gather (manual) the sender name(s) for each valid row so
  // they can be reviewed + edited before submitting. Names become editable
  // inline; on submit the exact names shown are used.
  const previewNames = async () => {
    if (validRows.length === 0) return;
    setPreviewingNames(true);
    const nextNames: Record<string, { name1: string; name2: string }> = {};
    const nextAliases: Record<string, InboxOrderAlias[]> = {};
    const rows = [...validRows];
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const r = rows[i++];
        const names = autoNames
          ? undefined
          : [r.name1, ...(personaCount === 2 ? [r.name2] : [])].map(splitName).filter(Boolean);
        try {
          const res = await fetch("/api/inbox-orders/preview-names", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, nameMode: autoNames ? "auto" : "manual", personaCount, names }),
          });
          const json = await res.json();
          if (res.ok && Array.isArray(json.aliases)) {
            nextAliases[r.domain] = json.aliases as InboxOrderAlias[];
            const p = json.personas || [];
            nextNames[r.domain] = {
              name1: p[0] ? `${p[0].first_name} ${p[0].last_name}`.trim() : "",
              name2: p[1] ? `${p[1].first_name} ${p[1].last_name}`.trim() : "",
            };
          }
        } catch { /* leave this row unpreviewed */ }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    setRowNames(nextNames);
    setRowAliases(nextAliases);
    setPreviewingNames(false);
  };

  const editRowAlias = (domain: string, idx: number, field: keyof InboxOrderAlias, value: string) => {
    setRowAliases((p) => ({ ...p, [domain]: (p[domain] || []).map((a, i) => (i === idx ? { ...a, [field]: value } : a)) }));
  };

  const submit = async () => {
    if (validRows.length === 0) return;
    setSubmitting(true);
    setDone(false);

    const initial: RowResult[] = validRows.map((r) => ({
      domain: r.domain,
      companyName: r.companyName,
      clientTag: r.clientTag,
      status: "pending",
    }));
    setResults(initial);

    // Concurrency-3 worker pool.
    const CONCURRENCY = 3;
    const queue: { row: ParsedRow; idx: number }[] = validRows.map((row, idx) => ({ row, idx }));

    async function worker() {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        const { row, idx } = task;

        setResults((prev) =>
          prev.map((r, i) => (i === idx ? { ...r, status: "running" } : r)),
        );

        try {
          // If previewed, send the EXACT (edited) per-mailbox aliases; otherwise
          // auto (generated server-side) or the CSV name columns.
          const previewedAliases = rowAliases[row.domain];
          const manualNames = [row.name1, ...(personaCount === 2 ? [row.name2] : [])].map(splitName).filter(Boolean);
          const res = await fetch("/api/inbox-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider,
              instance: bisonInstance,
              domain: row.domain,
              companyName: row.companyName || undefined,
              clientTag: row.clientTag || undefined,
              tag: globalTag.trim() || undefined,
              redirectUrl: redirectUrl.trim() || undefined,
              ...(previewedAliases && previewedAliases.length
                ? { aliases: previewedAliases }
                : autoNames
                  ? { nameMode: "auto", personaCount }
                  : { nameMode: "manual", personaCount, names: manualNames }),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setResults((prev) =>
            prev.map((r, i) =>
              i === idx
                ? { ...r, status: "created", orderId: data?.order?.id }
                : r,
            ),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed";
          setResults((prev) =>
            prev.map((r, i) => (i === idx ? { ...r, status: "failed", error: msg } : r)),
          );
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    setSubmitting(false);
    setDone(true);
    onComplete();
  };

  const createdCount = results.filter((r) => r.status === "created").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const inFlightCount = results.filter(
    (r) => r.status === "running" || r.status === "pending",
  ).length;

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:!max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Bulk Import Inbox Orders</DialogTitle>
          <DialogDescription>
            Provisions {PROVIDER_MAILBOXES[provider]} mailboxes per domain on{" "}
            <strong>{provider}</strong>. Paste rows below or upload a CSV.
          </DialogDescription>
        </DialogHeader>

        {/* Global settings */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium">Provider</label>
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as InboxOrderProvider)}
              disabled={submitting}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="milkbox">MilkBox (50 mailboxes)</SelectItem>
                <SelectItem value="scaledmail">ScaledMail (25 mailboxes)</SelectItem>
                <SelectItem value="inboxing">Inboxing (49 mailboxes)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Bison instance</label>
            <Select
              value={bisonInstance}
              onValueChange={(v) => setBisonInstance(v as BisonInstanceSlug)}
              disabled={submitting}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.values(BISON_INSTANCES).map((inst) => (
                  <SelectItem key={inst.slug} value={inst.slug}>
                    {inst.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Global tag (optional)</label>
            <Input
              value={globalTag}
              onChange={(e) => setGlobalTag(e.target.value.slice(0, 20))}
              placeholder="campaign-q2"
              maxLength={20}
              disabled={submitting}
            />
          </div>
          <div>
            <label className="text-xs font-medium">Redirect URL (optional)</label>
            <Input
              value={redirectUrl}
              onChange={(e) => setRedirectUrl(e.target.value)}
              placeholder="https://example.com"
              disabled={submitting}
            />
          </div>
        </div>

        {/* Sender names */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border p-2 text-xs">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={autoNames} onChange={(e) => setAutoNames(e.target.checked)} disabled={submitting} />
            Auto-generate female names
          </label>
          {!autoNames && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Number of names:</span>
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={submitting}
                  onClick={() => setPersonaCount(n as 1 | 2)}
                  className={`rounded border px-2 py-0.5 ${personaCount === n ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/30 hover:bg-muted/50"}`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <span className="text-[11px] text-muted-foreground">
            {autoNames
              ? "every mailbox gets its own unique name"
              : personaCount === 2 ? "provide name1 + name2 columns below" : "provide the name1 column below"}
          </span>
        </div>

        {/* CSV input */}
        <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium">
              Rows ({validRows.length} valid
              {invalidCount > 0 ? `, ${invalidCount} invalid` : ""})
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={submitting || previewingNames || validRows.length === 0}
                onClick={previewNames}
                className="h-7 text-xs gap-1"
                title="Generate/collect the sender name(s) for each domain so you can review + edit them"
              >
                {previewingNames ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Preview names
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => setCsvText(TEMPLATE_EXAMPLE)}
                className="h-7 text-xs"
              >
                Insert template
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => fileInputRef.current?.click()}
                className="h-7 text-xs gap-1"
              >
                <Upload className="h-3 w-3" />
                Upload CSV
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={`Paste rows. Header optional. Tab or comma separated.\n\n${TEMPLATE_HEADER}\ncleaninggrid7.com,Acme Building Services,BHS\njanitorcareco.info,Acme Building Services,BHS`}
            disabled={submitting}
            className="w-full min-h-[140px] max-h-[200px] resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-primary disabled:opacity-50"
          />

          {/* Porkbun account flag (Inboxing only) — the registrar is chosen per
              domain from its account, so a mixed batch = separate orders. */}
          {provider === "inboxing" && accountSummary && validRows.length > 0 && (
            <div className="rounded-md border px-3 py-2 text-[11px] flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Porkbun registrar per domain:</span>
              {Object.entries(accountSummary.groups).map(([label, n]) => (
                <span key={label} className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-500">{label}: {n}</span>
              ))}
              {accountSummary.unknown > 0 && (
                <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-500">
                  ⚠ {accountSummary.unknown} unknown — not in All Domains inventory; will fail. Run Refresh Porkbun.
                </span>
              )}
              {accountSummary.mixed && <span className="text-muted-foreground">· created as separate orders per account.</span>}
            </div>
          )}

          {/* Preview (only when not yet submitted) */}
          {parsed.length > 0 && results.length === 0 && (
            <div className="rounded-md border max-h-[340px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">Company</th>
                    <th className="px-2 py-1.5 font-medium">Client tag</th>
                    <th className="px-2 py-1.5 font-medium">Names</th>
                    <th className="px-2 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parsed.map((r) => {
                    const aliases = rowAliases[r.domain];
                    const summary = autoNames
                      ? "unique per mailbox"
                      : rowNames[r.domain]
                        ? [rowNames[r.domain].name1, rowNames[r.domain].name2].filter(Boolean).join(" / ")
                        : "";
                    const isOpen = expanded === r.domain;
                    return (
                      <Fragment key={r.rowNo}>
                        <tr className={r.errors.length ? "bg-red-950/10" : ""}>
                          <td className="px-2 py-1 max-w-[200px]">
                            <div className="truncate">{r.domain || <em className="text-muted-foreground">—</em>}</div>
                            {provider === "inboxing" && r.domain && accountMap[r.domain] && (
                              accountMap[r.domain].ok
                                ? <div className="text-[9px] text-muted-foreground truncate">{accountMap[r.domain].accountLabel}</div>
                                : <div className="text-[9px] text-amber-500 truncate" title={accountMap[r.domain].reason || ""}>⚠ unknown account</div>
                            )}
                          </td>
                          <td className="px-2 py-1 truncate max-w-[180px]">{r.companyName || <em className="text-muted-foreground">—</em>}</td>
                          <td className="px-2 py-1 truncate max-w-[120px]">{r.clientTag || <em className="text-muted-foreground">—</em>}</td>
                          <td className="px-2 py-1 max-w-[220px]">
                            {aliases && aliases.length ? (
                              <button
                                type="button"
                                onClick={() => setExpanded(isOpen ? null : r.domain)}
                                className="flex items-center gap-1 text-left hover:text-foreground"
                                title="Show / edit every mailbox's name + email"
                              >
                                {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                                <span className="truncate">{summary || "names"}</span>
                                <span className="text-[10px] text-muted-foreground shrink-0">· {aliases.length} mailboxes</span>
                              </button>
                            ) : (
                              <span className="text-muted-foreground truncate block">
                                {autoNames
                                  ? <em>(auto — click Preview names)</em>
                                  : ([r.name1, personaCount === 2 ? r.name2 : ""].filter(Boolean).join(" / ") || <em>—</em>)}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1">
                            {r.errors.length === 0 ? (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">ready</Badge>
                            ) : (
                              <span className="text-red-400 text-[10px]">{r.errors.join("; ")}</span>
                            )}
                          </td>
                        </tr>
                        {isOpen && aliases && (
                          <tr>
                            <td colSpan={5} className="px-2 pb-2 bg-muted/20">
                              <div className="max-h-56 overflow-y-auto rounded border divide-y">
                                {aliases.map((a, idx) => (
                                  <div key={idx} className="grid grid-cols-[1fr_1fr_1.7fr] gap-1 px-2 py-1 items-center">
                                    <Input className="h-6 text-[11px]" value={a.first_name} onChange={(e) => editRowAlias(r.domain, idx, "first_name", e.target.value)} />
                                    <Input className="h-6 text-[11px]" value={a.last_name} onChange={(e) => editRowAlias(r.domain, idx, "last_name", e.target.value)} />
                                    <div className="flex items-center gap-1 min-w-0">
                                      <Input className="h-6 text-[11px]" value={a.alias} onChange={(e) => editRowAlias(r.domain, idx, "alias", e.target.value)} />
                                      <span className="text-[10px] text-muted-foreground truncate">@{r.domain}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {provider === "milkbox" && (
                                <p className="mt-1 text-[10px] text-muted-foreground">
                                  MilkBox generates the actual addresses from the names — the email column is informational here.
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Live results during/after submit */}
          {results.length > 0 && (
            <div className="rounded-md border max-h-[260px] overflow-y-auto">
              <div className="sticky top-0 flex items-center justify-between bg-muted/70 px-3 py-1.5 text-xs">
                <span>
                  {createdCount} created · {failedCount} failed
                  {inFlightCount > 0 ? ` · ${inFlightCount} in queue` : ""}
                </span>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              </div>
              <table className="w-full text-xs">
                <tbody className="divide-y">
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1 truncate max-w-[260px]">{r.domain}</td>
                      <td className="px-2 py-1 truncate max-w-[160px] text-muted-foreground">
                        {r.companyName}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[100px] text-muted-foreground">
                        {r.clientTag}
                      </td>
                      <td className="px-2 py-1 w-[160px]">
                        {r.status === "pending" && (
                          <span className="text-muted-foreground">queued</span>
                        )}
                        {r.status === "running" && (
                          <span className="text-primary flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" /> creating…
                          </span>
                        )}
                        {r.status === "created" && (
                          <span className="text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" /> created
                          </span>
                        )}
                        {r.status === "failed" && (
                          <span className="text-red-400 flex items-center gap-1" title={r.error}>
                            <XCircle className="h-3 w-3" />
                            <span className="truncate max-w-[120px]">{r.error || "failed"}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {invalidCount > 0 && !submitting && results.length === 0 && (
          <p className="text-xs text-amber-400 flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            {invalidCount} row{invalidCount !== 1 ? "s" : ""} will be skipped — fix or remove them to include.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {done ? "Close" : "Cancel"}
          </Button>
          <Button
            onClick={submit}
            disabled={
              submitting ||
              done ||
              validRows.length === 0
            }
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Creating {createdCount + failedCount}/{results.length}…
              </>
            ) : (
              `Create ${validRows.length} order${validRows.length !== 1 ? "s" : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
