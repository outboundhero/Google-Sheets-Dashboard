"use client";

import { useState, useMemo } from "react";
import {
  ColumnDef,
  ColumnFiltersState,
  ColumnSizingState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  useReactTable,
} from "@tanstack/react-table";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { Lead } from "@/types/lead";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTableFacetedFilter } from "./data-table-faceted-filter";
import { DataTablePagination } from "./data-table-pagination";
import { LeadDetailDialog } from "./lead-detail-dialog";

interface DataTableProps {
  columns: ColumnDef<Lead>[];
  data: Lead[];
  hideClientFilter?: boolean;
}

export function DataTable({ columns, data, hideClientFilter }: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [globalFilter, setGlobalFilter] = useState("");
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, columnSizing, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onGlobalFilterChange: setGlobalFilter,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 25 } },
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const search = filterValue.toLowerCase();
      const lead = row.original;
      return (
        lead.name.toLowerCase().includes(search) ||
        lead.email.toLowerCase().includes(search) ||
        lead.company.toLowerCase().includes(search) ||
        lead.clientTag.toLowerCase().includes(search)
      );
    },
  });

  // Extract unique values for faceted filters
  const statusOptions = useMemo(() => {
    const values = new Set(data.map((d) => d.status).filter(Boolean));
    return Array.from(values).map((v) => ({ label: v, value: v }));
  }, [data]);

  const categoryOptions = useMemo(() => {
    const values = new Set(data.map((d) => d.currentCategory).filter(Boolean));
    return Array.from(values).map((v) => ({ label: v, value: v }));
  }, [data]);

  const clientOptions = useMemo(() => {
    const values = new Set(data.map((d) => d.clientTag).filter(Boolean));
    return Array.from(values).map((v) => ({ label: v, value: v }));
  }, [data]);

  const stateOptions = useMemo(() => {
    const values = new Set(data.map((d) => d.state).filter(Boolean));
    return Array.from(values)
      .sort()
      .map((v) => ({ label: v, value: v }));
  }, [data]);

  const isFiltered =
    columnFilters.length > 0 || globalFilter.length > 0;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search leads..."
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          {table.getColumn("status") && (
            <DataTableFacetedFilter
              column={table.getColumn("status")}
              title="Status"
              options={statusOptions}
            />
          )}
          {table.getColumn("currentCategory") && (
            <DataTableFacetedFilter
              column={table.getColumn("currentCategory")}
              title="Category"
              options={categoryOptions}
            />
          )}
          {!hideClientFilter && table.getColumn("clientTag") && (
            <DataTableFacetedFilter
              column={table.getColumn("clientTag")}
              title="Client"
              options={clientOptions}
            />
          )}
          {table.getColumn("state") && (
            <DataTableFacetedFilter
              column={table.getColumn("state")}
              title="State"
              options={stateOptions}
            />
          )}
          {isFiltered && (
            <Button
              variant="ghost"
              onClick={() => {
                table.resetColumnFilters();
                setGlobalFilter("");
              }}
              className="h-8 px-2 lg:px-3"
            >
              Reset
              <X className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table style={{ width: table.getCenterTotalSize() }}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="relative"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={`absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none bg-transparent hover:bg-primary/50 ${
                          header.column.getIsResizing() ? "bg-primary" : ""
                        }`}
                      />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedLead(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination table={table} />

      <LeadDetailDialog
        lead={selectedLead}
        open={!!selectedLead}
        onOpenChange={(open) => !open && setSelectedLead(null)}
      />
    </div>
  );
}
