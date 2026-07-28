// Inboxing platform-connection IDs per Bison instance — the routing key that
// tells Inboxing WHICH Email Bison workspace to upload a domain's mailboxes
// into (`uploadDomainToPlatform`). Fetched live from GET /platform-connections
// 2026-07-29; all four were "verified". Env vars override the defaults so a
// re-created connection doesn't require a deploy.
import type { BisonInstanceSlug } from "@/lib/bison-instances";

const DEFAULTS: Record<BisonInstanceSlug, string> = {
  outboundhero: "cmk65pnoa000bnw01xuq1ez9i",     // "OutboundHero"
  cleaningoutbound: "cmpfr4kwvepbgoe017k8d28k3", // "CleaningOutbound B2C 1"
  facilityreach: "cmpfr2pv1epbcoe01oh86bgr7",    // "FacilityReach B2B 2"
  outboundclean: "cmpfr5y6oepbioe01u5kbq40p",    // "OutboundClean B2C 2"
};

const ENV_KEYS: Record<BisonInstanceSlug, string> = {
  outboundhero: "INBOXING_CONNECTION_OUTBOUNDHERO",
  cleaningoutbound: "INBOXING_CONNECTION_CLEANINGOUTBOUND",
  facilityreach: "INBOXING_CONNECTION_FACILITYREACH",
  outboundclean: "INBOXING_CONNECTION_OUTBOUNDCLEAN",
};

/** The Inboxing platform-connection ID for a Bison instance. */
export function inboxingConnectionFor(instance: BisonInstanceSlug): string {
  return process.env[ENV_KEYS[instance]] || DEFAULTS[instance];
}
