"use client";

// What the attach automations did, on the page where the team works
// (Spencer's Loom 2026-09-16: "in deliverability it would tell us what
// happened… how many accounts and which ones they were if you hit the
// toggle"). Collapsed by default, one row per client, expandable to the
// domains and campaigns involved. Read-only.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Link2, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Item {
  clientTag: string;
  instance: string;
  accounts: number;
  domains: string[];
  campaigns: string[];
  source: string;
  at: string;
}

const INSTANCE_LABEL: Record<string, string> = {
  outboundhero: "B2B1·OH",
  cleaningoutbound: "B2C1·CO",
  facilityreach: "B2B2·FR",
  outboundclean: "B2C2·OC",
};

export function AttachActivityCard() {
  const [items, setItems] = useState<Item[]>([]);
  const [totalAccounts, setTotalAccounts] = useState(0);
  const [clients, setClients] = useState(0);
  const [days, setDays] = useState(1);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (d = days) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/replacement/attach-activity?days=${d}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setItems(json.items ?? []);
      setTotalAccounts(json.totalAccounts ?? 0);
      setClients(json.clients ?? 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(1); }, []);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <Link2 className="h-4 w-4 shrink-0 text-emerald-500" />
          <span className="text-sm font-medium">Accounts attached to campaigns</span>
          <Badge variant="outline" className="text-[10px]">
            {totalAccounts} account{totalAccounts === 1 ? "" : "s"} · {clients} client{clients === 1 ? "" : "s"}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            last {days === 1 ? "24 hours" : `${days} days`} · automatic attaches only
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
        </button>

        {open && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              {[1, 3, 7].map((d) => (
                <button
                  key={d}
                  onClick={() => { setDays(d); void load(d); }}
                  className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                    days === d
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                  }`}
                >
                  {d === 1 ? "24h" : `${d}d`}
                </button>
              ))}
              <Button size="sm" variant="outline" className="gap-2 h-7 ml-auto" onClick={() => void load()} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>

            {err && <p className="text-sm text-destructive">{err}</p>}
            {!err && items.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing was attached automatically in this window — every client&apos;s accounts were already in their campaigns.
              </p>
            )}

            <div className="rounded-lg border divide-y">
              {items.map((it) => {
                const key = `${it.clientTag}:${it.instance}:${it.source}`;
                const isOpen = expanded.has(key);
                return (
                  <div key={key}>
                    <button onClick={() => toggle(key)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs">
                      {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                      <span className="font-mono px-1.5 py-0.5 rounded bg-muted text-foreground">{it.clientTag}</span>
                      <span className="text-muted-foreground">{INSTANCE_LABEL[it.instance] ?? it.instance}</span>
                      <span className="font-medium">{it.accounts} account{it.accounts === 1 ? "" : "s"}</span>
                      <span className="text-muted-foreground">· {it.source}</span>
                      <span className="ml-auto text-muted-foreground">{it.at.slice(5, 16).replace("T", " ")}</span>
                    </button>
                    {isOpen && (
                      <div className="px-8 pb-3 space-y-1 text-[11px] text-muted-foreground">
                        {it.domains.length > 0 && (
                          <div><span className="text-foreground">Domains:</span> {it.domains.join(", ")}</div>
                        )}
                        {it.campaigns.length > 0 && (
                          <div><span className="text-foreground">Campaigns:</span> {it.campaigns.join(", ")}</div>
                        )}
                        {it.domains.length === 0 && it.campaigns.length === 0 && (
                          <div>Per-campaign detail is in the run log for this client.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
