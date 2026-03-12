"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Mail,
  Wifi,
  Thermometer,
  Send,
  MessageSquare,
  Eye,
  AlertCircle,
} from "lucide-react";

interface Inbox {
  id: number;
  name: string;
  email: string;
  domain: string;
  status: string;
  type: string;
  daily_limit: number;
  warmup_enabled: boolean;
  tags: { id: number; name: string }[];
  emails_sent_count: number;
  total_replied_count: number;
  bounced_count: number;
  created_at: string;
}

interface WarmupData {
  warmup_score?: number;
  warmup_daily_limit?: number;
  warmup_emails_sent?: number;
  warmup_replies_received?: number;
  warmup_emails_saved_from_spam?: number;
  warmup_bounces_received_count?: number;
  warmup_bounces_caused_count?: number;
}

interface Props {
  inbox: Inbox | null;
  open: boolean;
  onClose: () => void;
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export function InboxDetailDialog({ inbox, open, onClose }: Props) {
  const [warmup, setWarmup] = useState<WarmupData | null>(null);
  const [warmupLoading, setWarmupLoading] = useState(false);

  useEffect(() => {
    if (!open || !inbox) return;
    setWarmup(null);
    setWarmupLoading(true);
    fetch(`/api/deliverability/inbox/${inbox.id}/warmup`)
      .then((r) => r.json())
      .then((d) => setWarmup(d))
      .catch(() => setWarmup(null))
      .finally(() => setWarmupLoading(false));
  }, [open, inbox?.id]);

  if (!inbox) return null;

  const isConnected = inbox.status === "Connected";
  const typeLabel = inbox.type === "microsoft_oauth" ? "Outlook" : inbox.type === "google_oauth" ? "Gmail" : inbox.type;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-base font-semibold">{inbox.name}</div>
              <div className="text-xs font-normal text-muted-foreground">{inbox.email}</div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Status + Type */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={isConnected ? "default" : "destructive"} className="text-xs">
              <Wifi className="h-3 w-3 mr-1" />
              {inbox.status}
            </Badge>
            <Badge variant="secondary" className="text-xs">{typeLabel}</Badge>
            <Badge variant="outline" className="text-xs">
              {inbox.daily_limit}/day limit
            </Badge>
            {inbox.warmup_enabled && (
              <Badge className="text-xs bg-orange-500/20 text-orange-400 border-orange-500/30 hover:bg-orange-500/30">
                <Thermometer className="h-3 w-3 mr-1" />
                Warmup On
              </Badge>
            )}
          </div>

          {/* Tags */}
          {inbox.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {inbox.tags.map((t) => (
                <span
                  key={t.id}
                  className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                >
                  {t.name}
                </span>
              ))}
            </div>
          )}

          {/* Sending Stats */}
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Sending Stats</p>
            <StatRow label="Emails Sent" value={<span className="flex items-center gap-1"><Send className="h-3 w-3" />{inbox.emails_sent_count.toLocaleString()}</span>} />
            <StatRow label="Replies" value={<span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" />{inbox.total_replied_count.toLocaleString()}</span>} />
            <StatRow label="Bounces" value={<span className="flex items-center gap-1 text-red-400"><AlertCircle className="h-3 w-3" />{inbox.bounced_count.toLocaleString()}</span>} />
          </div>

          {/* Warmup Stats */}
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Warmup Stats</p>
            {warmupLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : warmup && !('error' in warmup) ? (
              <>
                {warmup.warmup_score !== undefined && (
                  <StatRow
                    label="Warmup Score"
                    value={
                      <span className={`font-bold ${warmup.warmup_score >= 80 ? "text-green-400" : warmup.warmup_score >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                        {warmup.warmup_score}/100
                      </span>
                    }
                  />
                )}
                <StatRow label="Warmup Emails Sent" value={warmup.warmup_emails_sent ?? "—"} />
                <StatRow label="Warmup Replies" value={warmup.warmup_replies_received ?? "—"} />
                <StatRow label="Saved from Spam" value={warmup.warmup_emails_saved_from_spam ?? "—"} />
                <StatRow label="Warmup Bounces" value={
                  <span className={(warmup.warmup_bounces_received_count ?? 0) > 0 ? "text-red-400" : ""}>
                    {warmup.warmup_bounces_received_count ?? "—"}
                  </span>
                } />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Warmup data unavailable</p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Added: {new Date(inbox.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
