"use client";

/**
 * Bulk domain delete — deletes the selected domains' inboxes from the CHECKED
 * Bison instance(s) (a domain can live on several; the picker defaults to all
 * the domains occupy) and from LeadSync. One domain per request
 * (Vercel-timeout-safe), sequential.
 *
 * Result view breaks failures down BY REASON (grouped HTTP status/error) with
 * an expandable per-inbox list, offers "Retry failed" (re-runs only the
 * domains that still have rows — deleted rows are already gone from LeadSync
 * so retries are naturally incremental), and a last-resort "Remove from
 * LeadSync anyway" purge for inboxes Bison persistently can't identify or
 * refuses to delete.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, Trash2, Copy } from "lucide-react";
import { INSTANCE_SHORT_LABELS, BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";

interface DomainInfo {
  domain: string;
  inbox_count: number;
}

interface Failure {
  id: number;
  email: string;
  domain: string;
  instance: string;
  status: number | null;
  error: string;
}

interface DeleteResult {
  inboxesDeleted: number;
  notFound: number;
  domainsDeleted: number;
  failed: number;
  failures: Failure[];
  purged?: { inboxRows: number; domainRows: number };
}

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDomains: DomainInfo[];
  /** Instances the selected domains occupy — the picker options. */
  availableInstances: BisonInstanceSlug[];
  /** Pre-checked instances (defaults to all of availableInstances). */
  defaultInstances: BisonInstanceSlug[];
  onSuccess: () => void;
}

/** Human label for a failure reason group. */
function reasonLabel(f: Failure): string {
  if (f.status === 429) return "HTTP 429 — rate limited by Bison";
  if (f.status && f.status >= 500) return `HTTP ${f.status} — Bison server error`;
  if (f.status) return `HTTP ${f.status} — ${f.error || "rejected"}`;
  return f.error || "network error";
}

export function BulkDeleteDialog({
  open,
  onOpenChange,
  selectedDomains,
  availableInstances,
  defaultInstances,
  onSuccess,
}: BulkDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);
  const [showFailureList, setShowFailureList] = useState(false);
  const [emailsCopied, setEmailsCopied] = useState(false);
  // Which instances to delete from. Re-seeded from defaultInstances each time
  // the dialog opens (the page reuses one dialog for both the bulk-bar delete
  // and the post-move "remove from source" follow-up, which scope differently).
  const [picked, setPicked] = useState<Set<string>>(new Set(defaultInstances));
  useEffect(() => {
    if (open) { setPicked(new Set(defaultInstances)); setResult(null); setError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const instancesQuery = useMemo(() => `instances=${[...picked].join(",")}`, [picked]);
  const singleInstance = availableInstances.length <= 1;

  const runDelete = async (domains: DomainInfo[]) => {
    setDeleting(true);
    setError(null);
    setShowFailureList(false);
    let totalDeleted = 0;
    let totalNotFound = 0;
    let totalFailed = 0;
    let domainsDeleted = 0;
    const failures: Failure[] = [];

    try {
      // One domain per request — avoids Vercel timeouts even with retries.
      for (let i = 0; i < domains.length; i++) {
        const d = domains[i];
        setProgress(
          `Deleting ${d.domain} (${i + 1}/${domains.length}) · ${totalDeleted.toLocaleString()} deleted${totalFailed ? ` · ${totalFailed.toLocaleString()} failed so far` : ""}`,
        );
        try {
          const res = await fetch(`/api/deliverability/bulk-delete?${instancesQuery}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: [d.domain] }),
          });
          // JSON-safe: a serverless timeout returns an HTML page.
          const text = await res.text();
          let data: {
            inboxesDeleted?: number; notFound?: number; failed?: number;
            domainsDeleted?: number; failures?: Failure[]; error?: string;
          } | null = null;
          try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          if (data && res.ok && !data.error) {
            totalDeleted += data.inboxesDeleted || 0;
            totalNotFound += data.notFound || 0;
            totalFailed += data.failed || 0;
            domainsDeleted += data.domainsDeleted || 0;
            failures.push(...(data.failures || []));
          } else {
            const why = !data
              ? (res.status >= 500 ? "server timed out or crashed" : `non-JSON response (HTTP ${res.status})`)
              : (data.error || `HTTP ${res.status}`);
            totalFailed += d.inbox_count;
            failures.push({ id: 0, email: `all inboxes on ${d.domain}`, domain: d.domain, instance: "", status: res.status, error: why });
          }
        } catch (e) {
          totalFailed += d.inbox_count;
          failures.push({ id: 0, email: `all inboxes on ${d.domain}`, domain: d.domain, instance: "", status: null, error: e instanceof Error ? e.message : "network error" });
        }
      }
      setResult({ inboxesDeleted: totalDeleted, notFound: totalNotFound, domainsDeleted, failed: totalFailed, failures });
      onSuccess();
    } finally {
      setDeleting(false);
      setProgress("");
    }
  };

  // Domains that still have failing inboxes — Retry targets only these
  // (successfully deleted rows are already gone from LeadSync).
  const failedDomains = useMemo(() => {
    if (!result) return [];
    const byDomain = new Map<string, number>();
    for (const f of result.failures) byDomain.set(f.domain, (byDomain.get(f.domain) || 0) + 1);
    return [...byDomain.entries()].map(([domain, count]) => ({ domain, inbox_count: count }));
  }, [result]);

  // Failure reasons grouped for the at-a-glance breakdown.
  const reasonGroups = useMemo(() => {
    if (!result) return [];
    const groups = new Map<string, number>();
    for (const f of result.failures) groups.set(reasonLabel(f), (groups.get(reasonLabel(f)) || 0) + 1);
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }, [result]);

  // Last resort: drop the failing domains' rows from LeadSync without
  // touching Bison ("ignore it from LeadSync").
  const purgeFailed = async () => {
    if (failedDomains.length === 0) return;
    setPurging(true);
    setError(null);
    try {
      const res = await fetch(`/api/deliverability/bulk-delete?${instancesQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "purge", domains: failedDomains.map((d) => d.domain) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setResult((prev) => prev ? { ...prev, failed: 0, failures: [], purged: { inboxRows: data.inboxRows, domainRows: data.domainRows } } : prev);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purge failed");
    } finally {
      setPurging(false);
    }
  };

  const handleClose = () => {
    if (deleting || purging) return;
    setResult(null);
    setError(null);
    setShowFailureList(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Delete Domains
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="py-2 space-y-3 overflow-y-auto">
            <div className="text-center space-y-1">
              <div className={`font-medium ${result.failed > 0 ? "text-amber-500" : "text-emerald-500"}`}>
                {result.failed > 0 ? "Partially deleted" : "Deleted successfully"}
              </div>
              <div className="text-sm text-muted-foreground">
                {result.inboxesDeleted.toLocaleString()} inbox{result.inboxesDeleted !== 1 ? "es" : ""} deleted
                {result.notFound > 0 && <> · {result.notFound.toLocaleString()} already gone in Bison (removed from LeadSync)</>}
                {" · "}{result.domainsDeleted} domain{result.domainsDeleted !== 1 ? "s" : ""} removed
              </div>
              {result.purged && (
                <div className="text-xs text-amber-500">
                  {result.purged.inboxRows.toLocaleString()} inbox rows + {result.purged.domainRows} domain rows force-removed from LeadSync (Bison accounts may still exist)
                </div>
              )}
            </div>

            {result.failed > 0 && (
              <>
                {/* Why did it fail — grouped reasons */}
                <div className="rounded-lg border border-destructive/30 bg-destructive/5">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-destructive/20">
                    <span className="text-xs font-medium text-destructive">
                      {result.failed.toLocaleString()} inbox{result.failed !== 1 ? "es" : ""} failed to delete — still in Bison + LeadSync
                    </span>
                    <button
                      onClick={() => setShowFailureList((v) => !v)}
                      className="text-[11px] text-primary hover:underline shrink-0 ml-2"
                    >
                      {showFailureList ? "hide list" : "view list"}
                    </button>
                  </div>
                  <div className="px-3 py-1.5 space-y-0.5">
                    {reasonGroups.map(([reason, count]) => (
                      <div key={reason} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-destructive/90 truncate">{reason}</span>
                        <span className="text-muted-foreground shrink-0">× {count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  {showFailureList && (
                    <div className="border-t border-destructive/20">
                      <div className="flex justify-end px-3 py-1">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(result.failures.map((f) => f.email).join("\n"));
                            setEmailsCopied(true);
                            setTimeout(() => setEmailsCopied(false), 2000);
                          }}
                          className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Copy className="h-3 w-3" /> {emailsCopied ? "Copied!" : "Copy emails"}
                        </button>
                      </div>
                      <div className="max-h-48 overflow-y-auto divide-y divide-destructive/10">
                        {result.failures.slice(0, 200).map((f, i) => (
                          <div key={`${f.id}-${i}`} className="px-3 py-1">
                            <div className="text-[11px] font-mono text-foreground/80 truncate">{f.email}</div>
                            <div className="text-[10px] text-muted-foreground/70 truncate">
                              {f.domain}{f.instance ? ` · ${f.instance}` : ""} · {reasonLabel(f)}
                            </div>
                          </div>
                        ))}
                        {result.failures.length > 200 && (
                          <div className="px-3 py-1 text-[11px] text-muted-foreground">…and {(result.failures.length - 200).toLocaleString()} more</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {error && <div className="text-xs text-destructive">{error}</div>}

                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deleting || purging}
                    onClick={() => runDelete(failedDomains)}
                  >
                    {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                    Retry {result.failed.toLocaleString()} failed
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deleting || purging}
                    onClick={purgeFailed}
                    title="Removes the failing rows from LeadSync WITHOUT deleting them in Bison — the accounts may still exist there"
                  >
                    {purging && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                    Remove from LeadSync anyway
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground text-center">
                  &quot;Remove from LeadSync anyway&quot; only clears the dashboard — the accounts may still exist in Bison.
                </p>
              </>
            )}

            {progress && <div className="text-xs text-muted-foreground text-center">{progress}</div>}

            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={handleClose} disabled={deleting || purging}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Instance picker — a domain can live on multiple instances; only
                the checked ones are deleted from. */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Delete from instance{singleInstance ? "" : "s"}</div>
              {singleInstance ? (
                <div className="text-xs text-muted-foreground">
                  {availableInstances[0]
                    ? `${INSTANCE_SHORT_LABELS[availableInstances[0]]} — ${BISON_INSTANCES[availableInstances[0]].label}`
                    : "—"}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {availableInstances.map((slug) => {
                    const on = picked.has(slug);
                    return (
                      <button
                        key={slug}
                        onClick={() => setPicked((prev) => {
                          const n = new Set(prev);
                          if (n.has(slug)) n.delete(slug); else n.add(slug);
                          return n;
                        })}
                        className={`text-xs rounded-full border px-2.5 py-1 transition-colors ${
                          on ? "border-destructive/50 bg-destructive/10 text-foreground" : "border-muted-foreground/25 text-muted-foreground"
                        }`}
                        title={BISON_INSTANCES[slug].label}
                      >
                        {on ? "✓ " : ""}{INSTANCE_SHORT_LABELS[slug]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-sm">
                This permanently deletes the inboxes on{" "}
                <span className="font-semibold">
                  {[...picked].map((s) => INSTANCE_SHORT_LABELS[s as BisonInstanceSlug] ?? s).join(", ") || "—"}
                </span>{" "}
                for{" "}
                <span className="font-semibold">
                  {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""}
                </span>{" "}
                from EmailBison and removes them from LeadSync. Copies on other instances stay put. This cannot be undone.
              </div>
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border divide-y">
              {selectedDomains.map((d) => (
                <div key={d.domain} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="truncate">{d.domain}</span>
                  <span className="text-muted-foreground text-xs shrink-0 ml-2">
                    {d.inbox_count} inbox{d.inbox_count !== 1 ? "es" : ""}
                  </span>
                </div>
              ))}
            </div>

            {progress && <div className="text-xs text-muted-foreground">{progress}</div>}
            {error && <div className="text-xs text-destructive">{error}</div>}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={handleClose} disabled={deleting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting || picked.size === 0}
                onClick={() => runDelete(selectedDomains)}
                title={picked.size === 0 ? "Pick at least one instance to delete from" : undefined}
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                Delete {selectedDomains.length} Domain{selectedDomains.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
