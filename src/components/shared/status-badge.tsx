import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const statusStyles: Record<string, string> = {
  "Quality Lead": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  "Not a Quality Lead": "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/25",
  "Lead not Received": "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/25",
  Duplicated: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/25",
  Undetermined: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/25",
};

export function StatusBadge({ status }: { status: string }) {
  if (!status) return null;
  return (
    <Badge
      variant="outline"
      className={cn("font-medium text-xs", statusStyles[status] || "bg-muted text-muted-foreground")}
    >
      {status}
    </Badge>
  );
}
