"use client";

import { useState, useMemo, useEffect } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  Replace,
  Link as LinkIcon,
  Flag,
  Loader2,
  ExternalLink,
  Upload,
} from "lucide-react";
import { BulkCreateInboxOrdersDialog } from "@/components/deliverability/bulk-create-inbox-orders-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/page-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInboxOrders } from "@/lib/hooks/use-inbox-orders";
import type { InboxOrder, InboxOrderProvider, InboxOrderAlias } from "@/types/inbox-order";
import { useAuth } from "@/lib/auth-context";
import { useInstance } from "@/lib/instance-context";
import { BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";

const PROVIDER_LABEL: Record<InboxOrderProvider, string> = {
  scaledmail: "ScaledMail",
  milkbox: "MilkBox",
  inboxing: "Inboxing",
};

const PROVIDER_MAILBOXES: Record<InboxOrderProvider, number> = {
  scaledmail: 25,
  milkbox: 50,
  inboxing: 49,
};

function statusBadgeVariant(status: InboxOrder["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "active") return "default";
  if (status === "failed") return "destructive";
  if (status === "deleted" || status === "swapped") return "outline";
  return "secondary";
}

export default function InboxOrdersPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const { instances: scopedInstances, instancesQuery } = useInstance();
  const { orders, isLoading, mutate } = useInboxOrders(60_000, instancesQuery);

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [provider, setProvider] = useState<InboxOrderProvider>("scaledmail");
  const [orderInstance, setOrderInstance] = useState<BisonInstanceSlug>(
    scopedInstances[0]?.slug ?? "outboundhero"
  );
  const [domain, setDomain] = useState("");
  const [tag, setTag] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [clientTag, setClientTag] = useState("");
  // Sender-name controls: auto female name(s) vs manual, 1 or 2 personas, and
  // an editable preview of the generated names/aliases before placing the order.
  const [autoNames, setAutoNames] = useState(true);
  const [personaCount, setPersonaCount] = useState<1 | 2>(1);
  const [manualNames, setManualNames] = useState<{ first_name: string; last_name: string }[]>([
    { first_name: "", last_name: "" },
    { first_name: "", last_name: "" },
  ]);
  const [previewAliases, setPreviewAliases] = useState<InboxOrderAlias[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Inboxing only: which Porkbun account the domain belongs to (drives registrar).
  const [domainAccount, setDomainAccount] = useState<{ accountLabel: string | null; ok: boolean; reason: string | null } | null>(null);

  // Resolve the entered domain's Porkbun account (Inboxing orders only).
  useEffect(() => {
    if (provider !== "inboxing" || !domain.trim()) { setDomainAccount(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetch("/api/inbox-orders/resolve-accounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: [domain.trim().toLowerCase()] }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!alive || !Array.isArray(d.results) || !d.results[0]) return;
          const x = d.results[0];
          setDomainAccount({ accountLabel: x.accountLabel, ok: x.ok, reason: x.reason });
        })
        .catch(() => {});
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [provider, domain]);

  const [redirectFor, setRedirectFor] = useState<InboxOrder | null>(null);
  const [redirectInput, setRedirectInput] = useState("");
  const [redirectSaving, setRedirectSaving] = useState(false);

  const [swapFor, setSwapFor] = useState<InboxOrder | null>(null);
  const [swapInput, setSwapInput] = useState("");
  const [swapSaving, setSwapSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const counts = { scaledmail: 0, milkbox: 0, inboxing: 0, active: 0, pending: 0, failed: 0, flagged: 0 };
    for (const o of orders) {
      counts[o.provider]++;
      if (o.status === "active") counts.active++;
      else if (o.status === "pending" || o.status === "swapping" || o.status === "deleting") counts.pending++;
      else if (o.status === "failed") counts.failed++;
      if (o.flagged_at) counts.flagged++;
    }
    return counts;
  }, [orders]);

  // Names entered/kept for the current settings (used by preview + submit).
  const manualNameSpec = () => manualNames.slice(0, personaCount).map((n) => ({ first_name: n.first_name.trim(), last_name: n.last_name.trim() }));

  async function previewNames() {
    setPreviewing(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/inbox-orders/preview-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          nameMode: autoNames ? "auto" : "manual",
          personaCount,
          names: autoNames ? undefined : manualNameSpec(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Preview failed");
      setPreviewAliases(json.aliases as InboxOrderAlias[]);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  function editAlias(i: number, field: keyof InboxOrderAlias, value: string) {
    setPreviewAliases((prev) => (prev ? prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)) : prev));
  }

  function resetCreateFields() {
    setDomain("");
    setTag("");
    setCompanyName("");
    setClientTag("");
    setAutoNames(true);
    setPersonaCount(1);
    setManualNames([{ first_name: "", last_name: "" }, { first_name: "", last_name: "" }]);
    setPreviewAliases(null);
  }

  async function submitCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/inbox-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          instance: orderInstance,
          domain: domain.trim().toLowerCase(),
          tag: tag.trim() || undefined,
          companyName: companyName.trim() || undefined,
          clientTag: clientTag.trim() || undefined,
          // Finalized (possibly edited) names if previewed, else the settings.
          ...(previewAliases && previewAliases.length > 0
            ? { aliases: previewAliases }
            : { nameMode: autoNames ? "auto" : "manual", personaCount, names: autoNames ? undefined : manualNameSpec() }),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Create failed");
      setCreateOpen(false);
      resetCreateFields();
      await mutate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function refreshOne(order: InboxOrder) {
    setBusyId(order.id);
    try {
      await fetch(`/api/inbox-orders/${order.id}/refresh`);
      await mutate();
    } finally {
      setBusyId(null);
    }
  }

  async function submitRedirect() {
    if (!redirectFor) return;
    setRedirectSaving(true);
    try {
      const res = await fetch(`/api/inbox-orders/${redirectFor.id}/redirect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUrl: redirectInput.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json?.error || "Update redirect failed");
        return;
      }
      setRedirectFor(null);
      await mutate();
    } finally {
      setRedirectSaving(false);
    }
  }

  async function submitSwap() {
    if (!swapFor) return;
    setSwapSaving(true);
    try {
      const res = await fetch(`/api/inbox-orders/${swapFor.id}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newDomain: swapInput.trim().toLowerCase() }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json?.error || "Swap failed");
        return;
      }
      setSwapFor(null);
      setSwapInput("");
      await mutate();
    } finally {
      setSwapSaving(false);
    }
  }

  async function deleteOne(order: InboxOrder) {
    if (order.provider === "scaledmail") {
      alert("ScaledMail has no per-domain delete. Use Replace to swap to a fresh domain.");
      return;
    }
    if (!confirm(`Delete ${order.domain}? This destroys all ${order.mailbox_count} mailboxes.`)) return;
    setBusyId(order.id);
    try {
      const res = await fetch(`/api/inbox-orders/${order.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) alert(json?.error || "Delete failed");
      await mutate();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleFlag(order: InboxOrder) {
    setBusyId(order.id);
    try {
      await fetch(`/api/inbox-orders/${order.id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: !order.flagged_at }),
      });
      await mutate();
    } finally {
      setBusyId(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <PageHeader title="Inbox Orders" />
        <p className="text-muted-foreground text-sm">Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Inbox Orders" />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Create Order
        </Button>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>
          <Upload className="mr-1 h-4 w-4" /> Bulk Import
        </Button>
        <Button variant="outline" onClick={() => mutate()}>
          <RefreshCw className="mr-1 h-4 w-4" /> Refresh List
        </Button>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">SM: {grouped.scaledmail}</Badge>
          <Badge variant="outline">MB: {grouped.milkbox}</Badge>
          <Badge variant="outline">IB: {grouped.inboxing}</Badge>
          <Badge>Active: {grouped.active}</Badge>
          <Badge variant="secondary">Pending: {grouped.pending}</Badge>
          {grouped.failed > 0 && <Badge variant="destructive">Failed: {grouped.failed}</Badge>}
          {grouped.flagged > 0 && <Badge variant="destructive">Flagged: {grouped.flagged}</Badge>}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left p-2 font-medium">Domain</th>
              <th className="text-left p-2 font-medium">Instance</th>
              <th className="text-left p-2 font-medium">Provider</th>
              <th className="text-left p-2 font-medium">Status</th>
              <th className="text-left p-2 font-medium">Mailboxes</th>
              <th className="text-left p-2 font-medium">Redirect</th>
              <th className="text-left p-2 font-medium">Client</th>
              <th className="text-left p-2 font-medium">Created</th>
              <th className="text-left p-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">
                  <Loader2 className="inline h-4 w-4 animate-spin" /> Loading...
                </td>
              </tr>
            )}
            {!isLoading && orders.length === 0 && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">
                  No orders yet. Click &quot;Create Order&quot; to start.
                </td>
              </tr>
            )}
            {orders.map((order) => (
              <tr
                key={order.id}
                className={
                  "border-t " + (order.flagged_at ? "bg-destructive/5" : "")
                }
              >
                <td className="p-2 font-mono text-xs">
                  {order.domain}
                  {order.flagged_at && (
                    <Badge variant="destructive" className="ml-2 text-[10px]">flagged</Badge>
                  )}
                </td>
                <td className="p-2 text-xs">
                  {BISON_INSTANCES[order.instance]?.label ?? order.instance}
                </td>
                <td className="p-2">{PROVIDER_LABEL[order.provider]}</td>
                <td className="p-2">
                  <Badge variant={statusBadgeVariant(order.status)}>
                    {order.status}
                  </Badge>
                  {order.setup_stage && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">{order.setup_stage}</div>
                  )}
                  {order.failure_reason && (
                    <div className="text-[10px] text-destructive mt-0.5">{order.failure_reason}</div>
                  )}
                </td>
                <td className="p-2">{order.mailbox_count}</td>
                <td className="p-2 max-w-[200px] truncate">
                  {order.redirect_url ? (
                    <a
                      href={order.redirect_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
                    >
                      {order.redirect_url.replace(/^https?:\/\//, "")}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-2">{order.client_tag || <span className="text-muted-foreground">—</span>}</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {new Date(order.created_at).toLocaleString()}
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === order.id}
                      title="Refresh status"
                      onClick={() => refreshOne(order)}
                    >
                      {busyId === order.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={order.flagged_at ? "Unflag" : "Mark flagged"}
                      onClick={() => toggleFlag(order)}
                    >
                      <Flag className={order.flagged_at ? "h-3.5 w-3.5 text-destructive fill-destructive" : "h-3.5 w-3.5"} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Update redirect URL"
                      onClick={() => {
                        setRedirectFor(order);
                        setRedirectInput(order.redirect_url || "");
                      }}
                    >
                      <LinkIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title={
                        order.provider === "scaledmail"
                          ? "Replace (swap to fresh domain)"
                          : "Swap to new domain"
                      }
                      onClick={() => {
                        setSwapFor(order);
                        setSwapInput("");
                      }}
                    >
                      <Replace className="h-3.5 w-3.5" />
                    </Button>
                    {order.provider !== "scaledmail" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Delete this domain"
                        disabled={busyId === order.id}
                        onClick={() => deleteOne(order)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Order dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Inbox Order</DialogTitle>
            <DialogDescription>
              Provisions {PROVIDER_MAILBOXES[provider]} Outlook mailboxes on the chosen domain.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium">Provider</label>
              <Select value={provider} onValueChange={(v) => { setProvider(v as InboxOrderProvider); setPreviewAliases(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="scaledmail">ScaledMail (25 mailboxes)</SelectItem>
                  <SelectItem value="milkbox">MilkBox (50 mailboxes)</SelectItem>
                  <SelectItem value="inboxing">Inboxing (49 mailboxes)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium">Bison instance</label>
              <Select value={orderInstance} onValueChange={(v) => setOrderInstance(v as BisonInstanceSlug)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.values(BISON_INSTANCES).map((inst) => (
                    <SelectItem key={inst.slug} value={inst.slug}>
                      {inst.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                The Bison instance this order will be associated with.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium">Domain</label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="cleaninggrid7.com"
                autoComplete="off"
              />
              {provider === "inboxing" && domain.trim() && domainAccount ? (
                domainAccount.ok ? (
                  <p className="text-[11px] text-emerald-500 mt-1">
                    Porkbun account: <span className="font-medium">{domainAccount.accountLabel}</span> — the matching registrar will be used.
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-500 mt-1">
                    ⚠ Can&apos;t determine the Porkbun account — {domainAccount.reason || "not in All Domains inventory"}. Run Refresh Porkbun first, or the order will fail.
                  </p>
                )
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Must already be owned in your Porkbun account.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium">
                  {provider === "milkbox" ? "Company name (required)" : "Tag (optional)"}
                </label>
                {provider === "milkbox" ? (
                  <Input
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="BHS"
                  />
                ) : (
                  <Input
                    value={tag}
                    onChange={(e) => setTag(e.target.value.slice(0, 20))}
                    placeholder="campaign-q2"
                    maxLength={20}
                  />
                )}
              </div>
              <div>
                <label className="text-xs font-medium">Client tag (optional)</label>
                <Input
                  value={clientTag}
                  onChange={(e) => setClientTag(e.target.value)}
                  placeholder="BHS"
                />
              </div>
            </div>
            {/* Sender names */}
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={autoNames}
                  onChange={(e) => { setAutoNames(e.target.checked); setPreviewAliases(null); }}
                />
                Auto-generate female names
              </label>
              {autoNames ? (
                <p className="text-[11px] text-muted-foreground">Every mailbox gets its own unique name — no two mailboxes share a name.</p>
              ) : (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Number of names:</span>
                  {[1, 2].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => { setPersonaCount(n as 1 | 2); setPreviewAliases(null); }}
                      className={`rounded border px-2 py-0.5 ${personaCount === n ? "bg-primary text-primary-foreground border-primary" : "border-muted-foreground/30 hover:bg-muted/50"}`}
                    >
                      {n}
                    </button>
                  ))}
                  <span className="text-[11px] text-muted-foreground">
                    {personaCount === 1 ? "all mailboxes use one name" : "mailboxes split 50/50 across two names"}
                  </span>
                </div>
              )}
              {!autoNames && (
                <div className="space-y-2">
                  {Array.from({ length: personaCount }).map((_, i) => (
                    <div key={i} className="grid grid-cols-2 gap-2">
                      <Input
                        className="h-8"
                        placeholder={`First name ${personaCount === 2 ? i + 1 : ""}`.trim()}
                        value={manualNames[i]?.first_name || ""}
                        onChange={(e) => { setManualNames((p) => { const n = [...p]; n[i] = { ...(n[i] || { first_name: "", last_name: "" }), first_name: e.target.value }; return n; }); setPreviewAliases(null); }}
                      />
                      <Input
                        className="h-8"
                        placeholder={`Last name ${personaCount === 2 ? i + 1 : ""}`.trim()}
                        value={manualNames[i]?.last_name || ""}
                        onChange={(e) => { setManualNames((p) => { const n = [...p]; n[i] = { ...(n[i] || { first_name: "", last_name: "" }), last_name: e.target.value }; return n; }); setPreviewAliases(null); }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={previewNames}
                  disabled={previewing || (!autoNames && manualNames.slice(0, personaCount).some((n) => !n.first_name.trim() || !n.last_name.trim()))}
                >
                  {previewing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  {previewAliases ? "Regenerate" : "Preview names"}
                </Button>
                {previewAliases && (
                  <span className="text-[11px] text-muted-foreground">{previewAliases.length} mailboxes — edit below</span>
                )}
              </div>
              {previewAliases && (
                <div className="max-h-52 overflow-y-auto rounded border divide-y">
                  {previewAliases.map((a, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1.6fr] gap-1 px-2 py-1 items-center">
                      <Input className="h-7 text-xs" value={a.first_name} onChange={(e) => editAlias(i, "first_name", e.target.value)} />
                      <Input className="h-7 text-xs" value={a.last_name} onChange={(e) => editAlias(i, "last_name", e.target.value)} />
                      <div className="flex items-center gap-1 min-w-0">
                        <Input className="h-7 text-xs" value={a.alias} onChange={(e) => editAlias(i, "alias", e.target.value)} />
                        <span className="text-[10px] text-muted-foreground truncate">@{domain.trim() || "domain"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              disabled={creating || !domain.trim() || (provider === "milkbox" && !companyName.trim())}
            >
              {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Create Order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Update redirect dialog */}
      <Dialog open={!!redirectFor} onOpenChange={(v) => !v && setRedirectFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Redirect</DialogTitle>
            <DialogDescription>
              Change the URL visitors are redirected to when they open {redirectFor?.domain}.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={redirectInput}
            onChange={(e) => setRedirectInput(e.target.value)}
            placeholder="https://example.com"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRedirectFor(null)} disabled={redirectSaving}>
              Cancel
            </Button>
            <Button onClick={submitRedirect} disabled={redirectSaving || !redirectInput.trim()}>
              {redirectSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Swap domain dialog */}
      <Dialog open={!!swapFor} onOpenChange={(v) => !v && setSwapFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {swapFor?.provider === "scaledmail" ? "Replace Domain" : "Swap Domain"}
            </DialogTitle>
            <DialogDescription>
              Replace {swapFor?.domain} with a fresh Porkbun domain.
              {swapFor?.provider === "inboxing" && " (Inboxing emulates swap as delete + create.)"}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={swapInput}
            onChange={(e) => setSwapInput(e.target.value)}
            placeholder="new-domain.com"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwapFor(null)} disabled={swapSaving}>
              Cancel
            </Button>
            <Button onClick={submitSwap} disabled={swapSaving || !swapInput.trim()}>
              {swapSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk import dialog (CSV / paste) */}
      <BulkCreateInboxOrdersDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onComplete={() => mutate()}
        defaultInstance={orderInstance}
      />
    </div>
  );
}
