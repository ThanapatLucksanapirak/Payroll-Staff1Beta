import type { DatabaseHealth, TimesheetSummary } from "@shared/schema";
import type { Punch, PunchEdit, PunchFlags, PunchMeta } from "@shared/punches";

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

/** Filter for time-clock punches. `from` is inclusive and `to` exclusive (UTC ISO). */
export interface PunchQuery { siteId?: string; employeeId?: string; from?: string; to?: string; limit?: number }
/** `edits`, `flags` and `meta` share the meta_json column: when patching any of them, pass all three. */
export type PunchPatch = Partial<Pick<Punch, "type" | "at" | "note" | "editedAt" | "edits" | "employeeName" | "flags" | "meta">>;

/** A row of the `punches` table. */
export interface PunchRow {
  id: string; site_id: string; employee_id: string; employee_name: string; type: string; at: string; source: string;
  device_id: string | null; note: string | null; created_at: string; edited_at: string | null; meta_json: any;
}

function metaOf(edits: PunchEdit[] | undefined, flags: PunchFlags | undefined, meta?: PunchMeta) {
  const out: Record<string, unknown> = { ...(meta ?? {}), edits: edits ?? [] };
  delete out.flags;
  if (flags && Object.keys(flags).length) out.flags = flags;
  return out;
}

export function punchToRow(p: Punch): PunchRow {
  return {
    id: p.id, site_id: p.siteId, employee_id: p.employeeId, employee_name: p.employeeName, type: p.type, at: p.at, source: p.source,
    device_id: p.deviceId, note: p.note || null, created_at: p.createdAt, edited_at: p.editedAt, meta_json: metaOf(p.edits, p.flags, p.meta),
  };
}

const isoOf = (v: any) => (v ? new Date(v).toISOString() : null);
export function rowToPunch(r: any): Punch {
  const meta = typeof r.meta_json === "string" ? (() => { try { return JSON.parse(r.meta_json); } catch { return null; } })() : r.meta_json;
  const { edits: _edits, flags: _flags, ...extra } = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : ({} as Record<string, unknown>);
  return {
    id: String(r.id), siteId: r.site_id, employeeId: r.employee_id, employeeName: r.employee_name, type: r.type, at: isoOf(r.at)!,
    source: r.source === "admin" ? "admin" : "kiosk", deviceId: r.device_id ?? null, note: r.note ?? "", createdAt: isoOf(r.created_at)!,
    editedAt: isoOf(r.edited_at), edits: Array.isArray(meta?.edits) ? (meta.edits as PunchEdit[]) : [],
    ...(meta?.flags && typeof meta.flags === "object" ? { flags: meta.flags as PunchFlags } : {}),
    ...(Object.keys(extra).length ? { meta: extra as PunchMeta } : {}),
  };
}

export function patchToRow(patch: PunchPatch): Partial<PunchRow> {
  const out: Partial<PunchRow> = {};
  if (patch.type !== undefined) out.type = patch.type;
  if (patch.at !== undefined) out.at = patch.at;
  if (patch.note !== undefined) out.note = patch.note || null;
  if (patch.editedAt !== undefined) out.edited_at = patch.editedAt;
  if (patch.employeeName !== undefined) out.employee_name = patch.employeeName;
  if (patch.edits !== undefined || patch.flags !== undefined || patch.meta !== undefined) out.meta_json = metaOf(patch.edits, patch.flags, patch.meta);
  return out;
}

/** Most punches one query may return (callers ask for one more to detect overflow). */
export const MAX_PUNCH_QUERY = 100_000;

/**
 * Every punch matching `q`, or a clear 413 error past MAX_PUNCH_QUERY. Never
 * returns a cut-off list (missing punches would mean missing hours or pay).
 */
export async function listPunchesChecked(store: Pick<DataStore, "listPunches">, q: Omit<PunchQuery, "limit">): Promise<Punch[]> {
  const list = await store.listPunches({ ...q, limit: MAX_PUNCH_QUERY + 1 });
  if (list.length > MAX_PUNCH_QUERY) {
    throw new StoreError(`More than ${MAX_PUNCH_QUERY.toLocaleString("en-US")} punches in that range. Choose a shorter date range.`, 413);
  }
  return list;
}

export interface ImportData {
  settings: { key: string; value: string }[];
  timesheets: TimesheetWrite[];
  /** Time-clock punches. Left out = punches are not touched. */
  punches?: Punch[];
}
export interface ImportOptions {
  /**
   * Restore mode: afterwards the store holds exactly the imported data.
   * Settings for which keepSetting(key) is true are never deleted or overwritten.
   */
  replace?: boolean;
  keepSetting?: (key: string) => boolean;
}

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
  importAll(data: ImportData, opts?: ImportOptions): Promise<{ settings: number; timesheets: number; punches: number }>;
  // Time-clock punches (kiosk). Inserting an id that already exists changes nothing.
  listPunches(q: PunchQuery): Promise<Punch[]>;
  getPunch(id: string): Promise<Punch | null>;
  insertPunch(p: Punch): Promise<{ punch: Punch; created: boolean }>;
  updatePunch(id: string, patch: PunchPatch): Promise<Punch | null>;
  deletePunch(id: string): Promise<boolean>;
  allPunches(): Promise<Punch[]>;
  /** All punches (oldest first) a page at a time, so a big export doesn't hold them all in memory. */
  punchPages?(): AsyncGenerator<Punch[]>;
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

-- Time clock (kiosk) punches, added in v3
create table if not exists public.punches (
  id text primary key,
  site_id text not null,
  employee_id text not null,
  employee_name text not null,
  type text not null check (type in ('in', 'break_start', 'break_end', 'out')),
  at timestamptz not null,
  source text not null default 'kiosk',
  device_id text,
  note text,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  meta_json jsonb
);
create index if not exists punches_site_at_idx on public.punches (site_id, at);
create index if not exists punches_employee_at_idx on public.punches (employee_id, at);

-- Lock the tables down. The app connects with the service_role key, which bypasses RLS.
alter table public.app_settings enable row level security;
alter table public.recent_uploads enable row level security;
alter table public.punches enable row level security;
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
