// Converts stored rows (v1 or v2) into a TimesheetDoc, and back.
import {
  type EmployeeConfig, type ManualEmployee, type Shift, type SiteRules, type TimesheetDoc,
  employeeConfigSchema, manualEmployeeSchema, shiftSchema, siteRulesSchema,
} from "./schema";
import { isISODate, parseDateToISO, parseTimeToMinutes } from "./dates";
import { employeeKey, normalizeName } from "./engine";
import { newShiftId, parseCsvText, shiftsToCsv } from "./importers/csv";
import { docPayExtrasSchema } from "./payTypes";

export interface StoredRow {
  id?: string;
  filename?: string | null;
  custom_label?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  result_json?: any;
  wages_json?: any;
  manual_employees_json?: any;
  csv_data?: string | null;
  site_id?: string | null;
  meta_json?: any;
}

const toIso = (d: unknown) => (isISODate(d) ? d : parseDateToISO(d) ?? "");

function normaliseEmployee(raw: any): EmployeeConfig | null {
  const parsed = employeeConfigSchema.safeParse({
    ...raw,
    name: normalizeName(raw?.name ?? ""),
    adjustments: raw?.adjustments ?? {},
    bonuses: Array.isArray(raw?.bonuses) ? raw.bonuses : [],
    deductions: Array.isArray(raw?.deductions) ? raw.deductions : [],
  });
  if (!parsed.success || !parsed.data.name) return null;
  const e = parsed.data;
  const adjustments: EmployeeConfig["adjustments"] = {};
  for (const [k, v] of Object.entries(e.adjustments)) {
    const [d, n] = k.split("#");
    const iso = toIso(d);
    if (iso) adjustments[n ? `${iso}#${n}` : iso] = v;
  }
  return { ...e, adjustments, bonuses: e.bonuses.map((b) => ({ ...b, date: b.date ? toIso(b.date) : "" })) };
}

function normaliseManual(raw: any): ManualEmployee | null {
  const p = manualEmployeeSchema.safeParse({ ...raw, id: String(raw?.id ?? newShiftId("m")) });
  if (!p.success) return null;
  return { ...p.data, payDates: p.data.payDates.map((d) => ({ ...d, date: d.date ? toIso(d.date) || d.date : "" })) };
}

function shiftsFromResult(result: any): Shift[] {
  const out: Shift[] = [];
  for (const emp of result?.employees ?? []) {
    if (emp?.isManual) continue;
    for (const day of emp?.days ?? []) {
      const date = toIso(day?.date);
      const start = parseTimeToMinutes(day?.clockIn);
      let end = parseTimeToMinutes(day?.clockOut);
      if (!date || start == null || end == null) continue;
      if (end <= start) end += 1440;
      out.push({ id: newShiftId("r"), employee: normalizeName(emp.name), date, start, end, breakMinutes: 0, role: "", source: "legacy", note: "" });
    }
  }
  return out;
}

/** Turn any stored row into an editable document. */
export function rowToDoc(row: StoredRow, ctx: { defaultSiteId: string; rules: SiteRules }): TimesheetDoc {
  const meta = row.meta_json && typeof row.meta_json === "object" ? row.meta_json : null;
  const siteId = row.site_id || meta?.siteId || ctx.defaultSiteId;
  const employees = (Array.isArray(row.wages_json) ? row.wages_json : []).map(normaliseEmployee).filter(Boolean) as EmployeeConfig[];
  const manualEmployees = (Array.isArray(row.manual_employees_json) ? row.manual_employees_json : []).map(normaliseManual).filter(Boolean) as ManualEmployee[];

  let shifts: Shift[] = [];
  if (meta?.version >= 2 && Array.isArray(meta.shifts)) {
    shifts = meta.shifts.map((s: any) => shiftSchema.safeParse(s)).filter((r: any) => r.success).map((r: any) => r.data);
  } else {
    if (row.csv_data) shifts = parseCsvText(row.csv_data).shifts.map((s) => ({ ...s, source: s.source === "csv" ? "legacy" : s.source }));
    if (!shifts.length) shifts = shiftsFromResult(row.result_json);
    // v1 kept "Add Day" entries only in the saved result: bring them back as real shifts
    const have = new Set(shifts.map((s) => `${employeeKey(s.employee)}|${s.date}`));
    for (const emp of row.result_json?.employees ?? []) {
      if (emp?.isManual) continue;
      for (const day of emp?.days ?? []) {
        const date = toIso(day?.date);
        const k = `${employeeKey(emp.name ?? "")}|${date}`;
        if (!date || have.has(k) || day?.clockIn === "—") continue;
        const start = parseTimeToMinutes(day?.clockIn);
        let end = parseTimeToMinutes(day?.clockOut);
        if (start == null || end == null) continue;
        if (end <= start) end += 1440;
        shifts.push({ id: newShiftId("add"), employee: normalizeName(emp.name), date, start, end, breakMinutes: 0, role: "", source: "manual", note: "Added day" });
        have.add(k);
      }
    }
    // Adjustments that point at a date without any shift were v1 "Add Day" entries too
    for (const e of employees) {
      for (const [date, adj] of Object.entries(e.adjustments)) {
        if (!isISODate(date) || !adj.overrideStatus || adj.overrideStatus === "absent") continue;
        const k = `${employeeKey(e.name)}|${date}`;
        if (have.has(k)) continue;
        const start = ctx.rules.clockInCutoff;
        const end = ctx.rules.clockOutCutoff > start ? ctx.rules.clockOutCutoff : ctx.rules.clockOutCutoff + 1440;
        shifts.push({ id: newShiftId("add"), employee: e.name, date, start, end, breakMinutes: 0, role: "", source: "manual", note: "Added day (recovered)" });
        have.add(k);
      }
    }
  }

  const rules = siteRulesSchema.safeParse(meta?.rules ?? ctx.rules);
  const payExtras = meta?.payExtras ? docPayExtrasSchema.safeParse(meta.payExtras) : null;
  return {
    ...(payExtras?.success ? { payExtras: payExtras.data } : {}),
    siteId,
    label: row.custom_label ?? "",
    filename: row.filename ?? "",
    source: meta?.source ?? (row.csv_data ? "csv" : "manual"),
    status: meta?.status === "final" ? "final" : "draft",
    notes: typeof meta?.notes === "string" ? meta.notes : "",
    periodStart: toIso(row.period_start) || "",
    periodEnd: toIso(row.period_end) || "",
    rules: rules.success ? rules.data : ctx.rules,
    shifts,
    employees,
    manualEmployees,
  };
}

export function docToMeta(doc: TimesheetDoc) {
  return { version: 2, siteId: doc.siteId, source: doc.source, status: doc.status, notes: doc.notes, rules: doc.rules, shifts: doc.shifts, ...(doc.payExtras ? { payExtras: doc.payExtras } : {}) };
}

export { shiftsToCsv };
