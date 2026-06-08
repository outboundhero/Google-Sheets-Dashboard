import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const statusStyles: Record<string, string> = {
  "quality lead": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  "not a quality lead": "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/25",
  "lead not received": "bg-muted text-foreground border-border",
  duplicated: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/25",
  undetermined: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/25",
};

export function StatusBadge({ status }: { status: string }) {
  if (!status) return null;
  const style = statusStyles[status.trim().toLowerCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("font-medium text-xs", style)}>
      {status}
    </Badge>
  );
}
