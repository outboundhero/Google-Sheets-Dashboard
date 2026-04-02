"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Loader2, Play, Pause, Archive } from "lucide-react";
import { toast } from "sonner";

interface Campaign {
  id: number;
  name: string;
  status: string;
  client_tag: string;
  total_leads: number;
  total_leads_contacted: number;
  remaining_leads: number;
  emails_sent: number;
  replied: number;
  unique_replies: number;
  bounced: number;
  opened: number;
  unique_opens: number;
  interested: number;
  unsubscribed: number;
  completion_percentage: number;
  created_at: string;
  updated_at: string;
}

interface StepStat {
  sent: number;
  leads_contacted: number;
  unique_opens: number;
  unique_replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
}

interface Step {
  id: number;
  order: number | null;
  variant: boolean;
  wait_in_days: number;
  email_subject: string;
  thread_reply: boolean;
  stats: StepStat | null;
  variants?: Step[];
}

interface DetailData {
  overallStats: {
    emails_sent: number;
    total_leads_contacted: number;
    unique_replies: number;
    reply_rate: number;
    bounced: number;
    bounce_rate: number;
  } | null;
  steps: Step[];
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  completed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  archived: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
};

// Clean spintax: take first option from each {a|b|c}
function cleanSubject(subject: string): string {
  return subject.replace(/\{([^{}]*)\}/g, (_, content) => {
    const parts = content.split("|");
    return parts[0] || content;
  }).replace(/\{([^{}]*)\}/g, (_, content) => {
    const parts = content.split("|");
    return parts[0] || content;
  });
}

function StatCell({ label, value, sub, warn }: { label: string; value: number; sub?: string; warn?: boolean }) {
  return (
    <div className="text-center px-2 py-1.5">
      <p className={`text-sm font-semibold tabular-nums ${warn ? "text-red-400" : ""}`}>{value.toLocaleString()}</p>
      <p className="text-[9px] text-muted-foreground">{sub || label}</p>
    </div>
  );
}

function StepRow({ step, index, isVariant }: { step: Step; index?: number; isVariant?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const s = step.stats;
  const replyRate = s && s.sent > 0 ? ((s.unique_replies / s.sent) * 100).toFixed(1) + "%" : "—";
  const subject = cleanSubject(step.email_subject);
  const hasVariants = step.variants && step.variants.length > 0;

  return (
    <>
      <div className={`grid grid-cols-[1fr_60px_60px_60px_60px] gap-1 items-center px-3 py-2 ${isVariant ? "pl-8 bg-muted/20" : "hover:bg-muted/30"} transition-colors`}>
        <div className="min-w-0 flex items-center gap-1.5">
          {hasVariants ? (
            <button onClick={() => setExpanded(!expanded)} className="shrink-0">
              {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {!isVariant && step.order && (
                <span className="text-[9px] font-medium bg-primary/10 text-primary rounded px-1 py-0.5 shrink-0">
                  Step {step.order}
                </span>
              )}
              {isVariant && (
                <span className="text-[9px] font-medium bg-amber-500/10 text-amber-500 rounded px-1 py-0.5 shrink-0">
                  Variant
                </span>
              )}
              {step.thread_reply && (
                <span className="text-[9px] text-muted-foreground shrink-0">Reply</span>
              )}
              {step.wait_in_days > 0 && (
                <span className="text-[9px] text-muted-foreground shrink-0">{step.wait_in_days}d wait</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{subject}</p>
          </div>
        </div>
        <StatCell label="Sent" value={s?.sent || 0} />
        <StatCell label="Replies" value={s?.unique_replies || 0} sub={replyRate} />
        <StatCell label="Bounced" value={s?.bounced || 0} warn={(s?.bounced || 0) > 0} />
        <StatCell label="Opens" value={s?.unique_opens || 0} />
      </div>
      {expanded && hasVariants && step.variants!.map((v) => (
        <StepRow key={v.id} step={v} isVariant />
      ))}
    </>
  );
}

export function CampaignDetailDialog({ campaign: c, open, onOpenChange, onStatusChange }: {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange?: (id: number, newStatus: string) => void;
}) {
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState(c.status);

  useEffect(() => { setCurrentStatus(c.status); }, [c.status]);

  const handleStatusChange = async (action: string) => {
    setConfirming(null);
    setStatusAction(action);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (res.ok) {
        const newStatus = action === "resume" ? "active" : action === "pause" ? "paused" : "archived";
        setCurrentStatus(newStatus);
        onStatusChange?.(c.id, newStatus);
        toast.success(`Campaign ${action}d successfully`);
      } else {
        toast.error(data.error || `Failed to ${action} campaign`);
      }
    } catch {
      toast.error(`Failed to ${action} campaign`);
    }
    setStatusAction(null);
  };

  useEffect(() => {
    if (!open || !c.id) return;
    setDetail(null);
    setLoading(true);
    fetch(`/api/campaigns/${c.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.steps) setDetail(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, c.id]);

  const rate = (n: number) => c.emails_sent > 0 ? ((n / c.emails_sent) * 100).toFixed(1) + "%" : "0%";
  const contactPct = c.total_leads > 0 ? ((c.total_leads_contacted / c.total_leads) * 100).toFixed(1) : "0";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base leading-tight pr-8">{c.name}</DialogTitle>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {c.client_tag && <span className="text-[11px] bg-muted px-2 py-0.5 rounded">{c.client_tag}</span>}
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_COLORS[currentStatus] || ""}`}>{currentStatus}</Badge>
            <span className="text-[11px] text-muted-foreground">
              {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>

          {/* Status Actions */}
          {confirming ? (
            <div className="flex items-center gap-2 mt-2 p-2.5 rounded-lg border bg-muted/30">
              <span className="text-xs flex-1">
                {confirming === "archive" ? "Archive" : confirming === "pause" ? "Pause" : "Resume"} this campaign?
              </span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                size="sm"
                variant={confirming === "archive" ? "destructive" : "default"}
                className="h-7 text-xs"
                onClick={() => handleStatusChange(confirming)}
              >
                Confirm
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 mt-2">
              {(currentStatus === "paused" || currentStatus === "draft") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                  disabled={!!statusAction}
                  onClick={() => setConfirming("resume")}
                >
                  {statusAction === "resume" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Resume
                </Button>
              )}
              {currentStatus === "active" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/30 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                  disabled={!!statusAction}
                  onClick={() => setConfirming("pause")}
                >
                  {statusAction === "pause" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
                  Pause
                </Button>
              )}
              {currentStatus !== "archived" && currentStatus !== "completed" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/30"
                  disabled={!!statusAction}
                  onClick={() => setConfirming("archive")}
                >
                  {statusAction === "archive" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
                  Archive
                </Button>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Progress */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Progress</span>
              <span className="tabular-nums">{c.total_leads_contacted.toLocaleString()} / {c.total_leads.toLocaleString()} ({contactPct}%)</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(Number(contactPct), 100)}%` }} />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">{c.remaining_leads.toLocaleString()} remaining</p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-4 gap-px rounded-lg overflow-hidden border bg-border">
            {[
              { label: "Sent", value: c.emails_sent },
              { label: "Replies", value: c.replied, sub: rate(c.replied) },
              { label: "Bounced", value: c.bounced, sub: rate(c.bounced), warn: c.bounced > 0 },
              { label: "Interested", value: c.interested },
            ].map((s) => (
              <div key={s.label} className="bg-card p-3 text-center">
                <p className={`text-lg font-semibold tabular-nums ${s.warn ? "text-red-400" : ""}`}>{s.value.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">{s.sub ? `${s.label} · ${s.sub}` : s.label}</p>
              </div>
            ))}
          </div>

          {/* Steps Analysis */}
          <div>
            <h3 className="text-sm font-medium mb-2">Sequence Steps</h3>
            {loading ? (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : detail?.steps && detail.steps.length > 0 ? (
              <div className="rounded-lg border overflow-hidden">
                <div className="grid grid-cols-[1fr_60px_60px_60px_60px] gap-1 px-3 py-1.5 text-[9px] text-muted-foreground font-medium bg-muted/30 border-b">
                  <span>Step</span>
                  <span className="text-center">Sent</span>
                  <span className="text-center">Replies</span>
                  <span className="text-center">Bounced</span>
                  <span className="text-center">Opens</span>
                </div>
                <div className="divide-y">
                  {detail.steps.map((step, i) => (
                    <StepRow key={step.id} step={step} index={i} />
                  ))}
                </div>
              </div>
            ) : !loading ? (
              <p className="text-xs text-muted-foreground text-center py-4">No sequence data available</p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
