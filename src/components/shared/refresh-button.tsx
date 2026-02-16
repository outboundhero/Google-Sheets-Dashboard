"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RefreshButtonProps {
  onRefresh: () => void;
  isRefreshing?: boolean;
  className?: string;
}

export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  className,
}: RefreshButtonProps) {
  return (
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
      {isRefreshing ? "Refreshing..." : "Refresh"}
    </Button>
  );
}
