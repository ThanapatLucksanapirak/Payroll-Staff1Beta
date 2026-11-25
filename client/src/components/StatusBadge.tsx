import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Draft / Final pill for a timesheet. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return status === "final"
    ? <Badge variant="success"><CheckCircle2 />Final</Badge>
    : <Badge variant="secondary">Draft</Badge>;
}
