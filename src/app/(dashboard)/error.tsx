"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Dashboard-wide error boundary. Without this, any client-side exception blanks
// the page with Next's raw "Application error" screen and the user has to refresh
// by hand. The most common cause here is a STALE-CHUNK mismatch: after a new
// deploy, a tab that's been open (or a client-side navigation) tries to load a JS
// chunk whose hash changed, and it throws. We detect that and hard-reload once
// (rate-limited so it can never loop), which fetches the current build. For any
// other error we show a clean retry instead of a white screen.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const msg = `${error?.name || ""} ${error?.message || ""}`;
    const looksLikeStaleChunk = /ChunkLoadError|Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported|error loading dynamically imported/i.test(msg);
    if (!looksLikeStaleChunk || typeof window === "undefined") return;
    try {
      const now = Date.now();
      const last = Number(sessionStorage.getItem("ls-chunk-reload-at") || 0);
      // Only auto-reload once per 15s window so a persistent error can't loop.
      if (now - last > 15_000) {
        sessionStorage.setItem("ls-chunk-reload-at", String(now));
        window.location.reload();
      }
    } catch { /* sessionStorage blocked — fall through to manual retry */ }
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 text-center space-y-4">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
          <RefreshCw className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">This page hit a snag</h2>
          <p className="text-sm text-muted-foreground">Usually a temporary loading issue after an update. Try again — your data is fine.</p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" onClick={() => reset()} className="gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> Try again</Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>
        </div>
        {error?.digest && <p className="text-[10px] text-muted-foreground/60">Ref: {error.digest}</p>}
      </div>
    </div>
  );
}
