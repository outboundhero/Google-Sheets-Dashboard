"use client";

// Purchase proposals — approve/reject staged domain buys. On Approve, THIS
// component drives the real purchase chain from the browser via the existing
// endpoints (canonical frontend-driven pattern):
//   1. POST /api/domains/check        (Porkbun availability — paced 10.5s)
//   2. POST /api/domains/register-one (Porkbun BUY — real money)
//   3. POST /api/domains/inventory/sync (once — so account resolution works)
//   4. POST /api/inbox-orders         (Inboxing mailboxes on the right instance)
// Reject = proposal closed, nothing bought.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, ShoppingCart, Check, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PurchaseProposal } from "@/lib/replacement/purchase-proposal";

const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH1", cleaningoutbound: "CO1", facilityreach: "FR2", outboundclean: "OC2",
};
const PORKBUN_PACE_MS = 10_500; // Porkbun: 1 call / 10s per account

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return { ok: false, data, error: (data?.error as string) || `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : "request failed" };
  }
}

export function PurchaseProposalCard() {
  const [proposals, setProposals] = useState<PurchaseProposal[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [running, setRunning] = useState<number | null>(null); // proposal id being executed
  const [progress, setProgress] = useState<Record<string, string>>({}); // domain -> status
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/replacement/purchase-proposals", { cache: "no-store" });
      const d = await res.json();
      if (d?.error) throw new Error(d.error);
      setProposals(d.proposals || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0); // deferred initial load
    return () => clearTimeout(id);
  }, [load]);

  const generate = async () => {
    setGenerating(true); setError(null);
    const res = await post("/api/replacement/purchase-proposals", { action: "generate" });
    if (!res.ok) setError(res.error || "Generate failed");
    setGenerating(false);
    load();
  };

  const reject = async (p: PurchaseProposal) => {
    await post("/api/replacement/purchase-proposals", { action: "decide", id: p.id, status: "rejected" });
    load();
  };

  const approve = async (p: PurchaseProposal) => {
    if (!window.confirm(`Buy up to ${p.domains.length} domains for ${p.instance}? This spends real money (Porkbun registration + Inboxing mailboxes).`)) return;
    setRunning(p.id); setError(null);
    const results: Record<string, string> = {};
    const set = (d: string, s: string) => { results[d] = s; setProgress({ ...results }); };

    // 1+2) Porkbun check + register, paced (both calls hit Porkbun's 1/10s limit)
    const registered: string[] = [];
    for (const domain of p.domains) {
      set(domain, "checking…");
      const chk = await post("/api/domains/check", { domain });
      if (!chk.ok) { set(domain, `check failed: ${chk.error}`); await sleep(PORKBUN_PACE_MS); continue; }
      const avail = (chk.data?.qualifies ?? chk.data?.available) === true;
      if (!avail) { set(domain, "taken — skipped"); await sleep(PORKBUN_PACE_MS); continue; }
      await sleep(PORKBUN_PACE_MS);
      set(domain, "registering…");
      const reg = await post("/api/domains/register-one", { domain });
      if (!reg.ok) { set(domain, `register failed: ${reg.error}`); await sleep(PORKBUN_PACE_MS); continue; }
      registered.push(domain);
      set(domain, "registered ✓");
      await sleep(PORKBUN_PACE_MS);
    }

    // 3) refresh the All Domains inventory once so account resolution knows them
    if (registered.length > 0) {
      const sync = await post("/api/domains/inventory/sync", {});
      if (!sync.ok) setError(`Inventory sync failed (${sync.error}) — orders may be blocked; retry from the All Domains page.`);
    }

    // 4) Inboxing mailbox order per registered domain, routed to the instance
    for (const domain of registered) {
      set(domain, "ordering mailboxes…");
      const ord = await post("/api/inbox-orders", { provider: "inboxing", instance: p.instance, domain });
      set(domain, ord.ok ? "ordered ✓" : `order failed: ${ord.error}`);
    }

    await post("/api/replacement/purchase-proposals", { action: "decide", id: p.id, status: "approved", results });
    setRunning(null);
    load();
  };

  const pending = (proposals || []).filter((x) => x.status === "pending");
  const decided = (proposals || []).filter((x) => x.status !== "pending").slice(0, 5);

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShoppingCart className="h-4 w-4" />
              Purchase proposals — approve to buy
            </div>
            <div className="text-[11px] text-muted-foreground">
              Staged .com/.co buys when reserve is short. Nothing is purchased until Approve is clicked here.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={generate} disabled={generating || running !== null} className="gap-2">
              {generating ? "Proposing…" : "Propose now"}
            </Button>
            <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div>}

        {proposals && pending.length === 0 && (
          <div className="text-xs text-muted-foreground italic">No pending proposals. The weekday cron (or “Propose now”) stages one when an instance is short.</div>
        )}

        {pending.map((p) => (
          <div key={p.id} className="rounded-xl border p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-amber-500/30 text-amber-500">pending</Badge>
              <span className="text-sm font-medium">{INSTANCE_SHORT[p.instance] ?? p.instance}</span>
              <span className="text-xs text-muted-foreground">{p.domains.length} domains · {p.note}</span>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" onClick={() => approve(p)} disabled={running !== null} className="gap-1.5 h-8">
                  <Check className="h-3.5 w-3.5" /> {running === p.id ? "Buying…" : "Approve & buy"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => reject(p)} disabled={running !== null} className="gap-1.5 h-8 text-destructive">
                  <X className="h-3.5 w-3.5" /> Reject
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {p.domains.map((d) => (
                <span key={d} className="text-[11px] font-mono text-muted-foreground">
                  {d}
                  {running === p.id && progress[d] && <span className="ml-1 text-foreground">— {progress[d]}</span>}
                </span>
              ))}
            </div>
            {running === p.id && (
              <div className="text-[11px] text-muted-foreground">
                Porkbun is rate-limited to 1 call / 10s — a {p.domains.length}-domain batch takes ~{Math.ceil(p.domains.length * 2 * 10.5 / 60)} min. Keep this tab open.
              </div>
            )}
          </div>
        ))}

        {decided.length > 0 && (
          <div className="space-y-1">
            {decided.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="outline" className={p.status === "approved" ? "border-emerald-500/30 text-emerald-500" : "border-muted-foreground/30"}>{p.status}</Badge>
                <span>{INSTANCE_SHORT[p.instance] ?? p.instance} · {p.domains.length} domains · {new Date(p.createdAt).toLocaleDateString()}</span>
                {p.results && <span>· {Object.values(p.results).filter((s) => s === "ordered ✓").length} ordered</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
