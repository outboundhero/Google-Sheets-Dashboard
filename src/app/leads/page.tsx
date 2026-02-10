"use client";

import { useAllLeads } from "@/lib/hooks/use-leads";
import { PageHeader } from "@/components/shared/page-header";
import { DataTable } from "@/components/leads-table/data-table";
import { columns } from "@/components/leads-table/columns";
import { Skeleton } from "@/components/ui/skeleton";

export default function LeadsPage() {
  const { leads, isLoading } = useAllLeads();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="All Leads"
        description={`${leads.length.toLocaleString()} leads across all clients`}
      />
      <DataTable columns={columns} data={leads} />
    </div>
  );
}
