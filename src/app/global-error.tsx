"use client";

import { useEffect } from "react";

// Root-level error boundary. This is the LAST line of defence: it catches errors
// that escape every segment boundary (including anything thrown in a layout or a
// shared provider), which is exactly what produces Next's raw white "Application
// error: a client-side exception has occurred" screen. Like the dashboard
// boundary, we auto-reload once on a stale-chunk mismatch (common right after a
// deploy, when an open tab requests a JS/CSS chunk whose hash has changed), and
// otherwise show a clean, styled retry instead of the bare white page.
//
// global-error must render its own <html>/<body> — it replaces the root layout.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0a", color: "#e5e5e5" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ width: "100%", maxWidth: 420, textAlign: "center", border: "1px solid #262626", background: "#141414", borderRadius: 12, padding: 28 }}>
            <div style={{ width: 40, height: 40, borderRadius: 999, background: "rgba(245,158,11,0.12)", color: "#f59e0b", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 20 }}>↻</div>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 6px" }}>This page hit a snag</h2>
            <p style={{ fontSize: 13, color: "#a3a3a3", margin: "0 0 18px", lineHeight: 1.5 }}>Usually a temporary loading issue after an update. Try again — your data is fine.</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={() => reset()} style={{ fontSize: 13, fontWeight: 500, padding: "7px 14px", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}>Try again</button>
              <button onClick={() => window.location.reload()} style={{ fontSize: 13, padding: "7px 14px", borderRadius: 8, border: "1px solid #3a3a3a", background: "transparent", color: "#e5e5e5", cursor: "pointer" }}>Reload page</button>
            </div>
            {error?.digest && <p style={{ fontSize: 10, color: "#6b6b6b", marginTop: 16 }}>Ref: {error.digest}</p>}
          </div>
        </div>
      </body>
    </html>
  );
}
