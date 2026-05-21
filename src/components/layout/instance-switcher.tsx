"use client";

import { Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { useInstance } from "@/lib/instance-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BisonGroup } from "@/lib/bison-instances";

interface InstanceSwitcherProps {
  collapsed?: boolean;
}

export function InstanceSwitcher({ collapsed = false }: InstanceSwitcherProps) {
  const { group, tier, setGroup, setTier } = useInstance();

  if (collapsed) {
    // When sidebar is collapsed: show a small chip indicating current group + tier
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <div className="mx-2 my-2 flex h-8 items-center justify-center rounded-md border bg-card text-[10px] font-medium">
            G{group}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          Group {group} · {tier === "all" ? "All" : tier.toUpperCase()}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="border-b px-3 py-3 space-y-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Layers className="h-3 w-3" />
        Instance group
      </div>

      <Select
        value={String(group)}
        onValueChange={(v) => setGroup(Number(v) as BisonGroup)}
      >
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Group 1 · B2B#1 + B2C#1</SelectItem>
          <SelectItem value="2">Group 2 · B2B#2 + B2C#2</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex rounded-md border bg-muted/30 p-0.5">
        {(["all", "b2b", "b2c"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors",
              tier === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "all" ? "All" : t.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
