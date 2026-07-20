"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useInventory } from "./inventory-context";

// Always-visible progress for the "Refresh Porkbun" sync + background MX
// provider resolution — rendered above the tabs so it stays on screen (and the
// work keeps running) regardless of the active tab.
export function InventoryProgressBanner() {
  const { syncing, mxRemaining, mxRunning } = useInventory();

  const resolving = mxRunning && mxRemaining != null && mxRemaining > 0;
  if (!syncing && !resolving) return null;

  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        {syncing ? <RefreshCw className="h-4 w-4 animate-spin text-primary shrink-0" /> : <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {syncing ? "Refreshing Porkbun inventory" : "Resolving email providers"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {syncing
              ? "Pulling every domain from both Porkbun accounts (paced ~10s/page)…"
              : `Looking up MX records · ${mxRemaining} domains left`}
          </div>
        </div>
      </div>
      {/* Indeterminate shimmer bar */}
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full w-1/3 rounded-full bg-primary/70 animate-[inventory-slide_1.2s_ease-in-out_infinite]" />
      </div>
      <style jsx>{`
        @keyframes inventory-slide {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}
