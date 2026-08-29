// Automated Domain Allocation & Replacement System — shared types.
// Isolated module: nothing in the live app imports this yet. Mirrors the tables
// in supabase-replacement-system.sql. See the project write-up for the spec.
import type { BisonInstanceSlug } from "@/lib/bison-instances";

/** How aggressively the system acts. Starts at 'observe' (acts on nothing). */
export type ReplacementMode = "observe" | "confirm" | "auto";

/** Which trailing rate window the detector judges on. */
export type LookbackWindow = "10" | "15" | "30" | "all";

/** Admin-tunable guardrails that define a "burnt" domain (single row, id=1). */
export interface ReplacementSettings {
  mode: ReplacementMode;
  /** Flag if reply rate is below this %, null = ignore this signal. */
  minReplyRate: number | null;
  /** Flag if bounce rate is above this %, null = ignore this signal. */
  maxBounceRate: number | null;
  flagOnSurbl: boolean;
  flagOnSpamhaus: boolean;
  /**
   * Allow SURBL-listed domains to be pulled as replacements (Nick + Spencer
   * Aug-10: "allow SURBL blacklist for now"). Clean reserves are always
   * consumed first; Spamhaus-listed are excluded regardless. Flip this off
   * once inventory recovers — no code change needed.
   */
  allowSurblReserves: boolean;
  /**
   * Allow `.info` domains to be pulled as replacements (Spencer Aug-13: "let's
   * start reusing .info domains going forward and enabling it"). We had refused
   * them on purpose while migrating off `.info`; that stock is now the bulk of
   * what's available. `.info` reserves are consumed LAST within their pool, and
   * are still excluded entirely when the plan is built in `.info`-migration mode
   * (replacing a `.info` with a `.info` would be pointless).
   */
  allowInfoReserves: boolean;
  /** How many signals must be true simultaneously to confirm burnt. */
  minSignals: number;
  lookbackWindow: LookbackWindow;
  /** Ignore domains with fewer than this many total sends. */
  minSent: number;
}

export const DEFAULT_SETTINGS: ReplacementSettings = {
  mode: "observe",
  minReplyRate: 1.0,
  maxBounceRate: 5.0,
  flagOnSurbl: true,
  flagOnSpamhaus: true,
  allowSurblReserves: true,
  allowInfoReserves: true,
  minSignals: 2,
  lookbackWindow: "30",
  minSent: 50,
};

export type ReplacementSource = "derived" | "sheet" | "manual";

export interface ClientRedirect {
  clientTag: string;
  redirectUrl: string;
  source: ReplacementSource;
}

export interface ClientCampaignMapEntry {
  clientTag: string;
  instance: BisonInstanceSlug;
  campaignId: number;
  campaignName: string | null;
  confirmed: boolean;
}

export type DomainLifecycleState =
  | "reserve" | "assigned" | "flagged" | "replacing" | "removed" | "retired";

export interface DomainReplacementState {
  instance: BisonInstanceSlug;
  domain: string;
  state: DomainLifecycleState;
  assignedClientTag: string | null;
  flaggedAt: string | null;
  flaggedReason: string | null;
}

export type ReplacementEventType =
  | "detected" | "proposed" | "tagged" | "redirect_set"
  | "attached" | "removed" | "cancel_queued" | "skipped" | "error"
  // warmup graduation (inbox ≥21d moved to full daily limit)
  | "ramped"
  // observe/confirm/auto flipped on the Replacement page — the audit trail
  // Nick asked for after the silent Aug 17–26 observe window
  | "mode_changed";

export interface ReplacementEvent {
  id: number;
  instance: BisonInstanceSlug | null;
  domain: string | null;
  clientTag: string | null;
  eventType: ReplacementEventType;
  detail: string | null;
  signals: Record<string, unknown> | null;
  createdAt: string;
}

/** Per-instance domain caps (doc Step 4). Derived from tier, not stored. */
export const INSTANCE_CAP = { b2b: 20, b2c: 5 } as const;
/** Hard ceiling per client tag across all instances (doc Step 4). */
export const TOTAL_CAP_PER_CLIENT = 25;
