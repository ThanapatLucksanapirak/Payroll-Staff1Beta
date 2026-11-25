import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Draft / Final pill for a timesheet. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return status === "final"
    ? <Badge variant="success" title="Finalized and locked"><Lock />Final</Badge>
    : <Badge variant="secondary">Draft</Badge>;
}
