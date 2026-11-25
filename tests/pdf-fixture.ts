// Realistic payroll fixtures for the PDF tests and the sample renderer.
import { computePayroll } from "../shared/engine";
import {
  DEFAULT_RULES, prefsSchema, siteSchema, type AnalysisResult, type Category, type EmployeeConfig, type ManualEmployee, type Prefs, type Shift, type Site,
} from "../shared/schema";
import { addDays } from "../shared/dates";

let n = 0;
const sh = (employee: string, date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift => ({
  id: `s${n++}`, employee, date, start, end, breakMinutes: 0, role: "", source: "csv", note: "", ...extra,
});
const emp = (name: string, extra: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  name, categoryId: "custom", payBasis: "day_rate", fullDayRate: 200, halfDayRate: 100, hourlyRate: 0, isNetPay: true,
  adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", ...extra,
});
const manual = (id: string, name: string, extra: Partial<ManualEmployee> = {}): ManualEmployee => ({
  id, name, payMode: "lump_sum", lumpSum: 0, payDates: [], isNetPay: true, bonuses: [], deductions: [], excluded: false, categoryId: "custom", ...extra,
});

export const START = "2026-11-02"; // Monday
export const rules = { ...DEFAULT_RULES, clockInCutoff: 660, clockOutCutoff: 1230, overtimeEnabled: true, overtimeWeeklyHours: 40, overtimeMultiplier: 1.5 };
export const categories: Category[] = [
  { id: "c1", name: "Kitchen", siteId: null, payBasis: "day_rate", fullDayRate: 220, halfDayRate: 110, hourlyRate: 0, isNetPay: true },
  { id: "c2", name: "Front of house", siteId: null, payBasis: "hourly", fullDayRate: 0, halfDayRate: 0, hourlyRate: 18.5, isNetPay: false },
];

export function site(extra: Partial<Site> = {}): Site {
  return siteSchema.parse({ id: "s1", name: "Downtown", address: "1200 Market Street, Suite 4\nSan Francisco, CA 94103", ...extra });
}
export function prefs(extra: Partial<Prefs> = {}): Prefs {
  return prefsSchema.parse({ businessName: "Harbor Lane Kitchen", ...extra });
}

/** Two weeks, several pay types, overtime, overnight, docks, cancellations, bonuses, deductions, manual + excluded. */
export function realisticResult(): AnalysisResult {
  const shifts: Shift[] = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(START, i);
    if (i % 7 < 5) shifts.push(sh("Maria Santos", d, 600, 1260)); // full days
    if (i % 7 === 5) shifts.push(sh("Maria Santos", d, 600, 900)); // half (left early)
    if (i % 7 < 6) shifts.push(sh("James O'Connor", d, 540, 540 + (i % 7 === 4 ? 11 : 9) * 60, { breakMinutes: 30 })); // hourly, OT
    if (i % 2 === 0) shifts.push(sh("Aiko Tanaka", d, 1080, 1440 + 120)); // overnight
    if (i < 10 && i % 3 !== 2) shifts.push(sh("Dev Patel", d, i === 4 ? 720 : 620, i === 7 ? 1100 : 1240));
  }
  shifts.push(sh("Aiko Tanaka", addDays(START, 0), 600, 700)); // second punch on day 1
  shifts.push(sh("Excluded Person", START, 600, 1260));
  const employees = [
    emp("Maria Santos", {
      categoryId: "c1",
      adjustments: { [addDays(START, 2)]: { dockAmount: 40, note: "Late — 45 min" }, [addDays(START, 8)]: { cancelled: true, note: "Sent home, no pay" } },
      bonuses: [{ date: addDays(START, 4), description: "Catering event", amount: 75 }, { date: "", description: "Perfect attendance", amount: 50 }],
      deductions: [{ description: "Uniform", amount: 35 }],
    }),
    emp("James O'Connor", { categoryId: "c2", isNetPay: false, deductions: [{ description: "Cash advance", amount: 120 }] }),
    emp("Aiko Tanaka", { payBasis: "hourly", hourlyRate: 22, adjustments: { [START]: { overrideStatus: "full_day" } } }),
    emp("Dev Patel", { fullDayRate: 180, halfDayRate: 90, bonuses: [{ date: addDays(START, 12), description: "Holiday cover", amount: 60 }] }),
    emp("Excluded Person", { excluded: true }),
  ];
  const manualEmployees = [
    manual("m1", "Grace Kim (bookkeeping)", { lumpSum: 650, isNetPay: false }),
    manual("m2", "Luis Fernández", { payMode: "by_date", payDates: [{ date: addDays(START, 1), amount: 120, note: "Deep clean" }, { date: addDays(START, 9), amount: 140, note: "Deep clean + windows" }], bonuses: [{ description: "Supplies refund", amount: 22.5 }] }),
    manual("m3", "Left Out Manual", { lumpSum: 999, excluded: true }),
  ];
  return computePayroll({ shifts, employees, manualEmployees, categories, rules });
}

/** `count` day-rate/hourly employees over `days` days. */
export function bigResult(count: number, days: number, nameFn = (i: number) => `Employee ${String(i + 1).padStart(3, "0")}`): AnalysisResult {
  const shifts: Shift[] = [];
  const employees: EmployeeConfig[] = [];
  for (let i = 0; i < count; i++) {
    const name = nameFn(i);
    employees.push(emp(name, i % 3 === 0 ? { payBasis: "hourly", hourlyRate: 15 + (i % 7) } : { fullDayRate: 150 + i, halfDayRate: 75 }));
    for (let d = 0; d < days; d++) if ((d + i) % 7 !== 6) shifts.push(sh(name, addDays(START, d), 600 + ((d * 13 + i) % 90), 1200 + ((d * 7 + i) % 60)));
  }
  return computePayroll({ shifts, employees, manualEmployees: [], categories, rules });
}

export function emptyResult(): AnalysisResult {
  return computePayroll({ shifts: [], employees: [], manualEmployees: [], categories, rules });
}

/** Zero and negative totals: deductions larger than pay, zero-rate employee. */
export function edgeResult(): AnalysisResult {
  return computePayroll({
    shifts: [sh("Zero Rate", START, 600, 1260), sh("Owes Money", START, 600, 1260)],
    employees: [emp("Zero Rate", { fullDayRate: 0, halfDayRate: 0 }), emp("Owes Money", { deductions: [{ description: "Loan repayment", amount: 500 }] })],
    manualEmployees: [manual("z", "Zero Lump", { lumpSum: 0 })],
    categories, rules,
  });
}

/** 1×1 transparent PNG and a 2×1 JPEG-ish PNG for logo tests. */
export const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
