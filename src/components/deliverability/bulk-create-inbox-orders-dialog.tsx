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
import { useEffect, useMemo, useRef, useState } from "react";
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
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";
import type { InboxOrderProvider } from "@/types/inbox-order";

const PROVIDER_MAILBOXES: Record<InboxOrderProvider, number> = {
  scaledmail: 25,
  milkbox: 50,
  inboxing: 49,
};

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i;

interface ParsedRow {
  rowNo: number;
  domain: string;
  companyName: string;
  clientTag: string;
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

const TEMPLATE_HEADER = "domain,companyName,clientTag";
const TEMPLATE_EXAMPLE =
  "domain,companyName,clientTag\ncleaninggrid7.com,Acme Building Services,BHS\njanitorcareco.info,Acme Building Services,BHS";

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
  const [csvText, setCsvText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RowResult[]>([]);
  const [done, setDone] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const [domain = "", companyName = "", clientTag = ""] = parts;
      const normalized = domain.toLowerCase();
      const errors: string[] = [];
      if (!normalized) errors.push("Missing domain");
      else if (!DOMAIN_RE.test(normalized)) errors.push("Invalid domain format");
      if (provider === "milkbox" && !companyName) errors.push("MilkBox requires companyName");
      return {
        rowNo: i + 1 + (headerLikely ? 1 : 0),
        domain: normalized,
        companyName,
        clientTag,
        errors,
      };
    });
  }, [csvText, provider]);

  const validRows = useMemo(() => parsed.filter((r) => r.errors.length === 0), [parsed]);
  const invalidCount = parsed.length - validRows.length;

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
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

        {/* CSV input */}
        <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium">
              Rows ({validRows.length} valid
              {invalidCount > 0 ? `, ${invalidCount} invalid` : ""})
            </label>
            <div className="flex items-center gap-2">
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

          {/* Preview (only when not yet submitted) */}
          {parsed.length > 0 && results.length === 0 && (
            <div className="rounded-md border max-h-[180px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">Company</th>
                    <th className="px-2 py-1.5 font-medium">Client tag</th>
                    <th className="px-2 py-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parsed.map((r) => (
                    <tr key={r.rowNo} className={r.errors.length ? "bg-red-950/10" : ""}>
                      <td className="px-2 py-1 truncate max-w-[200px]">{r.domain || <em className="text-muted-foreground">—</em>}</td>
                      <td className="px-2 py-1 truncate max-w-[180px]">{r.companyName || <em className="text-muted-foreground">—</em>}</td>
                      <td className="px-2 py-1 truncate max-w-[120px]">{r.clientTag || <em className="text-muted-foreground">—</em>}</td>
                      <td className="px-2 py-1">
                        {r.errors.length === 0 ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">ready</Badge>
                        ) : (
                          <span className="text-red-400 text-[10px]">{r.errors.join("; ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
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
