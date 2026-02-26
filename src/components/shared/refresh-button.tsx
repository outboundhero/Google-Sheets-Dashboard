"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SyncProgress } from "@/lib/hooks/use-leads";

interface RefreshButtonProps {
  onRefresh: () => void;
  isRefreshing?: boolean;
  syncProgress?: SyncProgress | null;
  className?: string;
}

export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  syncProgress,
  className,
}: RefreshButtonProps) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={isRefreshing}
        className={className}
      >
        <RefreshCw
          className={cn("h-4 w-4 mr-2", isRefreshing && "animate-spin")}
        />
        {isRefreshing ? "Syncing..." : "Refresh"}
      </Button>
      {syncProgress && (
        <span className="text-sm text-muted-foreground">
          {syncProgress.synced}/{syncProgress.total} sheets
          {syncProgress.errors > 0 && (
            <span className="text-destructive ml-1">
              ({syncProgress.errors} failed)
            </span>
          )}
        </span>
      )}
    </div>
  );
}
