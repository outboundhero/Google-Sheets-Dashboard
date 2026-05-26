"use client";

/**
 * Conform Tags dialog.
 *
 * LeadSync's deliverability_domains.tags is the source of truth for what tags
 * a domain "should" have (it's the rolled-up union of every sender's tags at
 * last sync). This dialog scans every sender in the currently-selected
 * instances, finds ones missing tags that their domain has in LeadSync, and
 * pushes the missing tags down to those senders via Bison.
 *
 * Two-phase: a dry-run first to preview what would change, then an apply
 * step that actually hits Bison's /tags/attach-to-sender-emails.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  Tags,
  XCircle,
} from "lucide-react";
import { BISON_INSTANCES, isInstanceSlug, type BisonInstanceSlug } from "@/lib/bison-instances";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PerInstance {
  instance: BisonInstanceSlug;
  domainsScanned?: number;
  domainsAffected: number;
  sendersAffected: number;
  attachmentsPlanned: number;
}

interface PlanRow {
  instance: BisonInstanceSlug;
  domain: string;
  sender_email: string | null;
  sender_id: number;
  missing_tags: string[];
}

interface PlanResponse {
  dryRun: true;
  live?: boolean;
  totals: { domainsScanned?: number; domainsAffected: number; sendersAffected: number; attachmentsPlanned: number };
  perInstance: PerInstance[];
  sample: PlanRow[];
}

interface AppliedSender {
  instance: BisonInstanceSlug;
  sender_id: number;
  sender_email: string | null;
  domain: string;
  applied_tags: string[];
}

interface ApplyResponse {
  dryRun: false;
  batchId?: string;
  applied: number;
  failed: number;
  failures: { instance: string; tag: string; reason: string }[];
  perInstance: PerInstance[];
  appliedSenders?: AppliedSender[];
}

type Phase = "planning" | "review" | "applying" | "done" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instancesQuery: string;
  onComplete: () => void;
}

export function ConformTagsDialog({ open, onOpenChange, instancesQuery, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "all" = every instance in the current group; otherwise a single Bison slug.
  const [selectedSlug, setSelectedSlug] = useState<"all" | BisonInstanceSlug>("all");

  // Parse the slugs available in the current group from the parent's instancesQuery
  // ("instances=outboundhero,cleaningoutbound" → ["outboundhero", "cleaningoutbound"]).
  const availableSlugs = useMemo<BisonInstanceSlug[]>(() => {
    const m = instancesQuery.match(/instances=([^&]+)/);
    if (!m) return [];
    return m[1].split(",").filter(isInstanceSlug);
  }, [instancesQuery]);

  // Effective query to send to the API — narrowed to one instance if the user picked one.
  const effectiveQuery = useMemo(() => {
    if (selectedSlug === "all") return instancesQuery;
    return `instances=${selectedSlug}`;
  }, [selectedSlug, instancesQuery]);

  const loadPlan = async (q: string) => {
    setPhase("planning");
    setError(null);
    setPlan(null);
    setResult(null);
    try {
      const res = await fetch(`/api/deliverability/conform-tags?${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, skipDisconnected: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPlan(data as PlanResponse);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPhase("error");
    }
  };

  // Reset to "all" when the dialog opens, then auto-scan with whatever the
  // effective query is.
  useEffect(() => {
    if (open) setSelectedSlug("all");
  }, [open]);

  useEffect(() => {
    if (open) loadPlan(effectiveQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, effectiveQuery]);

  const apply = async () => {
    setPhase("applying");
    setError(null);
    try {
      const res = await fetch(`/api/deliverability/conform-tags?${effectiveQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, skipDisconnected: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data as ApplyResponse);
      setPhase("done");
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setPhase("error");
    }
  };

  const groupedSample = useMemo(() => {
    if (!plan) return [] as { key: string; domain: string; instance: BisonInstanceSlug; senders: PlanRow[] }[];
    const m = new Map<string, { key: string; domain: string; instance: BisonInstanceSlug; senders: PlanRow[] }>();
    for (const row of plan.sample) {
      const key = `${row.instance}::${row.domain}`;
      let g = m.get(key);
      if (!g) { g = { key, domain: row.domain, instance: row.instance, senders: [] }; m.set(key, g); }
      g.senders.push(row);
    }
    return [...m.values()];
  }, [plan]);

  return (
    <Dialog open={open} onOpenChange={(v) => phase !== "applying" && onOpenChange(v)}>
      <DialogContent className="sm:!max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tags className="h-4 w-4" />
            Conform Tags
          </DialogTitle>
          <DialogDescription>
            Push each domain&apos;s tags down to every sender on that domain.
            LeadSync&apos;s domain tags are the source of truth. The scan queries
            Bison live for each domain&apos;s current senders, so deleted /
            disconnected senders that linger in the LeadSync cache are skipped.
          </DialogDescription>
        </DialogHeader>

        {/* Instance scope — lets the user run one Bison at a time first */}
        {availableSlugs.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium shrink-0">Scope</label>
            <Select
              value={selectedSlug}
              onValueChange={(v) => setSelectedSlug(v as "all" | BisonInstanceSlug)}
              disabled={phase === "applying" || phase === "planning"}
            >
              <SelectTrigger className="text-xs h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All in current group ({availableSlugs.length} instances)</SelectItem>
                {availableSlugs.map((slug) => (
                  <SelectItem key={slug} value={slug}>
                    Only {BISON_INSTANCES[slug]?.label ?? slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {phase === "planning" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Scanning Bison live for missing tags…</span>
            <span className="text-xs text-muted-foreground/70">
              {selectedSlug === "all"
                ? "One lookup per tagged domain across all selected Bisons in parallel."
                : `One lookup per tagged domain on ${BISON_INSTANCES[selectedSlug]?.label ?? selectedSlug}.`}
              {" "}May take 30–60s.
            </span>
          </div>
        )}

        {phase === "review" && plan && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Senders to update" value={plan.totals.sendersAffected} />
              <StatCard label="Domains affected" value={plan.totals.domainsAffected} />
              <StatCard label="Tag attachments" value={plan.totals.attachmentsPlanned} />
            </div>

            {plan.totals.sendersAffected === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                All senders are already tag-consistent with their domains. Nothing to do.
              </div>
            ) : (
              <>
                <div className="rounded-md border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="px-2 py-1.5 font-medium">Instance</th>
                        <th className="px-2 py-1.5 font-medium text-right">Domains</th>
                        <th className="px-2 py-1.5 font-medium text-right">Senders</th>
                        <th className="px-2 py-1.5 font-medium text-right">Attachments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {plan.perInstance.map((p) => (
                        <tr key={p.instance}>
                          <td className="px-2 py-1.5">{BISON_INSTANCES[p.instance]?.label ?? p.instance}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{p.domainsAffected}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{p.sendersAffected}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{p.attachmentsPlanned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Preview (first {plan.sample.length} of {plan.totals.sendersAffected} senders)
                  </p>
                </div>
                <div className="rounded-md border flex-1 overflow-y-auto max-h-[260px]">
                  <div className="divide-y">
                    {groupedSample.map((g) => (
                      <div key={g.key} className="px-3 py-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium truncate">{g.domain}</span>
                          <span className="text-muted-foreground">{BISON_INSTANCES[g.instance]?.label ?? g.instance}</span>
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {g.senders.map((s) => (
                            <div key={s.sender_id} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="text-muted-foreground truncate">{s.sender_email ?? `Sender ${s.sender_id}`}</span>
                              <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                                {s.missing_tags.map((t) => (
                                  <Badge key={t} variant="outline" className="text-[9px] px-1.5 py-0">+{t}</Badge>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {phase === "applying" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm">Applying tags to senders…</p>
            <p className="text-xs text-muted-foreground">Calling Bison /tags/attach-to-sender-emails per (instance, tag) batch.</p>
          </div>
        )}

        {phase === "done" && result && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <div className="text-sm flex-1">
                <p className="font-medium text-emerald-200">Conformance complete</p>
                <p className="text-emerald-400/80 text-xs mt-0.5">
                  Applied {result.applied} tag attachment{result.applied !== 1 ? "s" : ""}
                  {" "}across {result.appliedSenders?.length ?? 0} sender{(result.appliedSenders?.length ?? 0) !== 1 ? "s" : ""}
                  {result.failed > 0 ? ` · ${result.failed} failed` : ""}
                </p>
              </div>
            </div>

            {result.appliedSenders && result.appliedSenders.length > 0 && (
              <AppliedSendersBlock senders={result.appliedSenders} batchId={result.batchId} />
            )}

            {result.failures.length > 0 && (
              <div className="rounded-md border max-h-[200px] overflow-y-auto">
                <div className="bg-muted/50 px-3 py-1.5 text-xs flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  Failures (first {result.failures.length})
                </div>
                <table className="w-full text-xs">
                  <tbody className="divide-y">
                    {result.failures.map((f, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 text-muted-foreground">{f.instance}</td>
                        <td className="px-2 py-1">{f.tag}</td>
                        <td className="px-2 py-1 text-red-400 truncate max-w-[300px]">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2">
            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <div className="text-sm text-red-200">{error}</div>
          </div>
        )}

        <DialogFooter>
          {phase === "review" && (
            <>
              <Button variant="outline" onClick={() => loadPlan(effectiveQuery)} className="gap-1">
                <RefreshCw className="h-3.5 w-3.5" /> Rescan
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={apply}
                disabled={!plan || plan.totals.sendersAffected === 0}
              >
                Apply to {plan?.totals.sendersAffected ?? 0} sender{plan?.totals.sendersAffected !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {(phase === "done" || phase === "error") && (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          )}
          {phase === "applying" && (
            <Button disabled>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Applying…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function AppliedSendersBlock({
  senders,
  batchId,
}: {
  senders: AppliedSender[];
  batchId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const grouped = useMemo(() => {
    const m = new Map<string, { key: string; domain: string; instance: BisonInstanceSlug; senders: AppliedSender[] }>();
    for (const s of senders) {
      const key = `${s.instance}::${s.domain}`;
      let g = m.get(key);
      if (!g) { g = { key, domain: s.domain, instance: s.instance, senders: [] }; m.set(key, g); }
      g.senders.push(s);
    }
    return [...m.values()];
  }, [senders]);

  const copyEmails = () => {
    const emails = senders.map((s) => s.sender_email).filter(Boolean).join("\n");
    navigator.clipboard.writeText(emails).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const downloadCsv = () => {
    const header = "instance,domain,sender_email,sender_id,applied_tags";
    const rows = senders.map((s) =>
      [
        s.instance,
        s.domain,
        s.sender_email ?? "",
        s.sender_id,
        `"${s.applied_tags.join("; ")}"`,
      ].join(","),
    );
    const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `conform-tags-${dateStr}${batchId ? `-${batchId.slice(0, 8)}` : ""}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-md border flex-1 overflow-hidden flex flex-col min-h-0">
      <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 text-xs">
        <span>Senders tagged ({senders.length})</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1 px-2" onClick={copyEmails}>
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy emails"}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1 px-2" onClick={downloadCsv}>
            <Download className="h-3 w-3" />
            CSV
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto divide-y">
        {grouped.map((g) => (
          <div key={g.key} className="px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium truncate">{g.domain}</span>
              <span className="text-muted-foreground">{BISON_INSTANCES[g.instance]?.label ?? g.instance}</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {g.senders.map((s) => (
                <div key={s.sender_id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground truncate">{s.sender_email ?? `Sender ${s.sender_id}`}</span>
                  <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                    {s.applied_tags.map((t) => (
                      <Badge key={t} variant="outline" className="text-[9px] px-1.5 py-0">{t}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
