"use client";

// Dashboard card: domains whose redirect doesn't match the Client Tracker website.
// Spencer approves (Fix → pushes change-redirect to the correct URL) or
// disapproves (Ignore → leaves it, stops showing). Multi-tag domains can't be
// auto-fixed (unknown which client) — Ignore only, with a note to fix manually.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertTriangle, ExternalLink, Check, X, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Issue { instance: string; domain: string; clientTag: string; current: string | null; expected: string | null; kind: "wrong" | "missing" | "multitag" }
interface AuditData { wrong: Issue[]; missing: Issue[]; multiTag: Issue[]; okCount: number; scanned: number }

const short: Record<string, string> = { outboundhero: "OH·B2B", cleaningoutbound: "CO·B2C", facilityreach: "FR·B2B", outboundclean: "OC·B2C" };
const withProto = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

export function RedirectIssuesCard() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/replacement/redirect-audit", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setData(d); else setError(d.error || "Failed to load");
    } catch { setError("Failed to load"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const key = (i: Issue) => `${i.instance}:${i.domain}`;
  const drop = (k: string) => setData((prev) => prev ? {
    ...prev,
    wrong: prev.wrong.filter((x) => key(x) !== k),
    missing: prev.missing.filter((x) => key(x) !== k),
    multiTag: prev.multiTag.filter((x) => key(x) !== k),
  } : prev);

  const record = (i: Issue, decision: "fixed" | "ignored") =>
    fetch("/api/replacement/redirect-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisions: [{ instance: i.instance, domain: i.domain, decision, expectedUrl: i.expected }] }) });

  const ignore = async (i: Issue) => {
    const k = key(i); setBusy((b) => new Set(b).add(k));
    await record(i, "ignored"); drop(k);
    setBusy((b) => { const n = new Set(b); n.delete(k); return n; });
  };

  const fix = async (i: Issue) => {
    if (!i.expected) return;
    const k = key(i); setBusy((b) => new Set(b).add(k)); setNotes((n) => ({ ...n, [k]: "" }));
    try {
      const res = await fetch("/api/deliverability/change-redirect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, domains: [i.domain], newUrl: withProto(i.expected) }),
      });
      const d = await res.json();
      const r = (d.results || d.domains || []).find?.((x: { domain?: string }) => x.domain === i.domain);
      const status = r?.status as string | undefined;
      if (res.ok && (status === "updated" || (!status && !d.error))) {
        await record(i, "fixed"); drop(k);
      } else {
        setNotes((n) => ({ ...n, [k]: r?.reason || d.error || `not updated (${status || "no provider API"})` }));
      }
    } catch (e) {
      setNotes((n) => ({ ...n, [k]: e instanceof Error ? e.message : "fix failed" }));
    }
    setBusy((b) => { const n = new Set(b); n.delete(k); return n; });
  };

  const fixAll = async (list: Issue[]) => { for (const i of list) await fix(i); };

  const total = data ? data.wrong.length + data.missing.length + data.multiTag.length : 0;

  const Row = ({ i }: { i: Issue }) => {
    const k = key(i); const isBusy = busy.has(k); const note = notes[k];
    return (
      <div className="grid grid-cols-[1fr_70px_1.4fr_120px] gap-2 px-3 py-2 text-xs items-center">
        <span className="truncate" title={i.domain}>{i.domain}<span className="text-muted-foreground ml-1">({i.clientTag})</span></span>
        <span className="text-muted-foreground">{short[i.instance] ?? i.instance}</span>
        <span className="truncate text-muted-foreground">
          {i.kind === "multitag" ? <span className="text-amber-500">multiple client tags — fix manually</span> : (<>
            <span className="text-red-400">{i.current ? i.current.replace(/^https?:\/\//, "") : "(none)"}</span>
            <span className="mx-1">→</span>
            <span className="text-emerald-500">{i.expected}</span>
          </>)}
          {note && <span className="block text-[10px] text-red-500 italic">{note}</span>}
        </span>
        <span className="flex items-center gap-1.5 justify-end">
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : (<>
            {i.kind !== "multitag" && (
              <button onClick={() => fix(i)} className="flex items-center gap-1 text-[11px] text-emerald-500 hover:underline"><Check className="h-3 w-3" />Fix</button>
            )}
            <button onClick={() => ignore(i)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><X className="h-3 w-3" />Ignore</button>
          </>)}
        </span>
      </div>
    );
  };

  const Section = ({ title, list, fixable }: { title: string; list: Issue[]; fixable?: boolean }) => list.length === 0 ? null : (
    <div>
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 text-[11px] font-medium sticky top-0">
        <span>{title} <span className="text-muted-foreground">({list.length})</span></span>
        {fixable && <button onClick={() => fixAll(list)} className="text-emerald-500 hover:underline">Fix all {list.length}</button>}
      </div>
      <div className="divide-y">{list.map((i) => <Row key={key(i)} i={i} />)}</div>
    </div>
  );

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 text-amber-500" />
            <div>
              <div className="text-sm font-medium">Redirect issues — domains not matching the Client Tracker</div>
              <div className="text-[11px] text-muted-foreground">Compared to the Client Tracker &ldquo;Website&rdquo; column. <b>Fix</b> pushes the correct redirect · <b>Ignore</b> leaves it as-is.</div>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> {loading ? "Checking…" : "Re-check"}
          </Button>
        </div>

        {error && <div className="flex items-center gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div>}

        {data && (
          total === 0 ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">All redirects match the Client Tracker. ✓ ({data.okCount} checked)</p>
          ) : (<>
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Wrong <b className="text-red-400">{data.wrong.length}</b></span>
              <span className="text-muted-foreground">Missing <b className="text-amber-500">{data.missing.length}</b></span>
              <span className="text-muted-foreground">Multi-tag <b className="text-amber-500">{data.multiTag.length}</b></span>
              <span className="text-muted-foreground">Correct <b className="text-emerald-500">{data.okCount}</b></span>
            </div>
            <div className="rounded-lg border divide-y max-h-[480px] overflow-y-auto">
              <Section title="Wrong — points to a different/incorrect URL" list={data.wrong} fixable />
              <Section title="Missing — no redirect set" list={data.missing} fixable />
              <Section title="Multiple client tags — needs manual fix" list={data.multiTag} />
            </div>
          </>)
        )}
      </CardContent>
    </Card>
  );
}
