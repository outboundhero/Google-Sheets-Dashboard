"use client";

// Shared client helpers for persistent progress panels + resilient POSTs,
// mirroring the proven deliverability-page pattern. Used by the Domains ops
// panels so bulk actions survive tab switches + refresh and retry gracefully.

const LS_PREFIX = "domains:panels:";

export function readPanelLS<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writePanelLS(key: string, val: unknown): void {
  if (typeof window === "undefined") return;
  try {
    if (val == null || (Array.isArray(val) && val.length === 0)) {
      window.localStorage.removeItem(LS_PREFIX + key);
    } else {
      window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
    }
  } catch {
    /* quota — non-fatal */
  }
}

export function readRawLS(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LS_PREFIX + key);
  } catch {
    return null;
  }
}

const RETRY_WAITS = [2000, 5000, 10000];

/**
 * POST JSON with transport-level retry (network throw / 429 / 5xx / non-JSON).
 * A clean 2xx-with-JSON is returned as-is even if it carries per-item failures —
 * those are real outcomes surfaced to the user (fix = manual Retry, not re-POST).
 */
export async function fetchJsonWithRetry<T = unknown>(
  url: string,
  body: unknown,
  attempts = 3,
): Promise<{ ok: boolean; data: T | null; status: number; error?: string }> {
  let lastStatus = 0;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      lastStatus = res.status;
      const text = await res.text();
      let data: T | null = null;
      try {
        data = text ? (JSON.parse(text) as T) : null;
      } catch {
        data = null; // serverless timeout → HTML
      }
      const transient = res.status === 429 || res.status >= 500 || data === null;
      if (res.ok && data !== null) return { ok: true, data, status: res.status };
      if (!transient) {
        const err = (data && typeof data === "object" && (data as { error?: string }).error) || `HTTP ${res.status}`;
        return { ok: false, data, status: res.status, error: err };
      }
      lastError = (data && typeof data === "object" && (data as { error?: string }).error) || `HTTP ${res.status}`;
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)];
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 300)));
    } catch (e) {
      lastError = e instanceof Error ? e.message : "network error";
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, RETRY_WAITS[Math.min(attempt, RETRY_WAITS.length - 1)] + Math.floor(Math.random() * 300)));
    }
  }
  return { ok: false, data: null, status: lastStatus, error: lastError || "request failed" };
}

// A generic bulk-op progress panel shape reused by every Domains bulk action.
export interface BulkPanel {
  id: number;
  kind: "auto-renew" | "hide" | "surbl" | "spamhaus";
  title: string;
  total: number;
  done: number;
  failed: number;
  running: boolean;
  queued: boolean;
  failures: { domain: string; error: string }[];
  retryDomains: string[];
  // action-specific payload so a resumed/retried run can re-issue itself:
  enabled?: boolean; // auto-renew / hide on|off
}
