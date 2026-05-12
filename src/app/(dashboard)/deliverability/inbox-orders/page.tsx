"use client";

import { useState, useMemo } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  Replace,
  Link as LinkIcon,
  Flag,
  Loader2,
  ExternalLink,
} from "lucide-react";
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
import type { InboxOrder, InboxOrderProvider } from "@/types/inbox-order";
import { useAuth } from "@/lib/auth-context";

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
  const { orders, isLoading, mutate } = useInboxOrders(60_000);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [provider, setProvider] = useState<InboxOrderProvider>("scaledmail");
  const [domain, setDomain] = useState("");
  const [tag, setTag] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [clientTag, setClientTag] = useState("");

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

  async function submitCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/inbox-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          domain: domain.trim().toLowerCase(),
          tag: tag.trim() || undefined,
          companyName: companyName.trim() || undefined,
          clientTag: clientTag.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Create failed");
      setCreateOpen(false);
      setDomain("");
      setTag("");
      setCompanyName("");
      setClientTag("");
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
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  <Loader2 className="inline h-4 w-4 animate-spin" /> Loading...
                </td>
              </tr>
            )}
            {!isLoading && orders.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  No orders yet. Click "Create Order" to start.
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
              <Select value={provider} onValueChange={(v) => setProvider(v as InboxOrderProvider)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="scaledmail">ScaledMail (25 mailboxes)</SelectItem>
                  <SelectItem value="milkbox">MilkBox (50 mailboxes)</SelectItem>
                  <SelectItem value="inboxing">Inboxing (49 mailboxes)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium">Domain</label>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="cleaninggrid7.com"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Must already be owned in your Porkbun account.
              </p>
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
    </div>
  );
}
