"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ClientPerformance {
  client: string;
  qualityLeads: number;
  totalLeads: number;
  percentage: number;
}

interface Props {
  data: ClientPerformance[];
}

export function TopClientsTable({ data }: Props) {
  if (!data.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Client Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.map((row) => (
          <div key={row.client} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium truncate max-w-[200px] text-foreground">
                {row.client}
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {row.qualityLeads}/{row.totalLeads}
                </span>
                <span
                  className={`text-sm font-semibold min-w-[36px] text-right ${
                    row.percentage >= 30
                      ? "text-emerald-600 dark:text-emerald-400"
                      : row.percentage >= 15
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {row.percentage}%
                </span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  row.percentage >= 30
                    ? "bg-emerald-500"
                    : row.percentage >= 15
                      ? "bg-amber-500"
                      : "bg-rose-500"
                }`}
                style={{ width: `${Math.min(row.percentage, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
