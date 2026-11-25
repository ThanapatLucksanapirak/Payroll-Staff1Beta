import type { AnalysisResult, Site, TimesheetDoc } from "@shared/schema";

export interface WsProps {
  doc: TimesheetDoc;
  result: AnalysisResult;
  site: Site;
  /** Finalized timesheets are read-only until reopened. */
  locked: boolean;
  edit: (fn: (d: TimesheetDoc) => TimesheetDoc, coalesceKey?: string) => void;
}
