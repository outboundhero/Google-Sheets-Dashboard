import type { BisonInstanceSlug } from "@/lib/bison-instances";

export type InboxOrderProvider = "scaledmail" | "milkbox" | "inboxing";

export type InboxOrderStatus =
  | "pending"
  | "active"
  | "failed"
  | "swapping"
  | "swapped"
  | "deleting"
  | "deleted";

export interface InboxOrderAlias {
  first_name: string;
  last_name: string;
  alias: string;
}

// A sender persona (display name). A domain's mailboxes are built from 1 or 2
// of these; each mailbox gets a unique `alias` (email prefix) derived from its
// persona's name.
export interface Persona {
  first_name: string;
  last_name: string;
}

// How to source the sender name(s) for an order.
//  - auto:   AI-generate `personaCount` female personas.
//  - manual: use exactly the supplied `names` (no invented names).
export interface NameSpec {
  nameMode: "auto" | "manual";
  personaCount: 1 | 2;
  names?: Persona[];
}

export interface InboxOrder {
  id: string;
  instance: BisonInstanceSlug;
  provider: InboxOrderProvider;
  provider_order_id: string | null;
  provider_domain_id: string | null;
  provider_status_raw: string | null;
  setup_stage: string | null;
  failure_reason: string | null;
  domain: string;
  redirect_url: string | null;
  mailbox_count: number;
  tag: string | null;
  company_name: string | null;
  client_tag: string | null;
  status: InboxOrderStatus;
  aliases: InboxOrderAlias[] | null;
  parent_order_id: string | null;
  created_at: string;
  completed_at: string | null;
  last_checked_at: string | null;
  flagged_at: string | null;
}

export interface CreateOrderInput {
  domain: string;
  redirectUrl: string;
  aliases: InboxOrderAlias[];
  tag?: string;
  companyName?: string;
}

export interface ProviderStatusResult {
  status: InboxOrderStatus;
  rawStatus: string | null;
  setupStage: string | null;
  failureReason: string | null;
  completed: boolean;
}

export const MAILBOX_COUNT_BY_PROVIDER: Record<InboxOrderProvider, number> = {
  scaledmail: 25,
  milkbox: 50,
  inboxing: 49,
};
