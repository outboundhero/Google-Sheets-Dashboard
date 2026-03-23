"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Reply,
  Eye,
  AlertTriangle,
  Users,
  Send,
  UserMinus,
  ThumbsUp,
} from "lucide-react";

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

interface Props {
  campaign: Campaign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  paused: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  completed: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  draft: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  archived: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
};

function StatItem({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs">{label}</span>
      </div>
      <p className={`text-lg font-bold ${color || ""}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function CampaignDetailDialog({ campaign: c, open, onOpenChange }: Props) {
  const replyRate = c.emails_sent > 0 ? ((c.replied / c.emails_sent) * 100).toFixed(1) : "0.0";
  const openRate = c.emails_sent > 0 ? ((c.unique_opens / c.emails_sent) * 100).toFixed(1) : "0.0";
  const bounceRate = c.emails_sent > 0 ? ((c.bounced / c.emails_sent) * 100).toFixed(1) : "0.0";
  const contactRate = c.total_leads > 0 ? ((c.total_leads_contacted / c.total_leads) * 100).toFixed(1) : "0.0";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="text-lg truncate">{c.name}</DialogTitle>
              <div className="flex items-center gap-2 mt-1">
                {c.client_tag && (
                  <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{c.client_tag}</span>
                )}
                <Badge className={`text-[10px] ${STATUS_BADGE[c.status] || STATUS_BADGE.draft}`}>
                  {c.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Created {new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* Lead Progress */}
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-muted-foreground">Lead Progress</span>
              <span className="font-medium">{c.total_leads_contacted.toLocaleString()} / {c.total_leads.toLocaleString()} contacted ({contactRate}%)</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(parseFloat(contactRate), 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>{c.remaining_leads.toLocaleString()} remaining</span>
              <span>{c.completion_percentage}% complete</span>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-4 gap-4">
            <StatItem icon={Mail} label="Emails Sent" value={c.emails_sent} />
            <StatItem icon={Reply} label="Replies" value={c.replied} sub={`${replyRate}% rate`} />
            <StatItem icon={Eye} label="Opens" value={c.unique_opens} sub={`${openRate}% rate`} />
            <StatItem icon={AlertTriangle} label="Bounced" value={c.bounced} sub={`${bounceRate}% rate`} color={c.bounced > 0 ? "text-destructive" : ""} />
          </div>

          <div className="grid grid-cols-4 gap-4 pt-3 border-t">
            <StatItem icon={Users} label="Total Leads" value={c.total_leads} />
            <StatItem icon={Send} label="Contacted" value={c.total_leads_contacted} />
            <StatItem icon={ThumbsUp} label="Interested" value={c.interested} />
            <StatItem icon={UserMinus} label="Unsubscribed" value={c.unsubscribed} />
          </div>

          {/* Unique Stats */}
          <div className="grid grid-cols-2 gap-4 pt-3 border-t">
            <div className="rounded-lg bg-muted/50 p-3">
              <span className="text-xs text-muted-foreground">Unique Replies</span>
              <p className="text-lg font-bold mt-0.5">{c.unique_replies.toLocaleString()}</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <span className="text-xs text-muted-foreground">Unique Opens</span>
              <p className="text-lg font-bold mt-0.5">{c.unique_opens.toLocaleString()}</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
