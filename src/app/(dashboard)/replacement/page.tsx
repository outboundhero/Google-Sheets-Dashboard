"use client";

import { useState, useEffect } from "react";
import { RefreshCw, Loader2, ShieldAlert, Eye, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth-context";
import type { ReplacementSettings, LookbackWindow } from "@/lib/replacement/types";

interface Candidate {
  instance: string;
  domain: string;
  totalSent: number;
  replyRate: number | null;
  bounceRate: number | null;
  signalsHit: string[];
  reasons: string[];
}
interface DetectResponse {
  mode: string;
  scanned: number;
  flaggedCount: number;
  byInstance: Record<string, number>;
  candidates: Candidate[];
}

interface CampaignRef { id: number; name: string; status: string }
interface CampaignMatch { clientTag: string; instance: string; eligible: CampaignRef[]; excluded: CampaignRef[] }
interface CampaignMapResponse {
  matches: CampaignMatch[];
  blankTagCount: number;
  statusDistribution: Record<string, number>;
  totalCampaigns: number;
}

interface PlanItem {
  burntDomain: string;
  instance: string;
  provider: "outlook" | "google" | "mixed" | "unknown";
  clientTag: string | null;
  reasons: string[];
  surbl: boolean | null;
  spamhaus: boolean | null;
  redirectUrl: string | null;
  targetCampaigns: CampaignRef[];
  replacementDomain: string | null;
  removeOnly: boolean;
  capCurrent: number;
  capMax: number;
  blockers: string[];
}
interface ClientAuditRow {
  clientTag: string; instance: string;
  total: number; info: number; comco: number; other: number;
  outlook: number; google: number; burnt: number; capMax: number;
}
interface PlanResponse {
  generatedFor: string;
  infoMigration: boolean;
  burntCount: number;
  unassignedBurntCount: number;
  items: PlanItem[];
  reserveReadyByInstance: Record<string, { outlook: number; google: number }>;
  clientAudit: ClientAuditRow[];
}

// short, unambiguous instance labels (outboundhero vs outboundclean both start "outbound")
const INSTANCE_SHORT: Record<string, string> = {
  outboundhero: "OH·B2B", cleaningoutbound: "CO·B2C", facilityreach: "FR·B2B", outboundclean: "OC·B2C",
};

const WINDOWS: { value: LookbackWindow; label: string }[] = [
  { value: "all", label: "All-time" },
  { value: "10", label: "10-day" },
  { value: "15", label: "15-day" },
  { value: "30", label: "30-day" },
];

export default function ReplacementPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [settings, setSettings] = useState<ReplacementSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<DetectResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignMap, setCampaignMap] = useState<CampaignMapResponse | null>(null);
  const [loadingMap, setLoadingMap] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [infoMode, setInfoMode] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/replacement/settings", { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (res.ok) setSettings(data);
        else setError(data.error || "Failed to load settings");
      } catch { if (active) setError("Failed to load settings"); }
    })();
    return () => { active = false; };
  }, [isAdmin]);

  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/replacement/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) { setSettings(data); setSavedAt(Date.now()); }
      else setError(data.error || "Save failed");
    } catch { setError("Save failed"); }
    setSaving(false);
  };

  const runPreview = async () => {
    setRunning(true); setError(null);
    try {
      const res = await fetch("/api/replacement/detect", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPreview(data);
      else setError(data.error || "Preview failed");
    } catch { setError("Preview failed"); }
    setRunning(false);
  };

  const loadCampaignMap = async () => {
    setLoadingMap(true); setError(null);
    try {
      const res = await fetch("/api/replacement/campaign-map", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setCampaignMap(data);
      else setError(data.error || "Campaign map failed");
    } catch { setError("Campaign map failed"); }
    setLoadingMap(false);
  };

  const loadPlan = async (info: boolean) => {
    setLoadingPlan(true); setError(null);
    try {
      const res = await fetch(`/api/replacement/plan?infoMigration=${info ? 1 : 0}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPlan(data);
      else setError(data.error || "Plan failed");
    } catch { setError("Plan failed"); }
    setLoadingPlan(false);
  };

  if (!isAdmin) {
    return <div className="p-8 text-sm text-muted-foreground">Admins only.</div>;
  }

  const set = <K extends keyof ReplacementSettings>(k: K, v: ReplacementSettings[K]) =>
    setSettings((s) => (s ? { ...s, [k]: v } : s));

  const numField = (label: string, key: "minReplyRate" | "maxBounceRate" | "minSignals" | "minSent", suffix?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number" step="any"
          value={settings?.[key] ?? ""}
          onChange={(e) => set(key, (e.target.value === "" ? null : Number(e.target.value)) as ReplacementSettings[typeof key])}
          className="w-24 text-sm px-2 py-1.5 rounded-lg border bg-background"
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Domain Replacement" description="Detection guardrails & observe-only preview">
        <Badge variant="outline" className={`gap-1 ${settings?.mode === "observe" ? "border-emerald-500/30 text-emerald-500" : "border-amber-500/30 text-amber-500"}`}>
          {settings?.mode === "observe" ? <Eye className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
          mode: {settings?.mode ?? "…"}
        </Badge>
      </PageHeader>

      {settings?.mode === "observe" && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
          <Eye className="h-4 w-4 shrink-0" />
          Observe-only — detection runs but takes no action. Nothing is tagged, moved, removed, or cancelled.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {/* Guardrail settings */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="text-sm font-medium">Guardrails — what makes a domain &ldquo;burnt&rdquo;</div>
          {!settings ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-5">
                {numField("Reply rate below", "minReplyRate", "%")}
                {numField("Bounce rate above", "maxBounceRate", "%")}
                {numField("Min signals to flag", "minSignals")}
                {numField("Ignore if sent under", "minSent")}
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Rate window</span>
                  <select
                    value={settings.lookbackWindow}
                    onChange={(e) => set("lookbackWindow", e.target.value as LookbackWindow)}
                    className="text-sm px-2 py-1.5 rounded-lg border bg-background"
                  >
                    {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-5">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.flagOnSurbl} onChange={(e) => set("flagOnSurbl", e.target.checked)} />
                  SURBL listed counts as a signal
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={settings.flagOnSpamhaus} onChange={(e) => set("flagOnSpamhaus", e.target.checked)} />
                  Spamhaus DBL listed counts as a signal
                </label>
                <label className="flex items-center gap-2 text-sm ml-auto">
                  <span className="text-xs text-muted-foreground">Mode</span>
                  <select
                    value={settings.mode}
                    onChange={(e) => set("mode", e.target.value as ReplacementSettings["mode"])}
                    className="text-sm px-2 py-1.5 rounded-lg border bg-background"
                  >
                    <option value="observe">observe (safe)</option>
                    <option value="confirm">confirm</option>
                    <option value="auto">auto</option>
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={save} disabled={saving} className="gap-2">
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save guardrails
                </Button>
                {savedAt && <span className="text-xs text-emerald-500">Saved</span>}
                <span className="text-[11px] text-muted-foreground">
                  A domain is flagged only when ≥ {settings.minSignals} signals fire at once and it has sent ≥ {settings.minSent}.
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Observe-only preview */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Preview — domains that would be flagged</div>
            <Button size="sm" variant="outline" onClick={runPreview} disabled={running} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
              {running ? "Scanning…" : "Run preview"}
            </Button>
          </div>

          {preview && (
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-muted-foreground">Scanned <b className="text-foreground">{preview.scanned.toLocaleString()}</b></span>
              <span className="text-muted-foreground">Would flag <b className="text-amber-500">{preview.flaggedCount.toLocaleString()}</b></span>
              {Object.entries(preview.byInstance).map(([inst, n]) => (
                <span key={inst} className="text-muted-foreground">{inst}: <b className="text-foreground">{n}</b></span>
              ))}
            </div>
          )}

          {preview && preview.candidates.length > 0 && (
            <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
              <div className="grid grid-cols-[1fr_110px_70px_70px_70px_1.4fr] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                <span>Domain</span><span>Instance</span><span className="text-center">Sent</span>
                <span className="text-center">Reply</span><span className="text-center">Bounce</span><span>Why</span>
              </div>
              {preview.candidates.map((c) => (
                <div key={`${c.instance}:${c.domain}`} className="grid grid-cols-[1fr_110px_70px_70px_70px_1.4fr] gap-2 px-3 py-2 text-xs items-center">
                  <span className="font-medium truncate">{c.domain}</span>
                  <span className="text-muted-foreground">{c.instance}</span>
                  <span className="text-center tabular-nums">{c.totalSent.toLocaleString()}</span>
                  <span className="text-center tabular-nums">{c.replyRate != null ? `${c.replyRate}%` : "—"}</span>
                  <span className="text-center tabular-nums">{c.bounceRate != null ? `${c.bounceRate}%` : "—"}</span>
                  <span className="text-muted-foreground truncate" title={c.reasons.join(" · ")}>{c.reasons.join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
          {preview && preview.candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">No domains match the current guardrails.</p>
          )}
        </CardContent>
      </Card>

      {/* Campaign match — which campaigns a replacement would attach to */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Campaign match — where replacements would attach</div>
              <div className="text-[11px] text-muted-foreground">Eligible = active · draft · launching · launch processing (not failed/paused/completed/archived)</div>
            </div>
            <Button size="sm" variant="outline" onClick={loadCampaignMap} disabled={loadingMap} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${loadingMap ? "animate-spin" : ""}`} />
              {loadingMap ? "Loading…" : "Load campaign map"}
            </Button>
          </div>

          {campaignMap && (
            <>
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-muted-foreground">Campaigns <b className="text-foreground">{campaignMap.totalCampaigns.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Client·instance pairs <b className="text-foreground">{campaignMap.matches.length}</b></span>
                {campaignMap.blankTagCount > 0 && (
                  <span className="text-amber-500">No tag prefix: <b>{campaignMap.blankTagCount}</b> (naming issue)</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(campaignMap.statusDistribution).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                  <Badge key={s} variant="outline" className={`text-[10px] ${["active","draft","launching","launch processing"].includes(s) ? "border-emerald-500/30 text-emerald-500" : "text-muted-foreground"}`}>
                    {s}: {n}
                  </Badge>
                ))}
              </div>
              <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
                <div className="grid grid-cols-[90px_120px_1fr] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                  <span>Client</span><span>Instance</span><span>Eligible campaigns (would attach)</span>
                </div>
                {campaignMap.matches.map((m) => (
                  <div key={`${m.clientTag}:${m.instance}`} className="grid grid-cols-[90px_120px_1fr] gap-2 px-3 py-2 text-xs items-start">
                    <span className="font-medium">{m.clientTag}</span>
                    <span className="text-muted-foreground">{m.instance}</span>
                    <span>
                      {m.eligible.length === 0 ? (
                        <span className="text-amber-500">none eligible{m.excluded.length > 0 ? ` (${m.excluded.length} excluded)` : ""}</span>
                      ) : (
                        <span className="text-muted-foreground">{m.eligible.map((c) => c.name).join(" · ")}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Replacement plan — full proposed action per burnt domain (observe-only) */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Replacement plan — what would happen to each burnt domain</div>
              <div className="text-[11px] text-muted-foreground">Observe-only — pull reserve → tag → set redirect → attach to campaigns → remove burnt. Nothing executes.</div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={infoMode} onChange={(e) => setInfoMode(e.target.checked)} />
                Migrate all .info
              </label>
              <Button size="sm" variant="outline" onClick={() => loadPlan(infoMode)} disabled={loadingPlan} className="gap-2">
                <RefreshCw className={`h-4 w-4 ${loadingPlan ? "animate-spin" : ""}`} />
                {loadingPlan ? "Building…" : "Build plan"}
              </Button>
            </div>
          </div>

          {plan && (
            <>
              <div className="flex flex-wrap gap-4 text-sm">
                {plan.infoMigration && <Badge variant="outline" className="border-amber-500/30 text-amber-500">.info migration mode</Badge>}
                <span className="text-muted-foreground">{plan.infoMigration ? "To remove" : "Burnt (assigned)"} <b className="text-amber-500">{plan.burntCount.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Get replacement <b className="text-emerald-500">{plan.items.filter((i) => !i.removeOnly).length.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Remove-only (at cap) <b>{plan.items.filter((i) => i.removeOnly).length.toLocaleString()}</b></span>
                <span className="text-muted-foreground">Of removed: <b className="text-red-400">{plan.items.filter((i) => i.surbl === true || i.spamhaus === true).length.toLocaleString()}</b> blacklisted · <b>{plan.items.filter((i) => !(i.surbl === true || i.spamhaus === true)).length.toLocaleString()}</b> clean (migrating)</span>
                {plan.unassignedBurntCount > 0 && (
                  <span className="text-muted-foreground">Burnt spare/no-tag <b className="text-muted-foreground">{plan.unassignedBurntCount.toLocaleString()}</b> <span className="text-[10px]">(clean up, not replaced)</span></span>
                )}
                <span className="text-muted-foreground">Reserve ready (Outlook / Google):</span>
                {Object.entries(plan.reserveReadyByInstance).map(([inst, c]) => (
                  <span key={inst} className="text-muted-foreground">
                    {inst}: <b className={c.outlook > 0 ? "text-emerald-500" : "text-destructive"}>{c.outlook}</b>
                    {" / "}<b className={c.google > 0 ? "text-emerald-500" : "text-muted-foreground"}>{c.google}</b>
                  </span>
                ))}
              </div>

              <div className="rounded-lg border divide-y max-h-[480px] overflow-y-auto">
                <div className="grid grid-cols-[1fr_75px_60px_45px_70px_1fr_1fr_55px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                  <span>Burnt domain</span><span>Client</span><span>Inst</span><span>Type</span><span>Blacklist</span><span>Pull reserve → redirect</span><span>Attach to campaigns</span><span className="text-center">Cap</span>
                </div>
                {plan.items.map((it) => {
                  const bl = it.surbl === true || it.spamhaus === true;
                  const blDetail = [it.surbl === true ? "SURBL" : null, it.spamhaus === true ? "Spamhaus" : null].filter(Boolean).join(" + ");
                  return (
                  <div key={`${it.instance}:${it.burntDomain}`} className="grid grid-cols-[1fr_75px_60px_45px_70px_1fr_1fr_55px] gap-2 px-3 py-2 text-xs items-start">
                    <span className="truncate" title={it.reasons.join(" · ")}>{it.burntDomain}</span>
                    <span className="font-medium">{it.clientTag ?? <span className="text-destructive">?</span>}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[it.instance] ?? it.instance}</span>
                    <span className={it.provider === "outlook" ? "text-blue-400" : it.provider === "google" ? "text-red-400" : "text-amber-500"}>{it.provider === "outlook" ? "OL" : it.provider === "google" ? "GG" : it.provider}</span>
                    <span className={bl ? "text-red-400" : "text-muted-foreground"} title={bl ? `Blacklisted: ${blDetail}` : "Not blacklisted (migrating off .info)"}>
                      {bl ? `yes (${blDetail === "SURBL + Spamhaus" ? "both" : it.surbl ? "S" : "DBL"})` : "no"}
                    </span>
                    <span className="truncate">
                      {it.removeOnly ? (
                        <span className="text-muted-foreground italic">remove only — at cap, no replacement</span>
                      ) : (<>
                        {it.replacementDomain
                          ? <span className="text-emerald-500">{it.replacementDomain}</span>
                          : <span className="text-destructive">no reserve</span>}
                        {it.redirectUrl
                          ? <span className="text-muted-foreground"> → {it.redirectUrl.replace(/^https?:\/\//, "")}</span>
                          : <span className="text-destructive"> → no redirect</span>}
                      </>)}
                    </span>
                    <span className="truncate text-muted-foreground" title={it.targetCampaigns.map((c) => c.name).join(" · ")}>
                      {it.removeOnly ? "—"
                        : it.targetCampaigns.length > 0
                          ? `${it.targetCampaigns.length} campaign${it.targetCampaigns.length === 1 ? "" : "s"}`
                          : <span className="text-destructive">none</span>}
                    </span>
                    <span className="text-center tabular-nums text-muted-foreground">
                      {it.capCurrent}/{it.capMax}
                    </span>
                  </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                <b>Top-up to cap:</b> every burnt domain is removed; replacements are added only up to the cap ({"{healthy}/{cap}"}). Rows marked <span className="italic">&ldquo;remove only — at cap&rdquo;</span> mean the client already has enough healthy domains, so the burnt one is removed but <b>no</b> replacement is added (and healthy domains are never removed). Red text = a replacement is blocked (missing redirect, no eligible campaign, or no ready reserve).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Per-client domain-count audit (validates totals / caps) */}
      {plan && plan.clientAudit.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="text-sm font-medium">Per-client domain count — by TLD & provider</div>
            <div className="text-[11px] text-muted-foreground">Sorted by total. `.info` = to migrate off · `.com/.co` = keep. Over-cap shows when good (non-.info) domains alone exceed the limit.</div>
            <div className="rounded-lg border divide-y max-h-[420px] overflow-y-auto">
              <div className="grid grid-cols-[90px_110px_60px_60px_70px_60px_70px_70px] gap-2 px-3 py-2 text-[11px] text-muted-foreground font-medium bg-muted/30 sticky top-0">
                <span>Client</span><span>Instance</span><span className="text-center">Total</span><span className="text-center">.info</span><span className="text-center">.com/.co</span><span className="text-center">other</span><span className="text-center">OL / GG</span><span className="text-center">Cap</span>
              </div>
              {plan.clientAudit.map((a) => {
                const good = a.comco + a.other; // non-.info
                return (
                  <div key={`${a.clientTag}:${a.instance}`} className="grid grid-cols-[90px_110px_60px_60px_70px_60px_70px_70px] gap-2 px-3 py-2 text-xs items-center">
                    <span className="font-medium">{a.clientTag}</span>
                    <span className="text-muted-foreground">{INSTANCE_SHORT[a.instance] ?? a.instance}</span>
                    <span className="text-center tabular-nums">{a.total}</span>
                    <span className="text-center tabular-nums text-amber-500">{a.info || ""}</span>
                    <span className="text-center tabular-nums text-emerald-500">{a.comco || ""}</span>
                    <span className="text-center tabular-nums text-muted-foreground">{a.other || ""}</span>
                    <span className="text-center tabular-nums text-muted-foreground">{a.outlook} / {a.google}</span>
                    <span className={`text-center tabular-nums ${good > a.capMax ? "text-destructive" : "text-muted-foreground"}`}>{good}/{a.capMax}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
