"use client";

// Per-domain history — everything the system ever did to one domain and
// why, newest first: flagged / tagged / redirect / attached / removed /
// queued for deletion / deleted, plus lifecycle and queue rows. Vicky's rule
// (2026-08-27): before any domain is touched, its previous steps must be
// visible; Spencer/Nick: "we shouldn't have to ask whether it worked".
import { useEffect, useState } from "react";
import { X, History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Entry { at: string; kind: string; instance: string | null; clientTag: string | null; detail: string; source: string }
interface Now { instance: string; tags: string[] | null; sent: number | null; replied: number | null; inboxes: number | null; created: string | null; redirect: string | null }

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "B2B1·OH", cleaningoutbound: "B2C1·CO", facilityreach: "B2B2·FR", outboundclean: "B2C2·OC",
};

export function DomainHistoryDialog({ domain, onClose }: { domain: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ now: Now[]; history: Entry[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!domain) return;
    let alive = true;
    // Deferred so no setState runs synchronously inside the effect
    // (react-hooks rule); the fetch itself is async anyway.
    const id = setTimeout(async () => {
      setData(null); setErr(null); setLoading(true);
      try {
        const r = await fetch(`/api/replacement/domain-history?domain=${encodeURIComponent(domain)}`, { cache: "no-store" });
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !j || j.error) setErr(j?.error || `HTTP ${r.status}`);
        else setData({ now: j.now || [], history: j.history || [] });
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed");
      } finally {
        if (alive) setLoading(false);
      }
    }, 0);
    return () => { alive = false; clearTimeout(id); };
  }, [domain]);

  if (!domain) return null;

  const kindClass = (k: string) =>
    k === "error" ? "text-destructive"
      : ["tagged", "attached", "redirect_set"].includes(k) ? "text-emerald-500"
      : ["removed", "cancel_queued", "deletion", "cancellation"].includes(k) ? "text-amber-500"
      : "text-muted-foreground";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-xl border bg-background shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium min-w-0">
            <History className="h-4 w-4 shrink-0" />
            <span className="truncate">{domain}</span>
            <span className="text-[11px] text-muted-foreground">— full history, newest first</span>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3 text-xs">
          {loading && <div className="flex items-center gap-2 text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> loading…</div>}
          {err && <div className="text-destructive">{err}</div>}

          {data && (
            <>
              <div className="space-y-1">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Right now</div>
                {data.now.length === 0 && <div className="text-muted-foreground">Not present in any instance.</div>}
                {data.now.map((n) => (
                  <div key={n.instance} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5">
                    <span className="font-medium">{INSTANCE_SHORT[n.instance] ?? n.instance}</span>
                    <span>{n.inboxes ?? 0} inboxes</span>
                    <span>{(n.sent ?? 0).toLocaleString()} sent · {(n.replied ?? 0).toLocaleString()} replied</span>
                    <span className="text-muted-foreground">added {n.created ? String(n.created).slice(0, 10) : "—"}</span>
                    <span className="text-muted-foreground truncate max-w-[220px]" title={n.redirect ?? ""}>→ {n.redirect || "no redirect"}</span>
                    <span className="text-muted-foreground">tags: {(n.tags || []).join(", ") || "—"}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">History ({data.history.length})</div>
                {data.history.length === 0 && <div className="text-muted-foreground italic">No recorded actions — the system has never touched this domain.</div>}
                <div className="rounded-md border divide-y">
                  {data.history.map((h, i) => (
                    <div key={i} className="flex items-start gap-2 px-2.5 py-1.5">
                      <span className="text-muted-foreground tabular-nums w-[110px] shrink-0">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                      <span className="text-muted-foreground w-[64px] shrink-0">{h.instance ? (INSTANCE_SHORT[h.instance] ?? h.instance) : ""}</span>
                      <span className={`w-[110px] shrink-0 ${kindClass(h.kind)}`}>{h.kind}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border text-muted-foreground shrink-0">{h.source}</span>
                      <span className="min-w-0 break-words">{h.clientTag ? <b className="mr-1">{h.clientTag}</b> : null}{h.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
