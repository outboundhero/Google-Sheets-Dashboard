"use client";

// Deliverability "Domains" section: Porkbun domains expiring within 10 days
// (both accounts). Collapsed by default, lazy-loaded. Copy-all, drag-select,
// and bulk actions (auto-renew on/off, cancel at Inboxing/MilkBox). The actual
// workflows run through the page's persistent progress panels via props.
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, Globe, Copy, Check, RotateCw, Ban, AlertTriangle } from "lucide-react";

type Provider = "inboxing" | "milkbox" | "scaledmail" | null;
interface ExpiringDomain {
  account: string; domain: string; tld: string; expireDate: string;
  daysLeft: number; autoRenew: boolean; estRenewal: number | null; provider: Provider;
}
interface AccountInfo { label: string; ok: boolean; error?: string }

interface Props {
  onAutoRenew: (items: { account: string; domain: string }[], enabled: boolean) => void;
  onCancel: (domains: string[]) => void;
}

const accountShort: Record<string, string> = { "Porkbun 1": "PB1", "Porkbun 2": "PB2" };
const accountAccent: Record<string, string> = {
  "Porkbun 1": "bg-violet-500/15 text-violet-500 border-violet-500/30",
  "Porkbun 2": "bg-sky-500/15 text-sky-500 border-sky-500/30",
};
const providerMeta: Record<string, { label: string; cls: string }> = {
  inboxing: { label: "Inboxing", cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
  milkbox: { label: "MilkBox", cls: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  scaledmail: { label: "ScaledMail", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

function fmtDate(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ExpiringDomainsSection({ onAutoRenew, onCancel }: Props) {
  const [open, setOpen] = useState(false);
  const [domains, setDomains] = useState<ExpiringDomain[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key = account:domain
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dragging = useRef(false);
  const dragAdd = useRef(true);
  const loadedRef = useRef(false);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/deliverability/expiring-domains${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      const d = await res.json();
      if (res.ok) { setDomains(d.domains || []); setAccounts(d.accounts || []); setError(null); }
      else setError(d.error || "Failed");
    } catch { setError("Failed to load"); }
  }, []);

  const refresh = useCallback(async () => { setLoading(true); await load(true); setLoading(false); }, [load]);

  // Lazy load: the two-account Porkbun crawl only runs the first time the
  // section is expanded (+ on Refresh) — never on every page visit.
  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next && !loadedRef.current) { loadedRef.current = true; setLoading(true); load().finally(() => setLoading(false)); }
      return next;
    });
  }, [load]);

  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const applyDrag = (k: string) => setSelected((s) => { const n = new Set(s); if (dragAdd.current) n.add(k); else n.delete(k); return n; });
  const startDrag = (k: string) => { dragging.current = true; dragAdd.current = !selected.has(k); applyDrag(k); };

  const selectedItems = domains.filter((d) => selected.has(`${d.account}:${d.domain}`));
  const cancelable = selectedItems.filter((d) => d.provider === "inboxing" || d.provider === "milkbox");
  const loadErrors = accounts.filter((a) => !a.ok);

  const copyAll = () => {
    navigator.clipboard.writeText(domains.map((d) => d.domain).join("\n"));
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const doAutoRenew = (enabled: boolean) => {
    if (selectedItems.length === 0) return;
    onAutoRenew(selectedItems.map((d) => ({ account: d.account, domain: d.domain })), enabled);
    // Optimistic: flip the AR badge now; the panel drives the real update.
    const keys = new Set(selectedItems.map((d) => `${d.account}:${d.domain}`));
    setDomains((prev) => prev.map((d) => (keys.has(`${d.account}:${d.domain}`) ? { ...d, autoRenew: enabled } : d)));
    setSelected(new Set());
  };

  const doCancel = () => {
    if (cancelable.length === 0) return;
    onCancel([...new Set(cancelable.map((d) => d.domain))]);
    setSelected(new Set());
  };

  return (
    <div className="rounded-xl border bg-card">
      <button onClick={toggleOpen} className="w-full flex items-center gap-2 px-5 py-3 text-left">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Globe className="h-4 w-4 text-orange-400 shrink-0" />
        <span className="text-sm font-medium">Domains</span>
        <span className="text-[11px] text-muted-foreground">· expiring ≤ 10 days</span>
        {domains.length > 0 && <span className="text-xs rounded-full bg-orange-500/15 text-orange-400 px-2 py-0.5">{domains.length}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "collapse" : "expand"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Porkbun domains expiring within 10 days (both accounts). Click to select (drag to multi-select), then toggle auto-renew or cancel at the provider.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={copyAll} disabled={domains.length === 0} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50">
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied!" : "Copy all"}
              </button>
              <button onClick={refresh} disabled={loading} className="flex items-center gap-1.5 text-xs rounded-md border px-2.5 py-1.5 hover:bg-muted/50 disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </button>
            </div>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}
          {loadErrors.length > 0 && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>Couldn&apos;t load {loadErrors.map((a) => a.label).join(", ")} — list may be incomplete.</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading domains…</div>
          ) : domains.length === 0 ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">No domains expiring in the next 10 days. ✓</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs gap-2">
                <span className="text-muted-foreground shrink-0">{selected.size} selected</span>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <button onClick={() => doAutoRenew(true)} disabled={selectedItems.length === 0} className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 text-emerald-500 px-2.5 py-1.5 hover:bg-emerald-500/10 disabled:opacity-40">
                    <RotateCw className="h-3.5 w-3.5" /> Auto-renew On
                  </button>
                  <button onClick={() => doAutoRenew(false)} disabled={selectedItems.length === 0} className="flex items-center gap-1.5 rounded-md border border-amber-500/40 text-amber-500 px-2.5 py-1.5 hover:bg-amber-500/10 disabled:opacity-40">
                    <RotateCw className="h-3.5 w-3.5" /> Auto-renew Off
                  </button>
                  <button
                    onClick={doCancel}
                    disabled={cancelable.length === 0}
                    title={selectedItems.length > 0 && cancelable.length === 0 ? "No selected domain is on Inboxing/MilkBox" : "Cancel the selected Inboxing/MilkBox domains at the provider"}
                    className="flex items-center gap-1.5 rounded-md bg-destructive/90 text-destructive-foreground px-2.5 py-1.5 hover:bg-destructive disabled:opacity-40"
                  >
                    <Ban className="h-3.5 w-3.5" /> Cancel {cancelable.length > 0 ? cancelable.length : ""} at provider
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-[52px_minmax(0,1fr)_96px_150px_64px_78px_16px] gap-3 px-3 pb-1 text-[9px] uppercase tracking-wide text-muted-foreground/50">
                <span>Acct</span><span>Domain</span><span>Provider</span><span>Expiry</span><span>Renew</span><span className="justify-self-end">Est.</span><span />
              </div>
              <div className="rounded-lg border divide-y max-h-[440px] overflow-y-auto scrollbar-hide select-none">
                {domains.map((d) => {
                  const k = `${d.account}:${d.domain}`;
                  const sel = selected.has(k);
                  const prov = d.provider ? providerMeta[d.provider] : null;
                  const dayCls = d.daysLeft <= 0 ? "text-destructive" : d.daysLeft <= 3 ? "text-amber-500" : "text-muted-foreground";
                  return (
                    <div
                      key={k}
                      onMouseDown={() => startDrag(k)}
                      onMouseEnter={() => { if (dragging.current) applyDrag(k); }}
                      title={sel ? "Selected" : "Click to select"}
                      className={`group grid grid-cols-[52px_minmax(0,1fr)_96px_150px_64px_78px_16px] items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${sel ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : "hover:bg-muted/50"}`}
                    >
                      <span className={`justify-self-start text-[10px] font-medium rounded border px-1.5 py-0.5 ${accountAccent[d.account] ?? "bg-muted text-muted-foreground border-border"}`} title={d.account}>
                        {accountShort[d.account] ?? d.account}
                      </span>
                      <span className="text-xs font-medium truncate select-text cursor-text" title={d.domain}>{d.domain}</span>
                      {prov ? (
                        <span className={`justify-self-start text-[10px] font-medium rounded border px-1.5 py-0.5 ${prov.cls}`}>{prov.label}</span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/50">—</span>
                      )}
                      <span className="text-[11px] whitespace-nowrap">
                        {fmtDate(d.expireDate)} <span className={dayCls}>· in {d.daysLeft}d</span>
                      </span>
                      <span className={`justify-self-start text-[10px] font-medium rounded px-1.5 py-0.5 ${d.autoRenew ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
                        {d.autoRenew ? "On" : "Off"}
                      </span>
                      <span className="text-[11px] text-foreground/80 justify-self-end whitespace-nowrap">
                        {d.estRenewal != null ? `$${d.estRenewal.toFixed(2)}` : "—"}
                      </span>
                      <span className={`justify-self-end transition-colors ${sel ? "text-primary" : "text-muted-foreground/25 group-hover:text-muted-foreground"}`}>
                        {sel ? <Check className="h-3.5 w-3.5" /> : <span className="block h-3 w-3 rounded-full border border-current" />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
