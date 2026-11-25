import { Users } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";

// Placeholder — replaced by the employees feature at merge.
export function EmployeesPage() {
  return (
    <Page>
      <PageHeader title="Employees" subtitle="Everyone on your team, across locations." titleTestId="text-page-title" />
      <EmptyState icon={Users} title="Employee directory is coming" description="Profiles, PINs and default rates will live here." />
    </Page>
  );
}
