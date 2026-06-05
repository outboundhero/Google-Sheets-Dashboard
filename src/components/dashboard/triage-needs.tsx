"use client";

import { ListChecks } from "lucide-react";
import { TRIAGE_NEEDS } from "@/lib/constants";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";

/**
 * Multi-select "what does this client need" control for the stale-clients triage
 * panel. Renders the currently selected needs as inline chips plus a dropdown
 * checklist (driven by TRIAGE_NEEDS — add categories there, no change here).
 */
export function TriageNeeds({
  needs,
  onChange,
  disabled,
}: {
  needs: string[];
  onChange: (needs: string[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(needs);
  const toggle = (need: string) => {
    const next = new Set(selected);
    if (next.has(need)) next.delete(need);
    else next.add(need);
    // Preserve TRIAGE_NEEDS order for a stable, readable chip list.
    onChange(TRIAGE_NEEDS.filter((n) => next.has(n)));
  };

  return (
    <div className="flex items-center gap-1.5">
      {needs.length > 0 &&
        TRIAGE_NEEDS.filter((n) => selected.has(n)).map((n) => (
          <span
            key={n}
            className="rounded bg-black/10 dark:bg-white/15 px-1.5 py-0.5 text-[11px] font-medium"
          >
            {n}
          </span>
        ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            title="Set what this client needs"
            className="inline-flex items-center gap-1 rounded-md border border-current/20 bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[11px] font-medium opacity-80 hover:opacity-100 transition-opacity"
          >
            <ListChecks className="h-3 w-3" />
            {needs.length === 0 ? "Needs" : "Edit"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuLabel>Client needs</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {TRIAGE_NEEDS.map((need) => (
            <DropdownMenuCheckboxItem
              key={need}
              checked={selected.has(need)}
              // Keep the menu open so several needs can be toggled in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggle(need)}
            >
              {need}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
