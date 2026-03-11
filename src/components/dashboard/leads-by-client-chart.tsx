"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  data: { client: string; count: number }[];
}

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { client: string } }> }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-md text-popover-foreground">
      <p className="font-medium">{payload[0].payload.client}</p>
      <p className="text-muted-foreground">{payload[0].value} leads</p>
    </div>
  );
};

export function LeadsByClientChart({ data }: Props) {
  if (!data.length) return null;

  const chartData = data.slice(0, 12).map((d) => ({
    ...d,
    displayName: d.client.length > 20 ? d.client.slice(0, 18) + "..." : d.client,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Leads by Client
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "currentColor" }}
              className="text-muted-foreground"
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="displayName"
              width={140}
              tick={{ fontSize: 11, fill: "currentColor" }}
              className="text-foreground"
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: "transparent" }} />
            <Bar
              dataKey="count"
              fill="#6366f1"
              radius={[0, 6, 6, 0]}
              maxBarSize={22}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
