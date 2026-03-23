"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

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

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  paused: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  completed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  draft: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  archived: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
};

function Stat({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className="text-center">
      <p className="text-[11px] text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${warn ? "text-red-400" : ""}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

export function CampaignDetailDialog({ campaign: c, open, onOpenChange }: {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rate = (n: number) => c.emails_sent > 0 ? ((n / c.emails_sent) * 100).toFixed(1) + "%" : "0%";
  const contactPct = c.total_leads > 0 ? ((c.total_leads_contacted / c.total_leads) * 100).toFixed(1) : "0";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base leading-tight">{c.name}</DialogTitle>
          <div className="flex items-center gap-2 mt-1.5">
            {c.client_tag && <span className="text-[11px] bg-muted px-2 py-0.5 rounded">{c.client_tag}</span>}
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${STATUS_COLORS[c.status] || ""}`}>{c.status}</Badge>
            <span className="text-[11px] text-muted-foreground">
              {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-3">
          {/* Progress */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Progress</span>
              <span className="tabular-nums">{c.total_leads_contacted.toLocaleString()} / {c.total_leads.toLocaleString()} ({contactPct}%)</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(Number(contactPct), 100)}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{c.remaining_leads.toLocaleString()} remaining</span>
              <span>{c.completion_percentage}% complete</span>
            </div>
          </div>

          {/* Main Stats */}
          <div className="grid grid-cols-4 gap-3 rounded-lg bg-muted/30 p-3">
            <Stat label="Sent" value={c.emails_sent} />
            <Stat label="Replies" value={c.replied} sub={rate(c.replied)} />
            <Stat label="Opens" value={c.unique_opens} sub={rate(c.unique_opens)} />
            <Stat label="Bounced" value={c.bounced} sub={rate(c.bounced)} warn={c.bounced > 0} />
          </div>

          {/* Secondary Stats */}
          <div className="grid grid-cols-4 gap-3">
            <Stat label="Total Leads" value={c.total_leads} />
            <Stat label="Contacted" value={c.total_leads_contacted} />
            <Stat label="Interested" value={c.interested} />
            <Stat label="Unsubscribed" value={c.unsubscribed} />
          </div>

          {/* Unique */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3 text-center">
              <p className="text-[11px] text-muted-foreground">Unique Replies</p>
              <p className="text-xl font-semibold mt-0.5 tabular-nums">{c.unique_replies.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-[11px] text-muted-foreground">Unique Opens</p>
              <p className="text-xl font-semibold mt-0.5 tabular-nums">{c.unique_opens.toLocaleString()}</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
