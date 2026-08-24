"use client";

// Deliverability shortage banner — the last unbuilt ask from Spencer's Loom
// (2026-08-12): when clients can't be filled ("we don't have domains available
// to allocate towards JPC and whatever client tags this is also true for"), it
// must show UP TOP on the deliverability page — not only in the replacement
// tab someone has to think to open. Read-only; numbers come from the same
// tier-aware shortfall the buy alert posts.
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

interface InstShort { instance: string; label: string; tier: string; clients: number; short: number }

export function ShortageBanner() {
  const { role } = useAuth();
  const [byInstance, setByInstance] = useState<InstShort[] | null>(null);
  const [totalShort, setTotalShort] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (role !== "admin") return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/replacement/shortfall", { cache: "no-store" });
        const j = await res.json().catch(() => null);
        if (!alive || !res.ok || !j || j.error) return;
        setByInstance(((j.byInstance || []) as InstShort[]).filter((i) => i.short > 0));
        setTotalShort(j.totalShort || 0);
      } catch {
        /* best-effort — the banner just stays hidden */
      }
    })();
    return () => { alive = false; };
  }, [role]);

  if (role !== "admin" || dismissed || !byInstance || totalShort === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      <span className="min-w-0">
        <b>{totalShort.toLocaleString()} domains short of cap</b>
        <span className="text-muted-foreground"> — </span>
        {byInstance.map((i) => `${i.label} ${i.short}`).join(" · ")}
        <span className="text-muted-foreground"> · clients there can&apos;t be topped up until reserve lands</span>
      </span>
      <Link href="/replacement" className="text-amber-500 hover:text-amber-400 underline shrink-0 ml-auto">
        Replacement →
      </Link>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted-foreground hover:text-foreground shrink-0"
        title="Dismiss until next visit"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
