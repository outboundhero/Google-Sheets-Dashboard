import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const categoryStyles: Record<string, string> = {
  "Meeting-Ready Lead": "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  Interested: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
};

export function CategoryBadge({ category }: { category: string }) {
  if (!category) return null;
  return (
    <Badge
      variant="outline"
      className={cn("font-medium", categoryStyles[category] || "bg-muted text-muted-foreground")}
    >
      {category}
    </Badge>
  );
}
