"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Globe, Mail, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { InboxDetailDialog } from "./inbox-detail-dialog";

interface DomainRow {
  domain: string;
  inbox_count: number;
  domain_created_at: string | null;
  warmup_status: string;
}

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

interface Props {
  domain: DomainRow;
  defaultOpen?: boolean;
  tagFilter?: string;
}

export function DomainAccordion({ domain, defaultOpen = false, tagFilter }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedInbox, setSelectedInbox] = useState<Inbox | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadInboxes = useCallback(async () => {
    if (loaded && !tagFilter) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ domain: domain.domain });
      if (tagFilter) params.set("tag", tagFilter);
      const res = await fetch(`/api/deliverability/inboxes?${params}`);
      const json = await res.json();
      setInboxes(json.inboxes || []);
      setLoaded(true);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [domain.domain, tagFilter, loaded]);

  useEffect(() => {
    if (open) loadInboxes();
  }, [open, loadInboxes]);

  // Reload when tag filter changes
  useEffect(() => {
    if (open) {
      setLoaded(false);
      loadInboxes();
    }
  }, [tagFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClickInbox = (inbox: Inbox) => {
    setSelectedInbox(inbox);
    setDialogOpen(true);
  };

  // Warmup days remaining
  const daysOld = domain.domain_created_at
    ? Math.floor((Date.now() - new Date(domain.domain_created_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const warmupComplete = daysOld !== null && daysOld >= 21;
  const daysRemaining = daysOld !== null ? Math.max(0, 21 - daysOld) : null;

  return (
    <>
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Domain Header */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-accent/50 transition-colors"
        >
          <div className="flex-shrink-0">
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="font-medium text-sm flex-1 text-left">{domain.domain}</span>
          <div className="flex items-center gap-2 flex-shrink-0">
            {warmupComplete ? (
              <span className="inline-flex items-center gap-1 text-xs bg-green-500/15 text-green-400 border border-green-500/30 rounded-full px-2 py-0.5">
                ✓ Warmup done
              </span>
            ) : daysRemaining !== null ? (
              <span className="inline-flex items-center gap-1 text-xs bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-full px-2 py-0.5">
                ⏳ {daysRemaining}d left
              </span>
            ) : null}
            <Badge variant="secondary" className="text-xs">
              <Mail className="h-3 w-3 mr-1" />
              {domain.inbox_count}
            </Badge>
          </div>
        </button>

        {/* Inbox List */}
        {open && (
          <div className="border-t">
            {loading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">Loading inboxes…</div>
            ) : inboxes.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">No inboxes found</div>
            ) : (
              <div className="divide-y divide-border/50">
                {inboxes.map((inbox) => (
                  <button
                    key={inbox.id}
                    onClick={() => handleClickInbox(inbox)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{inbox.name}</span>
                        {inbox.status === "Connected" ? (
                          <Wifi className="h-3 w-3 text-green-400 flex-shrink-0" />
                        ) : (
                          <WifiOff className="h-3 w-3 text-red-400 flex-shrink-0" />
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{inbox.email}</div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end max-w-[200px]">
                      {inbox.tags.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground"
                        >
                          {t.name}
                        </span>
                      ))}
                      {inbox.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{inbox.tags.length - 3}</span>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <InboxDetailDialog
        inbox={selectedInbox}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
