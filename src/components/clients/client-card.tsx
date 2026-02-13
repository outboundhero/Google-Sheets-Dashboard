"use client";

import Link from "next/link";
import { Users, CheckCircle2, ArrowRight, Clock, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface ClientCardProps {
  clientTag: string;
  totalLeads: number;
  qualityLeads: number;
  qualityPercentage: number;
  meetingReadyLast24h: number;
  meetingReadyWithoutStatus: number;
}

export function ClientCard({
  clientTag,
  totalLeads,
  qualityLeads,
  qualityPercentage,
  meetingReadyLast24h,
  meetingReadyWithoutStatus,
}: ClientCardProps) {
  return (
    <Link href={`/clients/${encodeURIComponent(clientTag)}`}>
      <Card className="group transition-all hover:shadow-md hover:border-primary/30 cursor-pointer">
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1 min-w-0">
              <h3 className="font-semibold truncate pr-4">{clientTag}</h3>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 shrink-0" />
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                <span className="text-xs">Total</span>
              </div>
              <p className="text-lg font-bold">{totalLeads}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span className="text-xs">Quality</span>
              </div>
              <p className="text-lg font-bold">{qualityLeads}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Rate</p>
              <p
                className={`text-lg font-bold ${
                  qualityPercentage >= 30
                    ? "text-emerald-600 dark:text-emerald-400"
                    : qualityPercentage >= 15
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-red-600 dark:text-red-400"
                }`}
              >
                {qualityPercentage}%
              </p>
            </div>
          </div>

          {/* Additional metrics */}
          <div className="mt-3 grid grid-cols-2 gap-3 pt-3 border-t">
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span className="text-xs">24h Ready</span>
              </div>
              <p className="text-sm font-semibold">{meetingReadyLast24h}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-muted-foreground">
                <AlertTriangle className="h-3 w-3" />
                <span className="text-xs">Missing Status</span>
              </div>
              <p className="text-sm font-semibold">{meetingReadyWithoutStatus}</p>
            </div>
          </div>

          {/* Quality bar */}
          <div className="mt-4">
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(qualityPercentage, 100)}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
