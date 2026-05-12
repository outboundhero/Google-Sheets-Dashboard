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

export interface InboxOrder {
  id: string;
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
