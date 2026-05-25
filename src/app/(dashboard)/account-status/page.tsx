"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ALL_INSTANCE_SLUGS, BISON_INSTANCES, type BisonInstanceSlug } from "@/lib/bison-instances";

interface AccountEvent {
  instance: BisonInstanceSlug;
  sender_id: number;
  sender_email: string | null;
  sender_name: string | null;
  detected_at: string;
  reconnected_at?: string;
  reconnect_source?: "webhook" | "current_status" | "live_bison";
}

interface AccountStatusReport {
  date: string;
  totals: { disconnected: number; reconnected: number; failed: number };
  perInstance: { instance: BisonInstanceSlug; disconnected: number; reconnected: number; failed: number }[];
  disconnectedAccounts: AccountEvent[];
  reconnectedAccounts: AccountEvent[];
  failedAccounts: AccountEvent[];
  reconnectSources?: { webhook: number; current_status: number; live_bison: number };
  liveVerified?: boolean;
}

const PST_OFFSET_MS = 8 * 60 * 60 * 1000;
function todayPstDateString(): string {
  return new Date(Date.now() - PST_OFFSET_MS).toISOString().slice(0, 10);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default function AccountStatusPage() {
  const [date, setDate] = useState<string>(todayPstDateString());
  const [report, setReport] = useState<AccountStatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string, verify = false) => {
    if (verify) setVerifying(true);
    else setLoading(true);
    setError(null);
    try {
      const url = verify
        ? `/api/account-status?date=${d}&verify=1`
        : `/api/account-status?date=${d}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load report");
      if (!verify) setReport(null);
    } finally {
      setLoading(false);
      setVerifying(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const isToday = useMemo(() => date === todayPstDateString(), [date]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account Status"
        description={
          report
            ? `${report.totals.disconnected} disconnected · ${report.totals.reconnected} reconnected · ${report.totals.failed} failed`
            : "Daily disconnect / reconnect tracking across all 4 Bison instances"
        }
      >
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={todayPstDateString()}
            className="text-sm rounded-md border bg-background px-3 py-1.5"
          />
          {!isToday && (
            <Button variant="ghost" size="sm" onClick={() => setDate(todayPstDateString())}>
              Today
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => load(date)} disabled={loading || verifying} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(date, true)}
            disabled={loading || verifying || !report || report.totals.failed === 0}
            className="gap-2"
            title="Live-check each Failed account against Bison's current status"
          >
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {verifying ? "Verifying…" : "Verify with Bison"}
          </Button>
        </div>
      </PageHeader>

      {loading && !report && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3">
          <XCircle className="h-4 w-4 text-red-500 mt-0.5" />
          <div className="text-sm text-red-200">{error}</div>
        </div>
      )}

      {report && (
        <>
          {/* Note on detection method when we relied on cached status */}
          {(report.reconnectSources?.current_status ?? 0) > 0 && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">
              <strong>{report.reconnectSources?.current_status}</strong> reconnect{(report.reconnectSources?.current_status ?? 0) !== 1 ? "s" : ""} inferred from <em>cached</em> Bison status. These were marked disconnected today but the last sync shows them as connected. Click <em>Verify with Bison</em> for a live check.
            </div>
          )}
          {(report.reconnectSources?.live_bison ?? 0) > 0 && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
              <strong>{report.reconnectSources?.live_bison}</strong> reconnect{(report.reconnectSources?.live_bison ?? 0) !== 1 ? "s" : ""} verified live against Bison just now.
            </div>
          )}
          {report.liveVerified && report.totals.failed > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              {report.totals.failed} account{report.totals.failed !== 1 ? "s" : ""} were live-checked and Bison still reports them as disconnected.
            </div>
          )}

          {/* Top summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="border-amber-500/30">
              <CardContent className="pt-4 pb-3">
                <div className="text-xs uppercase tracking-wider text-amber-400/80 mb-1">Disconnected</div>
                <div className="text-3xl font-semibold tabular-nums">{report.totals.disconnected}</div>
              </CardContent>
            </Card>
            <Card className="border-emerald-500/30">
              <CardContent className="pt-4 pb-3">
                <div className="text-xs uppercase tracking-wider text-emerald-400/80 mb-1">Reconnected</div>
                <div className="text-3xl font-semibold tabular-nums">{report.totals.reconnected}</div>
              </CardContent>
            </Card>
            <Card className="border-red-500/30">
              <CardContent className="pt-4 pb-3">
                <div className="text-xs uppercase tracking-wider text-red-400/80 mb-1">Failed</div>
                <div className="text-3xl font-semibold tabular-nums">{report.totals.failed}</div>
              </CardContent>
            </Card>
          </div>

          {/* Per-instance breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Per-instance breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="font-medium pb-2">Instance</th>
                      <th className="font-medium pb-2 text-right">Disconnected</th>
                      <th className="font-medium pb-2 text-right">Reconnected</th>
                      <th className="font-medium pb-2 text-right">Failed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ALL_INSTANCE_SLUGS.map((slug) => {
                      const row = report.perInstance.find((p) => p.instance === slug);
                      const cnt = row ?? { disconnected: 0, reconnected: 0, failed: 0 };
                      return (
                        <tr key={slug}>
                          <td className="py-2">{BISON_INSTANCES[slug].label}</td>
                          <td className="py-2 text-right tabular-nums">{cnt.disconnected}</td>
                          <td className="py-2 text-right tabular-nums">{cnt.reconnected}</td>
                          <td className="py-2 text-right tabular-nums">{cnt.failed}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* 3-column accounts list */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <AccountColumn
              title="Disconnected"
              icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
              accent="amber"
              accounts={report.disconnectedAccounts}
            />
            <AccountColumn
              title="Reconnected"
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              accent="emerald"
              accounts={report.reconnectedAccounts}
              showReconnected
            />
            <AccountColumn
              title="Failed"
              icon={<XCircle className="h-4 w-4 text-red-500" />}
              accent="red"
              accounts={report.failedAccounts}
            />
          </div>
        </>
      )}
    </div>
  );
}

function AccountColumn({
  title, icon, accent, accounts, showReconnected,
}: {
  title: string;
  icon: React.ReactNode;
  accent: "amber" | "emerald" | "red";
  accounts: AccountEvent[];
  showReconnected?: boolean;
}) {
  const borderClass =
    accent === "amber" ? "border-amber-500/20" :
    accent === "emerald" ? "border-emerald-500/20" :
    "border-red-500/20";

  return (
    <Card className={borderClass}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {icon}
          {title}
          <Badge variant="outline" className="ml-auto text-xs">{accounts.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">None today.</p>
        ) : (
          <div className="max-h-[480px] overflow-y-auto divide-y">
            {accounts.map((a) => (
              <div key={`${a.instance}-${a.sender_id}`} className="px-2 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{a.sender_email ?? `Sender ${a.sender_id}`}</span>
                  {showReconnected && a.reconnect_source === "current_status" && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-blue-500/30 text-blue-300">
                      inferred
                    </Badge>
                  )}
                  {showReconnected && a.reconnect_source === "live_bison" && (
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0 border-emerald-500/30 text-emerald-300">
                      verified
                    </Badge>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
                  <span className="truncate">{BISON_INSTANCES[a.instance]?.label ?? a.instance}</span>
                  <span className="tabular-nums shrink-0 ml-2">
                    {showReconnected && a.reconnected_at
                      ? `${fmtTime(a.detected_at)} → ${fmtTime(a.reconnected_at)}`
                      : fmtTime(a.detected_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
