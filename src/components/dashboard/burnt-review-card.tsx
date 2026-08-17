"use client";

// Dashboard review queue: burnt domains waiting to be deleted at their vendor.
// Nick 2026-08-17 asked to see these on the homepage and approve them before
// anything is deleted, with the provider cancellation going out automatically
// on approval.
//
// What approval actually does: the row's status decides whether the hourly
// cancel-bridge picks it up. Approve → 'pending' (bridge fires it: vendor
// cancel → 10-min buffer → Bison sender delete). Reject → 'aborted', never
// fired. Hold → parked until someone comes back to it.
//
// Read the note in the card: a row left alone still auto-fires after its 5-day
// grace, because that is what Spencer signed off in June. This queue lets a
// human get ahead of that; it does not by itself make approval mandatory.
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Flame, Check, X, PauseCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Cancellation {
  instance: string;
  domain: string;
  clientTag: string | null;
  provider: string | null;
  reason: string | null;
  scheduledAt: string;
  status: string;
}

const INSTANCE_LABEL: Record<string, string> = {
  outboundhero: "B2B #1",
  cleaningoutbound: "B2C #1",
  facilityreach: "B2B #2",
  outboundclean: "B2C #2",
};

function dueIn(scheduledAt: string): { text: string; urgent: boolean } {
  const ms = new Date(scheduledAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: "—", urgent: false };
  if (ms <= 0) return { text: "due now", urgent: true };
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return { text: `in ${hours}h`, urgent: true };
  return { text: `in ${Math.round(hours / 24)}d`, urgent: false };
}

export function BurntReviewCard() {
  const [rows, setRows] = useState<Cancellation[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const key = (r: Cancellation) => `${r.instance}:${r.domain}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/replacement/cancellations?status=pending,held,stale-hold", {
        cache: "no-store",
      });
      const json = await res.json();
      setRows(json.cancellations || []);
    } catch {
      /* card self-hides if this fails — never block the dashboard */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (decision: "approve" | "reject" | "hold") => {
    const targets = rows.filter((r) => sel.has(key(r)));
    if (targets.length === 0) return;
    setBusy(decision);
    setErr(null);
    try {
      const res = await fetch("/api/replacement/cancellations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          domains: targets.map((r) => ({ instance: r.instance, domain: r.domain })),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Failed");
      setSel(new Set());
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return null;

  const awaiting = rows.filter((r) => r.status !== "aborted");

  return (
    <div className="rounded-xl border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-950/30 p-5">
      <div className="flex items-start gap-4">
        <Flame className="h-7 w-7 text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-3">
          <div>
            <h2 className="text-xl font-bold text-red-900 dark:text-red-100">
              Burnt domains awaiting deletion — {awaiting.length}
            </h2>
            <p className="text-sm text-red-700 dark:text-red-400 mt-0.5">
              Approving sends the vendor cancellation and deletes the senders in Bison. Rejecting
              keeps the domain. Anything left alone still auto-fires when its grace period ends —
              full history on the{" "}
              <Link href="/replacement" className="underline font-medium">
                Replacement
              </Link>{" "}
              page.
            </p>
          </div>

          {err && <p className="text-sm font-medium text-red-700 dark:text-red-300">{err}</p>}

          <div className="rounded-lg border border-red-300/60 dark:border-red-700/60 bg-white/50 dark:bg-black/20 divide-y divide-red-300/30 dark:divide-red-700/30">
            {awaiting.map((r) => {
              const k = key(r);
              const due = dueIn(r.scheduledAt);
              return (
                <label key={k} className="flex items-center gap-3 px-3 py-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={sel.has(k)}
                    onChange={(e) => {
                      const next = new Set(sel);
                      if (e.target.checked) next.add(k);
                      else next.delete(k);
                      setSel(next);
                    }}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="font-medium text-red-900 dark:text-red-100">{r.domain}</span>
                  {r.clientTag && (
                    <span className="text-[11px] text-muted-foreground">{r.clientTag}</span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {INSTANCE_LABEL[r.instance] || r.instance}
                  </span>
                  {r.provider && (
                    <span className="text-[11px] text-muted-foreground">{r.provider}</span>
                  )}
                  <span className="ml-auto flex items-center gap-2 text-[11px]">
                    {r.status !== "pending" && (
                      <span className="rounded bg-red-200/60 dark:bg-red-800/40 px-1.5 py-0.5">
                        {r.status}
                      </span>
                    )}
                    <span
                      className={
                        due.urgent
                          ? "font-semibold text-red-700 dark:text-red-300"
                          : "text-muted-foreground"
                      }
                    >
                      {due.text}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{sel.size} selected</span>
            <Button
              size="sm"
              className="ml-auto h-7 gap-1.5 text-xs"
              disabled={busy !== null || sel.size === 0}
              onClick={() => decide("approve")}
            >
              {busy === "approve" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Approve &amp; delete
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={busy !== null || sel.size === 0}
              onClick={() => decide("hold")}
            >
              {busy === "hold" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <PauseCircle className="h-3 w-3" />
              )}
              Hold
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={busy !== null || sel.size === 0}
              onClick={() => decide("reject")}
            >
              {busy === "reject" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
              Keep domain
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
