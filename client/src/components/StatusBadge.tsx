import { Lock, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Draft / Final / Published pill for a timesheet. */
export function StatusBadge({ status, publishedAt }: { status: string | null | undefined; publishedAt?: string | null }) {
  if (status === "final" && publishedAt) return <Badge variant="default" title="Finalized and published to the accountant"><Send />Published</Badge>;
  return status === "final"
    ? <Badge variant="success" title="Finalized and locked"><Lock />Final</Badge>
    : <Badge variant="secondary">Draft</Badge>;
}
