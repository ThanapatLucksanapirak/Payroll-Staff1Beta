import type { DatabaseHealth, TimesheetSummary } from "@shared/schema";

/** A row of the `recent_uploads` table (legacy name kept for compatibility). */
export interface TimesheetRow {
  id: string;
  filename: string;
  custom_label: string | null;
  period_start: string | null;
  period_end: string | null;
  employee_count: number;
  total_pay: number;
  result_json: any;
  wages_json: any;
  manual_employees_json: any;
  csv_data: string | null;
  site_id: string | null;
  meta_json: any;
  created_at: string;
  updated_at: string | null;
}

export type TimesheetWrite = Omit<TimesheetRow, "id" | "created_at" | "updated_at"> & { id?: string; created_at?: string };

export interface DataStore {
  readonly kind: "sqlite" | "supabase";
  readonly label: string;
  init(): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  getSettings(keys: string[]): Promise<Record<string, string>>;
  allSettings(): Promise<{ key: string; value: string }[]>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  listTimesheets(): Promise<TimesheetSummary[]>;
  getTimesheet(id: string): Promise<TimesheetRow | null>;
  allTimesheets(): Promise<TimesheetRow[]>;
  insertTimesheet(row: TimesheetWrite): Promise<TimesheetSummary>;
  updateTimesheet(id: string, row: Partial<TimesheetWrite>): Promise<TimesheetSummary | null>;
  deleteTimesheet(id: string): Promise<boolean>;
  /**
   * Write many settings and timesheets as one unit: either everything is
   * written or nothing is (used by restore and database copy).
   */
  importAll(data: { settings: { key: string; value: string }[]; timesheets: TimesheetWrite[] }): Promise<{ settings: number; timesheets: number }>;
  /** Write a consistent snapshot of the database to a file, if the store supports it. */
  snapshotTo?(file: string): Promise<void>;
  health(): Promise<DatabaseHealth>;
  close(): void;
}

export class StoreError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export const SETUP_SQL = `-- Payroll Admin: run once in the Supabase SQL editor
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

create table if not exists public.recent_uploads (
  id uuid primary key default gen_random_uuid(),
  filename text not null default '',
  custom_label text,
  period_start text,
  period_end text,
  employee_count integer not null default 0,
  total_pay numeric not null default 0,
  result_json jsonb,
  wages_json jsonb,
  manual_employees_json jsonb,
  csv_data text,
  site_id text,
  meta_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- Columns added in v2 (safe to run on an existing database)
alter table public.recent_uploads add column if not exists site_id text;
alter table public.recent_uploads add column if not exists meta_json jsonb;
create index if not exists recent_uploads_site_idx on public.recent_uploads (site_id, updated_at desc);

-- Lock the tables down. The app connects with the service_role key, which bypasses RLS.
alter table public.app_settings enable row level security;
alter table public.recent_uploads enable row level security;
`;

export function toSummary(r: any): TimesheetSummary {
  return {
    id: String(r.id),
    siteId: r.site_id ?? null,
    filename: r.filename ?? "",
    customLabel: r.custom_label ?? null,
    periodStart: r.period_start ?? null,
    periodEnd: r.period_end ?? null,
    employeeCount: Number(r.employee_count) || 0,
    totalPay: Number(r.total_pay) || 0,
    status: r.status ?? "draft",
    deletedAt: r.deleted_at ?? null,
    createdAt: r.created_at ?? new Date().toISOString(),
    updatedAt: r.updated_at ?? null,
  };
}
