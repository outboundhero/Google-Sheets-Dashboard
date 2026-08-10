"use client";

/**
 * Bulk move-to-instance dialog (Inboxing domains).
 *
 * Step 1 — on open, dry-runs /api/deliverability/move-domains: routes each
 *   selected domain (must be an Inboxing domain, single source instance,
 *   ≤10 tags) and loads the account's Email Bison platform connections.
 * Step 2 — user picks the TARGET Bison instance; the matching Inboxing
 *   platform connection is auto-suggested by name (override dropdown shown).
 * Step 3 — "Move N domains" hands the job off to the page, which drives the
 *   batched apply and renders live progress in the panel at the top of the
 *   deliverability dashboard (per user requirement — progress must not be
 *   trapped inside a dialog).
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
import { AlertTriangle, ArrowRightLeft, Loader2, XCircle } from "lucide-react";
import {
  ALL_INSTANCE_SLUGS,
  BISON_INSTANCES,
  INSTANCE_SHORT_LABELS,
  type BisonInstanceSlug,
} from "@/lib/bison-instances";

interface PlatformConnection {
  id: string;
  name: string;
  platform: string;
  verificationStatus: string;
  verificationError: string | null;
}

interface PlanRow {
  domain: string;
  action: "move" | "skip";
  skipReason?: string;
  sourceInstances?: BisonInstanceSlug[];
  inboxCount?: number;
  perInstance?: { instance: BisonInstanceSlug; inboxCount: number }[];
  tags?: string[];
}

interface PlanResponse {
  connections: PlatformConnection[];
  connectionsError: string | null;
  plan: PlanRow[];
  counts: { movable: number; skipped: number };
}

export interface MoveJob {
  domains: string[];
  targetInstance: BisonInstanceSlug;
  platformConnectionId: string;
  connectionName: string;
  /** Confirmed ORIGINAL instance (left side of the dialog). Rows not on it are excluded. */
  sourceInstance?: BisonInstanceSlug;
  /** After a successful move, remove the moved domains' senders from the campaigns they're in on the SOURCE instance. */
  removeFromCampaigns?: boolean;
  /** Nick's confirmed #4: for FULLY-VERIFIED domains only, auto-delete the source copy after a 24h grace. Partials are never deleted — they're flagged. */
  autoDeleteSource?: boolean;
}

type Phase = "planning" | "review" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedDomains: string[];
  /** Page takes over: runs the batched apply + renders the top progress panel. */
  onStart: (job: MoveJob) => void;
}

/** Best-effort pairing of an Inboxing connection name to a Bison instance. */
function connectionMatchesInstance(connName: string, slug: BisonInstanceSlug): boolean {
  const norm = connName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.includes(slug)) return true;
  const inst = BISON_INSTANCES[slug];
  // e.g. "B2B #1" → "b2b1" appearing in "OH B2B1" style names
  const tierGroup = `${inst.tier}${inst.group}`;
  if (norm.includes(tierGroup)) return true;
  // base-url host without dots, e.g. "appoutboundheroco"
  const host = inst.baseUrl.replace(/^https?:\/\//, "").split("/")[0].replace(/[^a-z0-9]/g, "");
  if (host && norm.includes(host)) return true;
  return false;
}

export function MoveDomainsDialog({ open, onOpenChange, selectedDomains, onStart }: Props) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<BisonInstanceSlug | "">("");
  const [target, setTarget] = useState<BisonInstanceSlug | "">("");
  const [connectionId, setConnectionId] = useState<string>("");
  // Spencer: "we're going to say yes probably every time" → default ON.
  const [removeFromCampaigns, setRemoveFromCampaigns] = useState(true);
  // Nick/Spencer: auto-delete the source copy after 24h — verified domains only.
  const [autoDeleteSource, setAutoDeleteSource] = useState(true);

  // Snapshot the selection on the open transition only (parent rebuilds the
  // array every render — depending on it would re-run the dry-run mid-review).
  useEffect(() => {
    if (!open) {
      setPlan(null);
      setError(null);
      setSource("");
      setTarget("");
      setConnectionId("");
      setRemoveFromCampaigns(true);
      setAutoDeleteSource(true);
      setPhase("planning");
      return;
    }
    if (selectedDomains.length === 0) return;
    setPhase("planning");
    fetch("/api/deliverability/move-domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, domains: selectedDomains }),
    })
      .then(async (res) => {
        const text = await res.text();
        let data: PlanResponse & { error?: string };
        try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        setPlan(data);
        // Pre-fill the ORIGINAL instance when every movable row shares one
        // source — the common case. Spencer: confirm source explicitly, don't
        // rely on auto-matching alone.
        const srcs = new Set<BisonInstanceSlug>();
        for (const p of data.plan || []) {
          if (p.action === "move") for (const s of p.sourceInstances || []) srcs.add(s);
        }
        if (srcs.size === 1) setSource([...srcs][0]);
        setPhase("review");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed");
        setPhase("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-suggest the connection when a target instance is picked.
  const pickTarget = (slug: BisonInstanceSlug | "") => {
    setTarget(slug);
    if (!slug || !plan) return;
    const match = plan.connections.find(
      (c) => c.verificationStatus === "verified" && connectionMatchesInstance(c.name, slug),
    ) ?? plan.connections.find((c) => connectionMatchesInstance(c.name, slug));
    setConnectionId(match?.id ?? "");
  };

  const movable = useMemo(() => (plan?.plan || []).filter((p) => p.action === "move"), [plan]);
  // Every source instance seen across movable rows — feeds the Original picker.
  const sourceOptions = useMemo(() => {
    const s = new Set<BisonInstanceSlug>();
    for (const p of movable) for (const i of p.sourceInstances || []) s.add(i);
    return [...s];
  }, [movable]);
  // Once source/target are chosen, exclude rows the server would skip anyway:
  // - rows not on the confirmed ORIGINAL instance,
  // - single-instance domains already ON the target (pointless), and
  // - 2-instance domains where NEITHER copy is on the target (the mover only
  //   handles "move the other copy onto the target" for dual-presence rows).
  const movableForTarget = useMemo(
    () => movable.filter((p) => {
      const src = p.sourceInstances || [];
      if (source && !src.includes(source)) return false;
      if (!target) return true;
      if (src.length === 1) return src[0] !== target;
      if (src.length === 2) return src.includes(target);
      return true;
    }),
    [movable, source, target],
  );
  // What actually moves for a row given the chosen target (for dual-presence
  // rows only the non-target copy moves — the summed count is misleading).
  const moveDetail = (p: PlanRow): string => {
    const src = p.sourceInstances || [];
    if (target && src.length === 2 && src.includes(target)) {
      const other = src.find((s) => s !== target)!;
      const count = p.perInstance?.find((x) => x.instance === other)?.inboxCount ?? "?";
      return `move ${count} inboxes from ${INSTANCE_SHORT_LABELS[other] ?? other} → ${INSTANCE_SHORT_LABELS[target]}`;
    }
    return `move ${p.inboxCount ?? "?"} inboxes${target ? ` → ${INSTANCE_SHORT_LABELS[target]}` : ""}`;
  };
  const selectedConnection = plan?.connections.find((c) => c.id === connectionId) ?? null;
  const canStart = Boolean(source && target && source !== target && connectionId && movableForTarget.length > 0);

  const start = () => {
    if (!canStart || !source || !target || !selectedConnection) return;
    onStart({
      domains: movableForTarget.map((p) => p.domain),
      targetInstance: target,
      platformConnectionId: selectedConnection.id,
      connectionName: selectedConnection.name,
      sourceInstance: source,
      removeFromCampaigns,
      autoDeleteSource,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" />
            Move to Instance
          </DialogTitle>
          <DialogDescription>
            Moves Inboxing domains&apos; inboxes to another Bison instance: tags sync to
            Inboxing → Inboxing uploads the mailboxes to the target instance. The
            domain <b>stays on the source instance</b> too — after the move you&apos;ll get a
            one-click option to remove it from the source. Progress shows in the panel
            at the top of the page.
          </DialogDescription>
        </DialogHeader>

        {phase === "planning" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Checking {selectedDomains.length} domain{selectedDomains.length !== 1 ? "s" : ""} + platform connections…
            </span>
          </div>
        )}

        {phase === "review" && plan && (
          <div className="flex flex-col gap-3 flex-1 overflow-hidden">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-xs">{movableForTarget.length} movable</Badge>
              {plan.counts.skipped > 0 && (
                <Badge variant="outline" className="text-xs text-amber-500 border-amber-500/40">
                  {plan.counts.skipped} will skip
                </Badge>
              )}
            </div>

            {plan.connectionsError && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-300">
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Couldn&apos;t load Inboxing platform connections: {plan.connectionsError}
              </div>
            )}

            {/* Original (left) → New (right) instance pickers — both explicitly
                confirmed (Spencer: don't rely on auto-matching alone). */}
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Original instance (moving FROM)</label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as BisonInstanceSlug | "")}
                  className="w-full text-xs rounded-lg border bg-background px-2 py-2 outline-none"
                >
                  <option value="">Select instance…</option>
                  {(sourceOptions.length > 0 ? sourceOptions : ALL_INSTANCE_SLUGS).map((s) => (
                    <option key={s} value={s}>{INSTANCE_SHORT_LABELS[s]} — {BISON_INSTANCES[s].label}</option>
                  ))}
                </select>
              </div>
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground mb-2.5 shrink-0" />
              <div className="space-y-1.5">
                <label className="text-xs font-medium">New instance (moving TO)</label>
                <select
                  value={target}
                  onChange={(e) => pickTarget(e.target.value as BisonInstanceSlug | "")}
                  className="w-full text-xs rounded-lg border bg-background px-2 py-2 outline-none"
                >
                  <option value="">Select instance…</option>
                  {ALL_INSTANCE_SLUGS.map((s) => (
                    <option key={s} value={s} disabled={s === source}>{INSTANCE_SHORT_LABELS[s]} — {BISON_INSTANCES[s].label}{s === source ? " (original)" : ""}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Inboxing connection (auto-matched to the new instance)</label>
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="w-full text-xs rounded-lg border bg-background px-2 py-2 outline-none"
              >
                <option value="">Select connection…</option>
                {plan.connections.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.verificationStatus !== "verified" && c.verificationStatus !== ""}>
                    {c.name}{c.verificationStatus && c.verificationStatus !== "verified" ? ` (${c.verificationStatus})` : ""}
                  </option>
                ))}
              </select>
              {target && !connectionId && plan.connections.length > 0 && (
                <p className="text-[11px] text-amber-400">No connection auto-matched — pick the one wired to {INSTANCE_SHORT_LABELS[target]}.</p>
              )}
              {selectedConnection?.verificationError && (
                <p className="text-[11px] text-red-400">{selectedConnection.verificationError}</p>
              )}
            </div>

            {/* Post-move: pull the moved senders out of the source instance's campaigns */}
            <label className="flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40">
              <input
                type="checkbox"
                checked={removeFromCampaigns}
                onChange={(e) => setRemoveFromCampaigns(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">Remove moved senders from their current campaigns</span>
                <span className="block text-muted-foreground mt-0.5">
                  After each domain lands on the new instance, its senders are pulled out of the campaigns
                  they&apos;re in on {source ? INSTANCE_SHORT_LABELS[source] : "the original instance"}. Custom tags
                  (client tag, Outlook, Inboxing, …) carry over to the new instance automatically.
                </span>
              </span>
            </label>

            {/* Nick's confirmed #4: verified-only source auto-delete, 24h grace */}
            <label className="flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40">
              <input
                type="checkbox"
                checked={autoDeleteSource}
                onChange={(e) => setAutoDeleteSource(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs">
                <span className="font-medium">Auto-delete from the original instance after 24 hours</span>
                <span className="block text-muted-foreground mt-0.5">
                  Only domains where <b>every</b> inbox verifiably landed on the new instance are scheduled;
                  partial moves are never deleted — they&apos;re flagged here and in Slack so you can retry them.
                  Cancel any scheduled deletion from the Duplicate domains card within the 24h window.
                </span>
              </span>
            </label>

            {/* Per-domain preview */}
            <div className="flex-1 overflow-y-auto rounded-md border min-h-[140px]">
              <table className="w-full text-xs">
                <thead className="text-left bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Domain</th>
                    <th className="px-2 py-1.5 font-medium">From</th>
                    <th className="px-2 py-1.5 font-medium">Plan</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(plan.plan || []).map((r) => {
                    const src = r.sourceInstances || [];
                    const notOnSource = r.action === "move" && source && !src.includes(source);
                    const pointless = r.action === "move" && target && src.length === 1 && src[0] === target;
                    const unreachable = r.action === "move" && target && src.length === 2 && !src.includes(target);
                    return (
                      <tr key={r.domain} className={r.action === "skip" || notOnSource || pointless || unreachable ? "bg-amber-950/10" : ""}>
                        <td className="px-2 py-1 truncate max-w-[220px]">{r.domain}</td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {src.map((s) => INSTANCE_SHORT_LABELS[s] ?? s).join(", ") || "—"}
                        </td>
                        <td className="px-2 py-1">
                          {r.action === "skip" ? (
                            <span className="text-amber-400 inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Skip — {r.skipReason}
                            </span>
                          ) : notOnSource ? (
                            <span className="text-amber-400 inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Skip — not on {INSTANCE_SHORT_LABELS[source as BisonInstanceSlug]}
                            </span>
                          ) : pointless ? (
                            <span className="text-amber-400 inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Skip — already on target
                            </span>
                          ) : unreachable ? (
                            <span className="text-amber-400 inline-flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Skip — exists on {src.map((s) => INSTANCE_SHORT_LABELS[s] ?? s).join(" + ")}; pick one of them as the target
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{moveDetail(r)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={start}
                disabled={!canStart}
                title={!source ? "Confirm the original instance" : !target ? "Pick the new instance" : source === target ? "Original and new instance must differ" : !connectionId ? "Pick the Inboxing connection" : movableForTarget.length === 0 ? "Nothing movable" : undefined}
              >
                Move {movableForTarget.length} domain{movableForTarget.length !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {phase === "error" && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
