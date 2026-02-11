export const COLUMN_MAP = {
  email: 0,
  name: 1,
  company: 2,
  timeWeGotReply: 3,
  replyTime: 4,
  city: 5,
  address: 6,
  googleMapsUrl: 7,
  state: 8,
  phone: 9,
  currentCategory: 10,
  clientTag: 11,
  senderEmail: 12,
  replyContent: 13,
  prospectCcEmail: 14,
  ourLastReply: 15,
  ccEmail1: 16,
  ccEmail2: 17,
  duplicateCheck: 18,
  status: 19,
  notes: 20,
  attemptCount: 21,
  qualityLeadCriteria: 22,
} as const;

export const STATUS_COLORS: Record<string, string> = {
  "Quality Lead": "#10b981",
  "Not a Quality Lead": "#f43f5e",
  "Lead not Received": "#8b5cf6",
  Duplicated: "#f97316",
  Undetermined: "#eab308",
};

export const CATEGORY_COLORS: Record<string, string> = {
  "Meeting-Ready Lead": "#6366f1",
  Interested: "#0ea5e9",
  "Follow Up": "#f59e0b",
  "Not Interested": "#ef4444",
};

export const LEAD_CATEGORIES = [
  "Meeting-Ready Lead",
  "Interested",
  "Follow Up",
  "Not Interested",
] as const;

export const LEAD_STATUSES = [
  "Quality Lead",
  "Not a Quality Lead",
  "Lead not Received",
  "Duplicated",
  "Undetermined",
] as const;

export const SHEET_TAB_NAME = "Leads";

export const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
