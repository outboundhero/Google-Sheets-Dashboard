"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Loader2, Save, History, Copy, CalendarClock, AlertTriangle, Tag, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { INSTANCE_SHORT_LABELS } from "@/lib/bison-instances";
import { deriveStage } from "@/lib/campaigns/stage";
import type { CampaignData } from "@/lib/hooks/use-campaigns";

const STAGE_OPTIONS = ["Main", "Nurture 1", "Nurture 2", "Nurture 3", "Nurture 4", "Nurture 5"];
const fetcher = (url: string) => fetch(url).then((r) => r.json());
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

interface Ev { id: number; event_type: string; detail: string | null; actor: string | null; created_at: string }

export function CampaignDetailDrawer({ campaign, clientTags, onClose, onSaved }: {
  campaign: CampaignData | null;
  clientTags: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = !!campaign;
  const [stage, setStage] = useState("");
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (campaign) { setStage(campaign.effective_stage || "Main"); setTag(campaign.client_tag || ""); setMsg(null); }
  }, [campaign]);

  const { data: hist } = useSWR<{ events: Ev[] }>(campaign ? `/api/campaigns/events?instance=${campaign.instance}&campaignId=${campaign.id}` : null, fetcher);

  const save = async () => {
    if (!campaign) return;
    setSaving(true); setMsg(null);
    try {
      const autoStage = deriveStage(campaign.name);
      const autoTag = (campaign.name.split(":")[0] || "").trim().toUpperCase();
      const res = await fetch("/api/campaigns/override", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance: campaign.instance, id: campaign.id,
          stage_override: stage === autoStage ? "" : stage,
          client_tag_override: tag.trim().toUpperCase() === autoTag ? "" : tag,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || "failed");
      setMsg("Saved");
      onSaved();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Failed"); }
    finally { setSaving(false); }
  };

  if (!campaign) return null;
  const c = campaign;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm leading-snug pr-6">{c.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {/* Overview */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            <Info label="Client" value={c.client_name || c.client_tag || "—"} />
            <Info label="Instance" value={INSTANCE_SHORT_LABELS[c.instance] || c.instance} />
            <Info label="Classification" value={c.classification || "—"} />
            <Info label="Group" value={c.group ? `Group ${c.group}` : "—"} />
            <Info label="Status" value={c.status} />
            <Info label="Completion" value={`${(c.completion_percentage || 0).toFixed(0)}%`} />
            <Info label="Client start" value={fmtDate(c.client_start_date)} />
            <Info label="Go-live" value={fmtDate(c.go_live_date)} />
            <Info label="Started sending" value={fmtDate(c.first_sending_at)} />
            <Info label="Senders" value={c.sender_count ?? "—"} />
            <Info label="Leads" value={`${(c.total_leads_contacted || 0).toLocaleString()} / ${(c.total_leads || 0).toLocaleString()}`} />
            <Info label="Schedule" value={c.sched_start_time ? `${c.sched_start_time.slice(0, 5)}–${(c.sched_end_time || "").slice(0, 5)} ${c.sched_timezone || ""}` : "—"} />
          </div>

          {/* Manual correction (§4 stage, §5 client tag) */}
          <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Pencil className="h-3 w-3" /> Manual correction</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><Tag className="h-2.5 w-2.5" /> Stage</span>
                <select value={stage} onChange={(e) => setStage(e.target.value)} className="w-full text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary">
                  {[...new Set([stage, ...STAGE_OPTIONS])].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Client tag</span>
                <select value={tag} onChange={(e) => setTag(e.target.value)} className="w-full text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary">
                  {[...new Set([tag, ...clientTags].filter(Boolean))].sort().map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Reassigns this campaign to the chosen client in LeadSync (grouping, filters, classification, duplication) — it doesn&apos;t rename or touch Bison.</span>
              <div className="flex items-center gap-2">
                {msg && <span className={`text-[11px] ${msg === "Saved" ? "text-emerald-500" : "text-destructive"}`}>{msg}</span>}
                <Button size="sm" className="h-7 text-xs gap-1.5" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save</Button>
              </div>
            </div>
          </div>

          {/* History (§29) */}
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-1.5"><History className="h-3 w-3" /> History</div>
            {!hist ? <div className="text-[11px] text-muted-foreground">Loading…</div>
              : hist.events.length === 0 ? <div className="text-[11px] text-muted-foreground">No events yet.</div>
              : (
                <div className="space-y-2 border-l pl-3">
                  {hist.events.map((e) => (
                    <div key={e.id} className="relative">
                      <div className="absolute -left-[15px] top-1 h-2 w-2 rounded-full bg-primary/60" />
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <EvIcon type={e.event_type} />
                        <span className="font-medium">{labelFor(e.event_type)}</span>
                        <span className="text-muted-foreground ml-auto tabular-nums">{new Date(e.created_at).toLocaleString()}</span>
                      </div>
                      {e.detail && <div className="text-[10px] text-muted-foreground">{e.detail}</div>}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string | number }) {
  return <div><div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="font-medium">{value}</div></div>;
}
function labelFor(t: string): string {
  return t === "duplicated" ? "Duplicated" : t === "duplicate_failed" ? "Duplication failed" : t === "schedule_updated" ? "Schedule updated" : t === "reclassified" ? "Reclassified" : t;
}
function EvIcon({ type }: { type: string }) {
  if (type === "duplicated") return <Copy className="h-3 w-3 text-emerald-500" />;
  if (type === "duplicate_failed") return <AlertTriangle className="h-3 w-3 text-destructive" />;
  if (type === "schedule_updated") return <CalendarClock className="h-3 w-3 text-primary" />;
  return <Pencil className="h-3 w-3 text-muted-foreground" />;
}
