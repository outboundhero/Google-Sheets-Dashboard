export type LeadStatus =
  | "Quality Lead"
  | "Not a Quality Lead"
  | "Lead not Received"
  | "Duplicated"
  | "Undetermined"
  | "";

export interface Lead {
  email: string;
  name: string;
  company: string;
  timeWeGotReply: string;
  replyTime: string;
  city: string;
  address: string;
  googleMapsUrl: string;
  state: string;
  phone: string;
  currentCategory: string;
  clientTag: string;
  senderEmail: string;
  replyContent: string;
  prospectCcEmail: string;
  ourLastReply: string;
  ccEmail1: string;
  ccEmail2: string;
  duplicateCheck: string;
  status: LeadStatus;
  notes: string;
  attemptCount: string;
  qualityLeadCriteria: string;
  sheetId: string;
  sheetName: string;
}
