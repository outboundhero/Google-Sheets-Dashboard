"use client";

import { ListChecks } from "lucide-react";
import { TRIAGE_NEEDS } from "@/lib/constants";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * Single-select "what does this client need" control for the stale-clients
 * triage panel: pick ONE of TRIAGE_NEEDS (e.g. Email accounts / Leads / Email
 * accounts and leads). Stored as a 0-or-1 element array so the API + DB
 * (`needs text[]`) are unchanged. Add categories in TRIAGE_NEEDS — nothing here.
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
  const current = needs[0] ?? "";

  return (
    <div className="flex items-center gap-1.5">
      {current && (
        <span className="rounded bg-black/10 dark:bg-white/15 px-1.5 py-0.5 text-[11px] font-medium">
          {current}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            title="Set what this client needs"
            className="inline-flex items-center gap-1 rounded-md border border-current/20 bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[11px] font-medium opacity-80 hover:opacity-100 transition-opacity"
          >
            <ListChecks className="h-3 w-3" />
            {current ? "Edit" : "Needs"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Client needs</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(v) => {
              if (v !== current) onChange([v]);
            }}
          >
            {TRIAGE_NEEDS.map((need) => (
              <DropdownMenuRadioItem key={need} value={need}>
                {need}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {current && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onChange([])}>Clear</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
