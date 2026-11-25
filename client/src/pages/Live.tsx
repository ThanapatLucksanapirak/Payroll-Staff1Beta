import { Radio } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";

// Placeholder — replaced by the kiosk/live feature at merge.
export function LivePage() {
  return (
    <Page>
      <PageHeader title="Live" subtitle="Who is clocked in right now." titleTestId="text-page-title" />
      <EmptyState icon={Radio} title="Live view is coming" description="Clock-ins from the employee kiosk will show up here in real time." />
    </Page>
  );
}
