"use client";

import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import type { Lead } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { CategoryBadge } from "@/components/shared/category-badge";

function SortableHeader({
  column,
  title,
}: {
  column: { toggleSorting: (desc: boolean) => void; getIsSorted: () => string | false };
  title: string;
}) {
  return (
    <Button
      variant="ghost"
      className="-ml-3 h-8 text-xs font-semibold"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {title}
      <ArrowUpDown className="ml-1 h-3 w-3" />
    </Button>
  );
}

export const columns: ColumnDef<Lead>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column} title="Name" />,
    cell: ({ row }) => (
      <div className="font-medium max-w-[150px] truncate">
        {row.getValue("name")}
      </div>
    ),
  },
  {
    accessorKey: "company",
    header: ({ column }) => <SortableHeader column={column} title="Company" />,
    cell: ({ row }) => (
      <div className="max-w-[150px] truncate">{row.getValue("company")}</div>
    ),
  },
  {
    accessorKey: "email",
    header: ({ column }) => <SortableHeader column={column} title="Email" />,
    cell: ({ row }) => (
      <div className="max-w-[180px] truncate text-muted-foreground">
        {row.getValue("email")}
      </div>
    ),
  },
  {
    accessorKey: "clientTag",
    header: ({ column }) => <SortableHeader column={column} title="Client" />,
    filterFn: (row, id, value: string[]) =>
      value.includes(row.getValue(id)),
  },
  {
    accessorKey: "status",
    header: ({ column }) => <SortableHeader column={column} title="Status" />,
    cell: ({ row }) => <StatusBadge status={row.getValue("status")} />,
    filterFn: (row, id, value: string[]) =>
      value.includes(row.getValue(id)),
  },
  {
    accessorKey: "currentCategory",
    header: ({ column }) => (
      <SortableHeader column={column} title="Category" />
    ),
    cell: ({ row }) => (
      <CategoryBadge category={row.getValue("currentCategory")} />
    ),
    filterFn: (row, id, value: string[]) =>
      value.includes(row.getValue(id)),
  },
  {
    accessorKey: "city",
    header: ({ column }) => <SortableHeader column={column} title="City" />,
  },
  {
    accessorKey: "state",
    header: ({ column }) => <SortableHeader column={column} title="State" />,
    filterFn: (row, id, value: string[]) =>
      value.includes(row.getValue(id)),
  },
  {
    accessorKey: "phone",
    header: "Phone",
    cell: ({ row }) => (
      <div className="text-muted-foreground">{row.getValue("phone")}</div>
    ),
  },
  {
    accessorKey: "notes",
    header: ({ column }) => <SortableHeader column={column} title="Notes" />,
    cell: ({ row }) => (
      <div className="max-w-[200px] truncate text-muted-foreground text-xs">
        {row.getValue("notes")}
      </div>
    ),
  },
  {
    id: "replyDate",
    accessorFn: (row) => row.timeWeGotReply || row.replyTime || "",
    header: ({ column }) => (
      <SortableHeader column={column} title="Reply Date" />
    ),
    cell: ({ getValue }) => {
      const val = getValue() as string;
      if (!val) return null;
      try {
        return (
          <div className="text-muted-foreground text-xs whitespace-nowrap">
            {new Date(val).toLocaleDateString()}
          </div>
        );
      } catch {
        return <div className="text-muted-foreground text-xs">{val}</div>;
      }
    },
  },
];
