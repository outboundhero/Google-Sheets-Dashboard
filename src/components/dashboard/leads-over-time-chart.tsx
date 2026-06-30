"use client";

import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SeriesPoint { date: string; count: number }

interface Props {
  /** Meeting-Ready series. Legacy callers pass only this and get the original
   *  single-line chart unchanged. */
  data: SeriesPoint[];
  /** Optional Quality-Lead series. When provided, the chart renders two
   *  overlaid areas with a legend + dual-value tooltip. */
  qualityData?: SeriesPoint[];
  billingStartDate?: Date | null;
}

// Same palette as the rest of the dashboard: violet for the primary
// Meeting-Ready line, emerald for Quality Lead so they're never confused.
const MEETING_READY_COLOR = "#6366f1"; // indigo-500
const QUALITY_LEAD_COLOR = "#10b981";  // emerald-500

interface MergedPoint { date: string; meetingReady: number; qualityLead: number }

interface DualTooltipPayloadEntry { dataKey: string; value: number; color: string }
interface DualTooltipProps { active?: boolean; payload?: DualTooltipPayloadEntry[]; label?: string }

function DualTooltip({ active, payload, label }: DualTooltipProps) {
  if (!active || !payload?.length) return null;
  const mr = payload.find((p) => p.dataKey === "meetingReady");
  const ql = payload.find((p) => p.dataKey === "qualityLead");
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md text-popover-foreground min-w-[160px]">
      <p className="font-medium mb-1.5">{label}</p>
      {mr && (
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: MEETING_READY_COLOR }} />
            <span className="text-muted-foreground">Meeting-Ready</span>
          </span>
          <span className="font-medium tabular-nums">{mr.value}</span>
        </div>
      )}
      {ql && (
        <div className="flex items-center justify-between gap-3 mt-1">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: QUALITY_LEAD_COLOR }} />
            <span className="text-muted-foreground">Quality Lead</span>
          </span>
          <span className="font-medium tabular-nums">{ql.value}</span>
        </div>
      )}
    </div>
  );
}

interface SingleTooltipProps { active?: boolean; payload?: Array<{ value: number }>; label?: string }
function SingleTooltip({ active, payload, label }: SingleTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md text-popover-foreground">
      <p className="font-medium">{label}</p>
      <p className="text-muted-foreground">{payload[0].value} leads</p>
    </div>
  );
}

export function LeadsOverTimeChart({ data, qualityData, billingStartDate }: Props) {
  const showDual = !!qualityData && qualityData.length > 0;

  // Merge both series on `date` so recharts plots them on the same axis even
  // when one series has zero leads in a given billing month.
  const merged: MergedPoint[] = useMemo(() => {
    if (!showDual) return [];
    const map = new Map<string, MergedPoint>();
    for (const p of data) map.set(p.date, { date: p.date, meetingReady: p.count, qualityLead: 0 });
    for (const p of qualityData!) {
      const existing = map.get(p.date);
      if (existing) existing.qualityLead = p.count;
      else map.set(p.date, { date: p.date, meetingReady: 0, qualityLead: p.count });
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data, qualityData, showDual]);

  if (!data.length && !merged.length) return null;

  const totalMeetingReady = data.reduce((s, p) => s + p.count, 0);
  const totalQualityLead = (qualityData ?? []).reduce((s, p) => s + p.count, 0);

  const formatBillingDate = (d: Date) => {
    const day = d.getDate();
    const s = ["th", "st", "nd", "rd"];
    const v = day % 100;
    const ordinal = day + (s[(v - 20) % 10] || s[v] || s[0]);
    const month = d.toLocaleDateString("en-US", { month: "short" });
    return `${ordinal} ${month}`;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Leads Over Time
            </CardTitle>
            {showDual && (
              <div className="flex items-center gap-3 text-[11px]">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: MEETING_READY_COLOR }} />
                  <span className="text-muted-foreground">Meeting-Ready</span>
                  <span className="font-medium text-foreground tabular-nums">{totalMeetingReady}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: QUALITY_LEAD_COLOR }} />
                  <span className="text-muted-foreground">Quality Lead</span>
                  <span className="font-medium text-foreground tabular-nums">{totalQualityLead}</span>
                </span>
              </div>
            )}
          </div>
          {billingStartDate && (
            <span className="text-xs text-muted-foreground">
              Billing Start Date: <span className="font-medium text-foreground">{formatBillingDate(billingStartDate)}</span>
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          {showDual ? (
            <AreaChart data={merged} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="mrGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={MEETING_READY_COLOR} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={MEETING_READY_COLOR} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="qlGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={QUALITY_LEAD_COLOR} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={QUALITY_LEAD_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "currentColor" }}
                className="text-muted-foreground"
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "currentColor" }}
                className="text-muted-foreground"
                axisLine={false}
                tickLine={false}
                width={40}
                allowDecimals={false}
              />
              <Tooltip content={<DualTooltip />} cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }} />
              <Area
                type="monotone"
                dataKey="meetingReady"
                stroke={MEETING_READY_COLOR}
                strokeWidth={2.5}
                fill="url(#mrGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: MEETING_READY_COLOR }}
              />
              <Area
                type="monotone"
                dataKey="qualityLead"
                stroke={QUALITY_LEAD_COLOR}
                strokeWidth={2.5}
                fill="url(#qlGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: QUALITY_LEAD_COLOR }}
              />
            </AreaChart>
          ) : (
            <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="leadGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={MEETING_READY_COLOR} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={MEETING_READY_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "currentColor" }}
                className="text-muted-foreground"
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "currentColor" }}
                className="text-muted-foreground"
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip content={<SingleTooltip />} />
              <Area
                type="monotone"
                dataKey="count"
                stroke={MEETING_READY_COLOR}
                strokeWidth={2.5}
                fill="url(#leadGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: MEETING_READY_COLOR }}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
