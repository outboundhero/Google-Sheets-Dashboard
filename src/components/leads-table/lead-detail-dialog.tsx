"use client";

import type { Lead } from "@/types/lead";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { CategoryBadge } from "@/components/shared/category-badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm break-all">{value}</p>
    </div>
  );
}

export function LeadDetailDialog({ lead, open, onOpenChange }: Props) {
  if (!lead) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>{lead.name || lead.email}</span>
            <StatusBadge status={lead.status} />
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-4">
          <div className="space-y-6">
            {/* Contact Info */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Contact Info</h3>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Email" value={lead.email} />
                <Field label="Phone" value={lead.phone} />
                <Field label="Company" value={lead.company} />
                <Field label="City" value={lead.city} />
                <Field label="State" value={lead.state} />
                <Field label="Address" value={lead.address} />
              </div>
            </div>

            <Separator />

            {/* Lead Details */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Lead Details</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Category
                  </p>
                  <CategoryBadge category={lead.currentCategory} />
                </div>
                <Field label="Client" value={lead.clientTag} />
                <Field label="Sheet" value={lead.sheetName} />
                <Field label="Attempts" value={lead.attemptCount} />
                <Field
                  label="Quality Lead Criteria"
                  value={lead.qualityLeadCriteria}
                />
                <Field label="Duplicate Check" value={lead.duplicateCheck} />
              </div>
            </div>

            <Separator />

            {/* Communication */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Communication</h3>
              <div className="space-y-4">
                <Field label="Sender Email" value={lead.senderEmail} />
                <Field label="Reply Time" value={lead.timeWeGotReply} />
                {lead.replyContent && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      Reply We Got
                    </p>
                    <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
                      {lead.replyContent}
                    </div>
                  </div>
                )}
                {lead.ourLastReply && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      Our Last Reply
                    </p>
                    <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
                      {lead.ourLastReply}
                    </div>
                  </div>
                )}
                <Field
                  label="Prospect CC Email"
                  value={lead.prospectCcEmail}
                />
                <Field label="CC Email 1" value={lead.ccEmail1} />
                <Field label="CC Email 2" value={lead.ccEmail2} />
              </div>
            </div>

            {lead.notes && (
              <>
                <Separator />
                <div>
                  <h3 className="text-sm font-semibold mb-3">Notes</h3>
                  <div className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
                    {lead.notes}
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
