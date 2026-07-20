"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDiscovery } from "./discovery-context";

// Slim, always-visible discovery progress — rendered above the tabs so it stays
// on screen (and the loop keeps running) even on the All Domains tab.
export function DiscoveryProgressBanner() {
  const {
    status, total, checkedSoFar, progressPct, remainingMin,
    candidates, cursor, counts, pauseDiscovery, resumeDiscovery,
  } = useDiscovery();

  if (status !== "running" && status !== "paused") return null;

  return (
    <div className="rounded-xl border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center gap-3">
        {status === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        ) : (
          <Pause className="h-4 w-4 text-amber-500 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Finding domains</span>
            <span className="text-muted-foreground text-xs">
              {status === "running" && cursor < total ? (
                <>checking <span className="text-foreground font-medium">{candidates[cursor]}</span></>
              ) : status === "paused" ? "paused" : null}
            </span>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
          <span className="text-violet-500 font-medium tabular-nums">{counts.available} available</span>
          <span className="tabular-nums">{counts.taken} taken</span>
          {counts.errors > 0 && <span className="text-destructive tabular-nums">{counts.errors} err</span>}
        </div>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-24 text-right">
          {checkedSoFar}/{total} · ~{remainingMin}m
        </span>
        {status === "running" ? (
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 shrink-0" onClick={pauseDiscovery}>
            <Pause className="h-3 w-3" /> Pause
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 shrink-0" onClick={resumeDiscovery}>
            <Play className="h-3 w-3" /> Resume
          </Button>
        )}
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progressPct}%` }} />
      </div>
    </div>
  );
}
