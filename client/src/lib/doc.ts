import type { DayAdjustment, EmployeeConfig, ManualEmployee, Shift, Site, TimesheetDoc } from "@shared/schema";
import { employeeKey, shiftEmployeeNames } from "@shared/engine";

export function blankEmployee(name: string, site: Site): EmployeeConfig {
  return {
    name, categoryId: "custom", payBasis: "day_rate", fullDayRate: 0, halfDayRate: 0, hourlyRate: 0,
    isNetPay: site.rules.defaultNetPay, adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "",
  };
}

/** Make sure every name that appears in shifts has a pay config; keep existing ones. */
export function syncEmployees(shifts: Shift[], current: EmployeeConfig[], site: Site, profile: EmployeeConfig[] = []): EmployeeConfig[] {
  const have = new Map(current.map((e) => [employeeKey(e.name), e]));
  const prof = new Map(profile.map((e) => [employeeKey(e.name), e]));
  const out = [...current];
  for (const name of shiftEmployeeNames(shifts)) {
    const k = employeeKey(name);
    if (have.has(k)) continue;
    const p = prof.get(k);
    const e = p ? { ...blankEmployee(name, site), ...p, name, adjustments: {}, bonuses: [], deductions: [] } : blankEmployee(name, site);
    out.push(e);
    have.set(k, e);
  }
  return out;
}

export function applyProfile(current: EmployeeConfig[], profile: EmployeeConfig[]): { employees: EmployeeConfig[]; matched: number } {
  const prof = new Map(profile.map((e) => [employeeKey(e.name), e]));
  let matched = 0;
  const employees = current.map((e) => {
    const p = prof.get(employeeKey(e.name));
    if (!p) return e;
    matched++;
    return { ...e, categoryId: p.categoryId, payBasis: p.payBasis, fullDayRate: p.fullDayRate, halfDayRate: p.halfDayRate, hourlyRate: p.hourlyRate, isNetPay: p.isNetPay };
  });
  return { employees, matched };
}

export function newDoc(site: Site, shifts: Shift[], opts: { source: string; filename: string; label?: string; profile?: EmployeeConfig[] }): TimesheetDoc {
  return {
    siteId: site.id,
    label: opts.label ?? "",
    filename: opts.filename,
    source: opts.source,
    status: "draft",
    notes: "",
    periodStart: "",
    periodEnd: "",
    rules: site.rules,
    shifts,
    employees: syncEmployees(shifts, [], site, opts.profile),
    manualEmployees: [],
  };
}

export function uid(prefix = "x") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(s: string) {
  return s.replace(/[^\w\- .]+/g, "").trim().replace(/\s+/g, "_") || "payroll";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Immutable document operations used by the workspace
// ─────────────────────────────────────────────────────────────────────────────
type Doc = TimesheetDoc;

export function updateEmployee(doc: Doc, name: string, site: Site, fn: (e: EmployeeConfig) => EmployeeConfig): Doc {
  const k = employeeKey(name);
  const i = doc.employees.findIndex((e) => employeeKey(e.name) === k);
  const employees = [...doc.employees];
  if (i < 0) employees.push(fn(blankEmployee(name, site)));
  else employees[i] = fn(employees[i]);
  return { ...doc, employees };
}

export function updateManual(doc: Doc, id: string, fn: (m: ManualEmployee) => ManualEmployee): Doc {
  return { ...doc, manualEmployees: doc.manualEmployees.map((m) => (m.id === id ? fn(m) : m)) };
}

export function blankManual(): ManualEmployee {
  return { id: uid("m"), name: "", payMode: "lump_sum", lumpSum: 0, payDates: [], isNetPay: true, bonuses: [], deductions: [], excluded: false, categoryId: "custom" };
}

export function setAdjustment(doc: Doc, name: string, key: string, site: Site, adj: DayAdjustment | null): Doc {
  return updateEmployee(doc, name, site, (e) => {
    const adjustments = { ...e.adjustments };
    const clean = adj && Object.fromEntries(Object.entries(adj).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false && v !== 0));
    if (!clean || !Object.keys(clean).length) delete adjustments[key];
    else adjustments[key] = clean as DayAdjustment;
    return { ...e, adjustments };
  });
}

export function upsertShift(doc: Doc, shift: Shift): Doc {
  const i = doc.shifts.findIndex((s) => s.id === shift.id);
  const shifts = [...doc.shifts];
  if (i < 0) shifts.push(shift);
  else shifts[i] = shift;
  return { ...doc, shifts };
}

export function deleteShifts(doc: Doc, ids: string[]): Doc {
  const set = new Set(ids);
  return { ...doc, shifts: doc.shifts.filter((s) => !set.has(s.id)) };
}

/** Rename an employee everywhere. If the new name already exists, the two are merged (target's rates win). */
export function renameEmployee(doc: Doc, from: string, to: string): Doc {
  const name = to.trim().replace(/\s+/g, " ");
  if (!name) return doc;
  const fk = employeeKey(from);
  const tk = employeeKey(name);
  const shifts = doc.shifts.map((s) => (employeeKey(s.employee) === fk ? { ...s, employee: name } : s));
  const src = doc.employees.find((e) => employeeKey(e.name) === fk);
  const dst = fk === tk ? undefined : doc.employees.find((e) => employeeKey(e.name) === tk);
  let employees = doc.employees.filter((e) => employeeKey(e.name) !== fk && employeeKey(e.name) !== tk);
  if (src && dst) {
    employees.push({ ...dst, adjustments: { ...src.adjustments, ...dst.adjustments }, bonuses: [...dst.bonuses, ...src.bonuses], deductions: [...dst.deductions, ...src.deductions] });
  } else if (src) {
    employees.push({ ...src, name });
  } else if (dst) {
    employees.push(dst);
  }
  employees = employees.sort((a, b) => a.name.localeCompare(b.name));
  return { ...doc, shifts, employees };
}

export function newManualShift(employee: string, date: string, start: number, end: number, breakMinutes = 0): Shift {
  return { id: uid("s"), employee, date, start, end: end <= start ? end + 1440 : end, breakMinutes, role: "", source: "manual", note: "Added by hand" };
}
