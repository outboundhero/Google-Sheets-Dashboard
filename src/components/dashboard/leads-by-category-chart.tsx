"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CATEGORY_COLORS } from "@/lib/constants";

interface Props {
  data: { category: string; count: number }[];
}

const FALLBACK_COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#ef4444", "#8b5cf6", "#10b981", "#f97316", "#64748b"];

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { category: string } }> }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md text-popover-foreground">
      <p className="font-medium">{payload[0].payload.category}</p>
      <p className="text-muted-foreground">{payload[0].value} leads</p>
    </div>
  );
};

export function LeadsByCategoryChart({ data }: Props) {
  if (!data.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Leads by Category
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data.slice(0, 6)} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "currentColor" }}
              className="text-muted-foreground"
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="category"
              width={140}
              tick={{ fontSize: 12, fill: "currentColor" }}
              className="text-foreground"
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "transparent" }} />
            <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={24}>
              {data.slice(0, 6).map((entry, i) => (
                <Cell
                  key={i}
                  fill={CATEGORY_COLORS[entry.category] || FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
