// Owner / manager side of the time clock: punch grouping and problems, auto
// clock-out planning (overnight, DST, time zones), day approval fingerprints,
// the overtime watch, the pre-payroll checklist, and the server routes and job.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Punch, PunchType } from "../shared/punches";
import { punchesToShifts } from "../shared/punches";
import {
  type AutoCloseConfig, buildWorkDays, dayFingerprint, detectIssues, groupShifts, nextLocalTime, openIssues, overtimeWatch, planAutoClose,
} from "../shared/punchIssues";
import { mergeChecklists, punchChecklist, timesheetChecklist } from "../shared/payrollChecklist";
import { computePayroll } from "../shared/engine";
import { DEFAULT_RULES } from "../shared/schema";
import { instantToLocal } from "../shared/dates";

let n = 0;
function p(type: PunchType, at: string, emp = "e1", name = "Ana Ruiz", extra: Partial<Punch> = {}): Punch {
  n++;
  return {
    id: `p${String(n).padStart(8, "0")}`, siteId: "main", employeeId: emp, employeeName: name, type, at: new Date(at).toISOString(),
    source: "kiosk", deviceId: "d1", note: "", createdAt: at, editedAt: null, edits: [], ...extra,
  };
}
const NY = "America/New_York";
const T = (s: string) => Date.parse(s);
const cutoff2am: AutoCloseConfig = { cutoffMinutes: 120, maxShiftHours: 0 };

describe("grouping punches into shifts", () => {
  test("pairs a day shift, counts breaks, files overnight shifts on the start date", () => {
    const g = groupShifts([
      p("in", "2026-01-05T14:00:00Z"), p("break_start", "2026-01-05T17:00:00Z"), p("break_end", "2026-01-05T17:30:00Z"), p("out", "2026-01-05T22:00:00Z"),
      p("in", "2026-01-07T03:00:00Z"), p("out", "2026-01-07T08:15:00Z"), // 22:00 → 03:15 NY
    ], NY, T("2026-01-08T00:00:00Z"));
    assert.equal(g.shifts.length, 2);
    assert.equal(g.strays.length, 0);
    assert.equal(g.shifts[0].date, "2026-01-05");
    assert.equal(g.shifts[0].breakMinutes, 30);
    assert.equal(g.shifts[0].workedMinutes, 8 * 60 - 30);
    assert.equal(g.shifts[1].date, "2026-01-06", "overnight shift belongs to the day it started");
    assert.equal(g.shifts[1].grossMinutes, 5 * 60 + 15);
  });

  test("stray punches and doubled breaks are reported, not paired", () => {
    const g = groupShifts([
      p("out", "2026-01-05T13:00:00Z"),
      p("in", "2026-01-05T14:00:00Z"), p("break_start", "2026-01-05T16:00:00Z"), p("break_start", "2026-01-05T16:05:00Z"),
      p("break_end", "2026-01-05T16:30:00Z"), p("break_end", "2026-01-05T16:31:00Z"), p("out", "2026-01-05T22:00:00Z"),
    ], NY, T("2026-01-06T00:00:00Z"));
    assert.equal(g.shifts.length, 1);
    assert.deepEqual(g.strays.map((s) => s.reason), ["Clock out without a clock-in", "Break started twice", "Break ended without starting"]);
  });

  test("a clock-in during an open shift marks the earlier one as forgotten", () => {
    const g = groupShifts([p("in", "2026-01-05T14:00:00Z"), p("in", "2026-01-06T14:00:00Z"), p("out", "2026-01-06T22:00:00Z")], NY, T("2026-01-07T00:00:00Z"));
    assert.equal(g.shifts.length, 2);
    assert.equal(g.shifts[0].open, true);
    assert.equal(g.shifts[0].superseded, true);
    assert.equal(g.shifts[0].nextInAt, "2026-01-06T14:00:00.000Z");
    assert.equal(g.shifts[1].open, false);
  });

  test("agrees with the payroll import on what is a shift", () => {
    const punches = [
      p("in", "2026-01-05T14:00:00Z"), p("break_start", "2026-01-05T17:00:00Z"), p("out", "2026-01-05T22:00:00Z"),
      p("in", "2026-01-06T03:00:00Z"), p("out", "2026-01-06T21:00:00Z"), // 18h: a clock-out always closes the shift
    ];
    const g = groupShifts(punches, NY, T("2026-01-07T00:00:00Z"));
    const imp = punchesToShifts(punches, { timezone: NY, now: T("2026-01-07T00:00:00Z") });
    assert.equal(g.shifts.length, imp.shifts.length);
    assert.deepEqual(g.shifts.map((s) => s.breakMinutes), imp.shifts.map((s) => s.breakMinutes));
  });
});

describe("punch problems", () => {
  const now = T("2026-01-10T00:00:00Z");
  const issuesOf = (punches: Punch[], opts = {}) => detectIssues(groupShifts(punches, NY, now), { timezone: NY, now, ...opts });

  test("someone still working is not a problem; a forgotten clock-out is", () => {
    const live = issuesOf([p("in", "2026-01-09T20:00:00Z")]);
    assert.equal(live.length, 0);
    const old = issuesOf([p("in", "2026-01-08T14:00:00Z")]);
    assert.equal(old.length, 1);
    assert.equal(old[0].kind, "missing_out");
    assert.equal(old[0].severity, "fix");
    assert.equal(old[0].date, "2026-01-08");
    const fix = old[0].fixes[0];
    assert.equal(fix.kind, "add");
    assert.equal(fix.kind === "add" && fix.type, "out");
    assert.equal(fix.kind === "add" && fix.suggestedAt, "2026-01-08T22:00:00.000Z", "suggests eight hours after the clock-in");
  });

  test("forgotten clock-out followed by another shift: the fix must land before the next clock-in", () => {
    const iss = issuesOf([p("in", "2026-01-08T14:00:00Z"), p("in", "2026-01-08T19:00:00Z"), p("out", "2026-01-08T23:00:00Z")]);
    const mo = iss.find((i) => i.kind === "missing_out")!;
    const fix = mo.fixes[0];
    assert.ok(fix.kind === "add");
    assert.equal(fix.maxAt, "2026-01-08T18:59:00.000Z");
    assert.ok(T(fix.suggestedAt) <= T(fix.maxAt!));
  });

  test("auto-closed shifts need review until the clock-out is edited", () => {
    const flags = { autoClosed: { reason: "cutoff" as const, closedAt: "2026-01-09T07:00:00Z" } };
    const auto = issuesOf([p("in", "2026-01-08T14:00:00Z"), p("out", "2026-01-09T07:00:00Z", "e1", "Ana Ruiz", { source: "admin", flags })]);
    assert.deepEqual(auto.map((i) => i.kind), ["auto_closed"], "not also reported as a long shift");
    assert.equal(auto[0].severity, "review");
    const edited = issuesOf([p("in", "2026-01-08T14:00:00Z"), p("out", "2026-01-08T22:00:00Z", "e1", "Ana Ruiz", {
      source: "admin", flags, editedAt: "2026-01-09T12:00:00Z", edits: [{ editedAt: "2026-01-09T12:00:00Z", note: "left at 5", before: { type: "out", at: "2026-01-09T07:00:00Z" } }],
    })]);
    assert.equal(edited.length, 0);
  });

  test("a break that ran into the clock-out for hours is flagged; a short one is normal", () => {
    const long = issuesOf([p("in", "2026-01-08T14:00:00Z"), p("break_start", "2026-01-08T17:00:00Z"), p("out", "2026-01-08T22:00:00Z")]);
    assert.deepEqual(long.map((i) => i.kind), ["open_break"]);
    const fix = long[0].fixes[0];
    assert.ok(fix.kind === "add" && fix.type === "break_end" && T(fix.suggestedAt) > T("2026-01-08T17:00:00Z") && T(fix.suggestedAt) < T("2026-01-08T22:00:00Z"));
    const short = issuesOf([p("in", "2026-01-08T14:00:00Z"), p("break_start", "2026-01-08T21:30:00Z"), p("out", "2026-01-08T22:00:00Z")]);
    assert.equal(short.length, 0);
  });

  test("very long and very short shifts, using the location's long-shift hours", () => {
    const iss = issuesOf([
      p("in", "2026-01-07T12:00:00Z"), p("out", "2026-01-08T03:00:00Z"), // 15h
      p("in", "2026-01-08T14:00:00Z"), p("out", "2026-01-08T14:01:00Z"), // 1 min
    ], { longShiftHours: 14 });
    assert.deepEqual(iss.map((i) => i.kind).sort(), ["long_shift", "short_shift"]);
    assert.equal(issuesOf([p("in", "2026-01-07T12:00:00Z"), p("out", "2026-01-08T03:00:00Z")], { longShiftHours: 16 }).length, 0);
    const short = iss.find((i) => i.kind === "short_shift")!;
    assert.equal(short.fixes[0].kind, "delete");
  });

  test("stray punches are out-of-order problems with edit and delete fixes", () => {
    const iss = issuesOf([p("break_end", "2026-01-08T15:00:00Z")]);
    assert.equal(iss[0].kind, "out_of_order");
    assert.equal(iss[0].severity, "fix");
    assert.deepEqual(iss[0].fixes.map((f) => f.kind), ["edit", "delete"]);
  });

  test("days are the local start date in the location's time zone", () => {
    // A 7.5 hour break that ran into the clock-out: the problem is filed on the local start date.
    const punches = [p("in", "2026-07-01T01:30:00Z"), p("break_start", "2026-07-01T02:00:00Z"), p("out", "2026-07-01T09:30:00Z")];
    const la = detectIssues(groupShifts(punches, "America/Los_Angeles", now), { timezone: "America/Los_Angeles", now });
    assert.equal(la[0].kind, "open_break");
    assert.equal(la[0].date, "2026-06-30");
    const bk = detectIssues(groupShifts(punches, "Asia/Bangkok", now), { timezone: "Asia/Bangkok", now });
    assert.equal(bk[0].date, "2026-07-01");
  });
});

describe("automatic clock-out", () => {
  test("closes at the configured local time, not at 'now', and only once it has passed", () => {
    const punches = [p("in", "2026-01-05T14:00:00Z")]; // 9:00 AM Mon NY
    assert.deepEqual(planAutoClose(punches, cutoff2am, NY, T("2026-01-06T06:30:00Z")), [], "1:30 AM: not yet");
    const plan = planAutoClose(punches, cutoff2am, NY, T("2026-01-06T15:00:00Z"));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].at, "2026-01-06T07:00:00.000Z", "2:00 AM EST");
    assert.equal(plan[0].reason, "cutoff");
    assert.equal(plan[0].date, "2026-01-05");
    assert.equal(plan[0].endBreak, false);
  });

  test("is idempotent: once the clock-out exists nothing more is planned", () => {
    const punches = [p("in", "2026-01-05T14:00:00Z")];
    const plan = planAutoClose(punches, cutoff2am, NY, T("2026-01-06T15:00:00Z"));
    const closed = [...punches, p("out", plan[0].at, "e1", "Ana Ruiz", { source: "admin" })];
    assert.deepEqual(planAutoClose(closed, cutoff2am, NY, T("2026-01-06T15:00:00Z")), []);
    assert.deepEqual(planAutoClose(closed, cutoff2am, NY, T("2026-01-09T15:00:00Z")), []);
  });

  test("off means off", () => {
    assert.deepEqual(planAutoClose([p("in", "2026-01-05T14:00:00Z")], { cutoffMinutes: null, maxShiftHours: 0 }, NY, T("2026-02-01T00:00:00Z")), []);
  });

  test("overnight: a late shift still running before the cutoff is left alone, then closed at the cutoff", () => {
    const punches = [p("in", "2026-01-06T03:00:00Z")]; // 10 PM NY
    assert.deepEqual(planAutoClose(punches, cutoff2am, NY, T("2026-01-06T06:59:00Z")), []);
    const plan = planAutoClose(punches, cutoff2am, NY, T("2026-01-06T07:05:00Z"));
    assert.equal(plan[0].at, "2026-01-06T07:00:00.000Z");
    assert.equal(plan[0].date, "2026-01-05");
  });

  test("a shift that starts just before the cutoff is not closed minutes later", () => {
    const punches = [p("in", "2026-01-06T06:30:00Z")]; // 1:30 AM NY
    const plan = planAutoClose(punches, cutoff2am, NY, T("2026-01-08T00:00:00Z"));
    assert.equal(plan[0].at, "2026-01-07T07:00:00.000Z", "the next day's 2:00 AM");
  });

  test("ends an open break first, at the same moment", () => {
    const plan = planAutoClose([p("in", "2026-01-05T14:00:00Z"), p("break_start", "2026-01-05T20:00:00Z")], cutoff2am, NY, T("2026-01-06T12:00:00Z"));
    assert.equal(plan[0].endBreak, true);
    assert.equal(plan[0].at, "2026-01-06T07:00:00.000Z");
  });

  test("never closes after a later punch of the same shift", () => {
    // Clocked in 6 PM, started a break at 2:30 AM (after the cutoff) and vanished.
    const plan = planAutoClose([p("in", "2026-01-05T23:00:00Z"), p("break_start", "2026-01-06T07:30:00Z")], cutoff2am, NY, T("2026-01-08T00:00:00Z"));
    assert.equal(plan.length, 1);
    assert.ok(T(plan[0].at) > T("2026-01-06T07:30:00Z"));
    assert.equal(instantToLocal(plan[0].at, NY).minutes, 120);
  });

  test("a forgotten shift followed by a new clock-in closes only if the cutoff falls before it", () => {
    const punches = [p("in", "2026-01-05T14:00:00Z"), p("in", "2026-01-06T06:00:00Z"), p("out", "2026-01-06T10:00:00Z")]; // back at 1 AM
    assert.deepEqual(planAutoClose(punches, cutoff2am, NY, T("2026-01-07T00:00:00Z")), []);
    const early = planAutoClose(punches, { cutoffMinutes: 30, maxShiftHours: 0 }, NY, T("2026-01-07T00:00:00Z"));
    assert.equal(early.length, 1);
    assert.equal(early[0].at, "2026-01-06T05:30:00.000Z");
  });

  test("max shift length as a safety net, alone or with a cutoff (whichever comes first)", () => {
    const punches = [p("in", "2026-01-05T14:00:00Z")];
    const cap = planAutoClose(punches, { cutoffMinutes: null, maxShiftHours: 12 }, NY, T("2026-01-06T03:00:00Z"));
    assert.equal(cap[0].at, "2026-01-06T02:00:00.000Z");
    assert.equal(cap[0].reason, "max_shift");
    const both = planAutoClose(punches, { cutoffMinutes: 120, maxShiftHours: 16 }, NY, T("2026-01-06T12:00:00Z"));
    assert.equal(both[0].at, "2026-01-06T06:00:00.000Z");
    assert.equal(both[0].reason, "max_shift");
    const cutFirst = planAutoClose([p("in", "2026-01-06T01:00:00Z")], { cutoffMinutes: 120, maxShiftHours: 16 }, NY, T("2026-01-06T12:00:00Z")); // 8 PM start
    assert.equal(cutFirst[0].reason, "cutoff");
  });

  test("DST: spring forward (2 AM doesn't exist) still closes that night", () => {
    // 2026-03-08: New York clocks jump from 2:00 to 3:00 AM (07:00Z).
    const plan = planAutoClose([p("in", "2026-03-07T23:00:00Z")], cutoff2am, NY, T("2026-03-08T12:00:00Z"));
    assert.equal(plan.length, 1);
    assert.ok(T(plan[0].at) >= T("2026-03-08T06:00:00Z") && T(plan[0].at) <= T("2026-03-08T07:00:00Z"), plan[0].at);
    assert.equal(instantToLocal(plan[0].at, NY).date, "2026-03-08");
  });

  test("DST: fall back closes at the real 2:00 AM (EST)", () => {
    // 2026-11-01: 2:00 AM EDT becomes 1:00 AM EST at 06:00Z; 2:00 AM EST is 07:00Z.
    const plan = planAutoClose([p("in", "2026-10-31T22:00:00Z")], cutoff2am, NY, T("2026-11-01T12:00:00Z"));
    assert.equal(plan[0].at, "2026-11-01T07:00:00.000Z");
    // And across the change, a 12 hour cap is 12 real hours.
    const cap = planAutoClose([p("in", "2026-10-31T22:00:00Z")], { cutoffMinutes: null, maxShiftHours: 12 }, NY, T("2026-11-01T12:00:00Z"));
    assert.equal(cap[0].at, "2026-11-01T10:00:00.000Z");
  });

  test("uses the location's time zone", () => {
    const at = nextLocalTime(T("2026-07-01T01:30:00Z"), 120, "Asia/Bangkok"); // 8:30 AM Bangkok
    assert.equal(new Date(at).toISOString(), "2026-07-01T19:00:00.000Z", "next 2:00 AM Bangkok");
    const plan = planAutoClose([p("in", "2026-07-01T01:30:00Z")], cutoff2am, "Asia/Bangkok", T("2026-07-02T00:00:00Z"));
    assert.equal(plan[0].at, "2026-07-01T19:00:00.000Z");
  });
});

describe("work days and approval", () => {
  const now = T("2026-01-10T00:00:00Z");
  const punches = () => [
    p("in", "2026-01-08T14:00:00Z", "e1"), p("out", "2026-01-08T22:00:00Z", "e1"),
    p("in", "2026-01-08T15:00:00Z", "e2", "Ben Lee"),
    p("in", "2026-01-09T03:00:00Z", "e1"), p("out", "2026-01-09T08:00:00Z", "e1"), // overnight from the 8th
  ];

  test("an overnight shift belongs to its start day; approvable and clean days", () => {
    const days = buildWorkDays(punches(), { timezone: NY, now, start: "2026-01-08", end: "2026-01-09" });
    assert.equal(days.length, 2);
    const ana = days.find((d) => d.employeeId === "e1")!;
    assert.equal(ana.date, "2026-01-08");
    assert.equal(ana.shifts.length, 2);
    assert.equal(ana.workedMinutes, 8 * 60 + 5 * 60);
    assert.equal(ana.clean, true);
    const ben = days.find((d) => d.employeeId === "e2")!;
    assert.equal(ben.approvable, false, "missing clock-out must be fixed first");
    assert.equal(openIssues(days).length, 1);
  });

  test("approval holds until the day's punches change", () => {
    const ps = punches();
    const days = buildWorkDays(ps, { timezone: NY, now, start: "2026-01-08", end: "2026-01-09" });
    const ana = days.find((d) => d.employeeId === "e1")!;
    const approvals = { "2026-01-08": { e1: { at: "x", by: "u1", byName: "Owner", fp: ana.fingerprint } } };
    assert.equal(buildWorkDays(ps, { timezone: NY, now, start: "2026-01-08", end: "2026-01-09", approvals }).find((d) => d.employeeId === "e1")!.approved, true);
    const edited = ps.map((x, i) => (i === 1 ? { ...x, at: "2026-01-08T21:30:00.000Z", editedAt: "2026-01-09T12:00:00Z" } : x));
    const after = buildWorkDays(edited, { timezone: NY, now, start: "2026-01-08", end: "2026-01-09", approvals }).find((d) => d.employeeId === "e1")!;
    assert.equal(after.approved, false);
    assert.equal(after.approvalStale, true);
    // A note-only edit also clears it (any edit counts).
    const noteOnly = ps.map((x, i) => (i === 1 ? { ...x, editedAt: "2026-01-09T12:00:00Z" } : x));
    assert.equal(buildWorkDays(noteOnly, { timezone: NY, now, start: "2026-01-08", end: "2026-01-09", approvals }).find((d) => d.employeeId === "e1")!.approved, false);
  });

  test("fingerprints ignore order and change with any punch", () => {
    const a = p("in", "2026-01-08T14:00:00Z"), b = p("out", "2026-01-08T22:00:00Z");
    assert.equal(dayFingerprint([a, b]), dayFingerprint([b, a]));
    assert.notEqual(dayFingerprint([a, b]), dayFingerprint([a]));
    assert.notEqual(dayFingerprint([a, b]), dayFingerprint([a, { ...b, type: "break_start" }]));
  });

  test("approving a day accepts its review items (auto-closed) but not fix items", () => {
    const flags = { autoClosed: { reason: "cutoff" as const, closedAt: "x" } };
    const ps = [p("in", "2026-01-08T14:00:00Z"), p("out", "2026-01-09T07:00:00Z", "e1", "Ana Ruiz", { source: "admin", flags })];
    const d0 = buildWorkDays(ps, { timezone: NY, now, start: "2026-01-08", end: "2026-01-08" })[0];
    assert.equal(d0.approvable, true);
    assert.equal(d0.clean, false);
    assert.equal(openIssues([d0]).length, 1);
    const approvals = { "2026-01-08": { e1: { at: "x", by: null, byName: "", fp: d0.fingerprint } } };
    assert.equal(openIssues(buildWorkDays(ps, { timezone: NY, now, start: "2026-01-08", end: "2026-01-08", approvals })).length, 0);
  });
});

describe("overtime watch", () => {
  const rules = { ...DEFAULT_RULES, overtimeEnabled: true, overtimeWeeklyHours: 40, overtimeDailyHours: 0, weekStartsOn: 1, timezone: NY };
  // Week of Mon 2026-01-05 (NY). 9 AM = 14:00Z.
  const day = (d: number, hours: number, emp: string, name: string) => [p("in", `2026-01-0${d}T14:00:00Z`, emp, name), p("out", new Date(T(`2026-01-0${d}T14:00:00Z`) + hours * 3600_000).toISOString(), emp, name)];

  test("near: working now and about to cross; shows when", () => {
    const now = T("2026-01-09T16:00:00Z"); // Fri 11 AM
    const punches = [...day(5, 9, "a", "Ana"), ...day(6, 9, "a", "Ana"), ...day(7, 9, "a", "Ana"), ...day(8, 9, "a", "Ana"), p("in", "2026-01-09T14:00:00Z", "a", "Ana")];
    const [ana] = overtimeWatch(punches, { rules, now });
    assert.equal(ana.weekMinutes, 38 * 60);
    assert.equal(ana.state, "near");
    assert.equal(ana.minutesLeft, 120);
    assert.equal(ana.crossesAt, "2026-01-09T18:00:00.000Z");
  });

  test("over, pace and ok, sorted by urgency; off when overtime is off", () => {
    const now = T("2026-01-08T17:00:00Z"); // Thu noon
    const punches = [
      ...day(5, 14, "o", "Olga"), ...day(6, 14, "o", "Olga"), ...day(7, 14, "o", "Olga"), // 42h
      ...day(5, 11, "p", "Paz"), ...day(6, 11, "p", "Paz"), ...day(7, 11, "p", "Paz"), // 33h by Thu noon: on pace for 66h
      ...day(5, 4, "k", "Kim"),
    ];
    const list = overtimeWatch(punches, { rules, now });
    assert.deepEqual(list.map((e) => [e.employeeName, e.state]), [["Olga", "over"], ["Paz", "pace"], ["Kim", "ok"]]);
    const pace = overtimeWatch([...day(5, 10, "p", "Paz"), ...day(6, 10, "p", "Paz")], { rules, now: T("2026-01-07T17:00:00Z") });
    assert.equal(pace[0].state, "pace");
    assert.ok(pace[0].projectedWeekMinutes > 40 * 60);
    assert.deepEqual(overtimeWatch(punches, { rules: { ...rules, overtimeEnabled: false }, now }), []);
  });

  test("daily overtime limit", () => {
    const now = T("2026-01-05T21:30:00Z"); // 4:30 PM, in since 9 AM = 7.5h
    const list = overtimeWatch([p("in", "2026-01-05T14:00:00Z", "a", "Ana")], { rules: { ...rules, overtimeDailyHours: 8 }, now });
    assert.equal(list[0].state, "near");
    assert.equal(list[0].limit, "daily");
    assert.equal(list[0].crossesAt, "2026-01-05T22:00:00.000Z");
  });

  test("the week starts on the location's week-start day in its time zone", () => {
    // Sunday 11 PM NY (Mon 04:00Z) shift belongs to the previous week when weeks start Monday.
    const now = T("2026-01-05T15:00:00Z");
    const list = overtimeWatch([p("in", "2026-01-04T23:00:00Z", "a", "Ana"), p("out", "2026-01-05T04:00:00Z", "a", "Ana")], { rules, now });
    assert.equal(list.length, 0, "nothing this week yet");
  });
});

describe("pre-payroll checklist", () => {
  test("lists open shifts, problems, auto-closed and unapproved days, missing rates", () => {
    const now = T("2026-01-10T00:00:00Z");
    const flags = { autoClosed: { reason: "cutoff" as const, closedAt: "x" } };
    const days = buildWorkDays([
      p("in", "2026-01-08T14:00:00Z", "e1"), p("out", "2026-01-09T07:00:00Z", "e1", "Ana Ruiz", { source: "admin", flags }),
      p("in", "2026-01-07T15:00:00Z", "e2", "Ben Lee"),
      p("in", "2026-01-09T22:00:00Z", "e3", "Cara Diaz"),
    ], { timezone: NY, now, start: "2026-01-05", end: "2026-01-11" });
    const items = punchChecklist(days, { start: "2026-01-05", end: "2026-01-11" }, ["Ben Lee"]);
    const ids = items.map((i) => i.id);
    assert.deepEqual(ids, ["working", "punch-problems", "auto-closed", "unapproved", "no-rate"]);
    assert.equal(items.find((i) => i.id === "punch-problems")!.href, "/live/fix/2026-01-05/2026-01-11");
    assert.equal(items.find((i) => i.id === "unapproved")!.count, 2, "the open shift isn't counted as unapproved");
    assert.deepEqual(punchChecklist([], { start: "2026-01-05", end: "2026-01-11" }), []);
  });

  test("timesheet lines replace the saved-rate check", () => {
    const result = computePayroll({
      shifts: [{ id: "s1", employee: "Ana Ruiz", date: "2026-01-05", start: 13 * 60, end: 14 * 60, breakMinutes: 0, role: "", source: "kiosk", note: "" }],
      employees: [], manualEmployees: [], categories: [], rules: DEFAULT_RULES,
    });
    const ts = timesheetChecklist(result);
    assert.deepEqual(ts.map((i) => i.id).sort(), ["flagged", "no-rate"]);
    assert.equal(ts.find((i) => i.id === "no-rate")!.tab, "rates");
    const merged = mergeChecklists([{ id: "no-rate", severity: "fix", title: "", detail: "", count: 1, href: null, linkLabel: "", names: [] }], ts);
    assert.equal(merged.filter((i) => i.id === "no-rate").length, 1);
    assert.equal(merged[0].severity, "fix");
  });
});

// ── Server ────────────────────────────────────────────────────────────────────
describe("server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-timeclock-"));
  let base = "";
  let server: Server;
  let owner = "";
  let siteId = "";
  let ana = "";
  let ben = "";

  async function call(method: string, url: string, body?: unknown, cookie = owner) {
    const hs: Record<string, string> = { Cookie: cookie, "X-Requested-With": "payroll" };
    if (body !== undefined) hs["Content-Type"] = "application/json";
    const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  before(async () => {
    process.env.DATA_DIR = dir;
    process.env.BACKUPS = "off";
    delete process.env.SETUP_CODE;
    delete process.env.SUPABASE_URL;
    delete process.env.KIOSK_HOST;
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const routes = await import("../server/routes");
    const { initDatabase } = await import("../server/db");
    await initDatabase();
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    routes.registerRoutes(app);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const code = (await import("../server/auth")).getSetupCode();
    const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: code }, "");
    owner = (setup.headers.get("set-cookie") ?? "").split(";")[0];
    siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
    await call("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", rules: { timezone: "UTC", overtimeEnabled: true, overtimeWeeklyHours: 40 } });
    ana = (await call("POST", `/api/sites/${siteId}/employees`, { name: "Ana Ruiz", pin: "1234" })).body.id;
    ben = (await call("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "5678" })).body.id;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    const { closeDatabase } = await import("../server/db");
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("auto clock-out settings: defaults off, validated, admin only to change", async () => {
    const r = await call("GET", `/api/sites/${siteId}/timeclock/auto-close`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.config, { cutoffMinutes: null, maxShiftHours: 0 });
    assert.equal((await call("PUT", `/api/sites/${siteId}/timeclock/auto-close`, { cutoffMinutes: 2000 })).status, 400);
    assert.equal((await call("GET", `/api/sites/nope/timeclock/auto-close`)).status, 404);
    assert.equal((await call("GET", `/api/sites/${siteId}/timeclock/review`, undefined, "")).status, 401);
    // A manager can read and approve but not change the setting.
    await call("POST", "/api/users", { username: "mgr", password: "password-123", role: "manager", siteIds: [] });
    const login = await call("POST", "/api/auth/login", { username: "mgr", password: "password-123" }, "");
    const mgr = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal((await call("GET", `/api/sites/${siteId}/timeclock/review`, undefined, mgr)).status, 200);
    assert.equal((await call("PUT", `/api/sites/${siteId}/timeclock/auto-close`, { maxShiftHours: 12 }, mgr)).status, 403);
    assert.equal((await call("POST", `/api/sites/${siteId}/timeclock/auto-close/run`, {}, mgr)).status, 200);
  });

  test("closes a forgotten shift at the cutoff with a flagged, noted punch; runs once", async () => {
    // Ana clocked in 20 hours ago and is on a break; the safety net is 12 hours.
    assert.equal((await call("POST", `/api/sites/${siteId}/punches`, { employeeId: ana, type: "in", at: ago(20), note: "test" })).status, 200);
    assert.equal((await call("POST", `/api/sites/${siteId}/punches`, { employeeId: ana, type: "break_start", at: ago(15), note: "test" })).status, 200);
    const saved = await call("PUT", `/api/sites/${siteId}/timeclock/auto-close`, { cutoffMinutes: null, maxShiftHours: 12 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.closed, 1, "applies right away");
    const punches = (await call("GET", `/api/sites/${siteId}/punches?start=${ago(30).slice(0, 10)}&end=${new Date().toISOString().slice(0, 10)}`)).body as Punch[];
    const mine = punches.filter((x) => x.employeeId === ana);
    assert.deepEqual(mine.map((x) => x.type), ["in", "break_start", "break_end", "out"]);
    const out = mine[3];
    assert.equal(out.note, "Auto-closed: forgot to clock out");
    assert.equal(out.source, "admin");
    assert.equal(out.flags?.autoClosed?.reason, "max_shift");
    assert.equal(Math.round((Date.parse(out.at) - Date.parse(mine[0].at)) / 3600_000), 12, "closed at the cap, not now");
    assert.equal(mine[2].at, out.at);
    const again = await call("POST", `/api/sites/${siteId}/timeclock/auto-close/run`, {});
    assert.deepEqual(again.body.closed, []);
    const { runAutoClose } = await import("../server/timeclock");
    assert.deepEqual(await Promise.all([runAutoClose(), runAutoClose()]).then((r) => r.flat()), []);
  });

  test("review lists the auto-closed shift; fixing it through the punch edit keeps the flag and resolves it", async () => {
    let r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    assert.equal(r.status, 200);
    const issue = r.body.issues.find((i: any) => i.kind === "auto_closed");
    assert.ok(issue, JSON.stringify(r.body.issues));
    const fix = issue.fixes[0];
    assert.equal(fix.linkedPunchIds.length, 1, "the automatic break end moves with the clock-out");
    // Moving earlier: the linked break end first, then the clock-out (what the Fix punches screen does).
    assert.equal((await call("PATCH", `/api/punches/${fix.linkedPunchIds[0]}`, { at: ago(10), note: "Left at closing" })).status, 200);
    const edited = await call("PATCH", `/api/punches/${fix.punchId}`, { at: ago(10), note: "Left at closing" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.ok(edited.body.flags?.autoClosed, "the flag survives the edit");
    assert.equal(edited.body.edits.length, 1);
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    assert.equal(r.body.issues.filter((i: any) => i.kind === "auto_closed").length, 0);
  });

  test("approve a day, approve all clean days, and edits clear approval", async () => {
    // Ben: a clean shift yesterday.
    await call("POST", `/api/sites/${siteId}/punches`, { employeeId: ben, type: "in", at: ago(30), note: "t" });
    await call("POST", `/api/sites/${siteId}/punches`, { employeeId: ben, type: "out", at: ago(26), note: "t" });
    let r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    const benDay = r.body.days.find((d: any) => d.employeeId === ben);
    assert.equal(benDay.clean, true);
    assert.equal(benDay.approved, false);
    const clean = await call("POST", `/api/sites/${siteId}/timeclock/approvals`, { clean: { start: r.body.start, end: r.body.end } });
    assert.equal(clean.status, 200);
    assert.ok(clean.body.changed >= 1);
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    assert.equal(r.body.days.find((d: any) => d.employeeId === ben).approved, true);
    assert.ok(r.body.days.find((d: any) => d.employeeId === ben).approval.byName);

    // Editing one of Ben's punches clears the approval.
    await call("PATCH", `/api/punches/${benDay.shifts[0].outId}`, { at: ago(25), note: "Stayed late" });
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    const after = r.body.days.find((d: any) => d.employeeId === ben);
    assert.equal(after.approved, false);
    assert.equal(after.approvalStale, true);

    // Approve explicitly, then un-approve.
    assert.equal((await call("POST", `/api/sites/${siteId}/timeclock/approvals`, { days: [{ employeeId: ben, date: after.date }] })).body.changed, 1);
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    assert.equal(r.body.days.find((d: any) => d.employeeId === ben).approved, true);
    assert.equal((await call("POST", `/api/sites/${siteId}/timeclock/approvals`, { approve: false, days: [{ employeeId: ben, date: after.date }] })).body.changed, 1);
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    assert.equal(r.body.days.find((d: any) => d.employeeId === ben).approved, false);
    assert.equal(r.body.days.find((d: any) => d.employeeId === ben).approvalStale, false);

    // A day still being worked can't be approved.
    await call("POST", `/api/sites/${siteId}/punches`, { employeeId: ben, type: "in", at: ago(1), note: "t" });
    r = await call("GET", `/api/sites/${siteId}/timeclock/review`);
    const today = r.body.days.find((d: any) => d.employeeId === ben && d.working);
    const res = await call("POST", `/api/sites/${siteId}/timeclock/approvals`, { days: [{ employeeId: ben, date: today.date }] });
    assert.equal(res.body.changed, 0);
    assert.match(res.body.skipped[0].reason, /clocked in/);
    assert.equal((await call("POST", `/api/sites/${siteId}/timeclock/approvals`, {})).status, 400);
  });

  test("overtime watch and checklist endpoints", async () => {
    const ot = await call("GET", `/api/sites/${siteId}/timeclock/overtime`);
    assert.equal(ot.status, 200);
    assert.equal(ot.body.enabled, true);
    assert.ok(Array.isArray(ot.body.employees));
    // Day-rate staff are left out of the overtime watch.
    await call("PUT", `/api/sites/${siteId}/wages`, [{ name: "Ben Lee", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50 }]);
    const ot2 = await call("GET", `/api/sites/${siteId}/timeclock/overtime`);
    assert.ok(!ot2.body.employees.some((e: any) => e.employeeId === ben));

    const cl = await call("GET", `/api/sites/${siteId}/timeclock/checklist`);
    assert.equal(cl.status, 200);
    const ids = cl.body.items.map((i: any) => i.id);
    assert.ok(ids.includes("working"), ids.join());
    assert.ok(ids.includes("no-rate"), "Ana has no saved rate");
    assert.deepEqual(cl.body.items.find((i: any) => i.id === "no-rate").names, ["Ana Ruiz"]);
    assert.equal((await call("GET", `/api/sites/${siteId}/timeclock/checklist?start=2026-01-10&end=2026-01-01`)).status, 400);
    assert.equal((await call("GET", `/api/sites/${siteId}/timeclock/checklist?start=2025-01-01&end=2026-01-01`)).status, 400);
  });

  test("live: a stalled client is disconnected instead of buffering without limit", async () => {
    const live = await import("../server/live");
    const http = await import("node:http");
    const { ticket } = (await call("POST", "/api/live/ticket", {})).body;
    const before = live.liveClientCount();
    // Connect and then stop reading, like a laptop that went to sleep.
    const req = http.get(`${base}/api/live?ticket=${encodeURIComponent(ticket)}`);
    const res = await new Promise<import("node:http").IncomingMessage>((r) => req.on("response", r));
    res.pause();
    for (let i = 0; i < 50 && live.liveClientCount() === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(live.liveClientCount(), before + 1);
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 2000 && live.liveClientCount() > before; i++) {
      live.broadcast({ type: "test", blob: big });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(live.liveClientCount(), before, "the stalled client was dropped");
    req.destroy();
  });

  test("audit entries are appended to a monthly file, and still read back", async () => {
    const { flushAudit, queryAudit } = await import("../server/audit");
    await flushAudit();
    const month = new Date().toISOString().slice(0, 7);
    const file = path.join(dir, "audit", `${month}.jsonl`);
    const before = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    assert.ok(before > 0);
    await call("POST", `/api/sites/${siteId}/timeclock/approvals`, { approve: false, days: [{ employeeId: ana, date: new Date().toISOString().slice(0, 10) }] });
    await flushAudit();
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, before + 1, "one line appended, nothing rewritten");
    assert.equal(JSON.parse(lines[lines.length - 1]).action, "timeclock.unapprove");
    const q = await queryAudit({ action: "timeclock" });
    assert.ok(q.entries.some((e) => e.action === "timeclock.unapprove"));
    assert.ok(q.entries.some((e) => e.action === "timeclock.auto_close" && e.userName === "System"));
    const { db } = await import("../server/db");
    assert.equal(await (await db()).getSetting(`audit:${month}`), null, "the settings value is no longer rewritten");
  });

  test("auto clock-out settings and approvals are in the backup; flags survive restore", async () => {
    const b = await call("GET", "/api/backup");
    const keys = b.body.settings.map((s: any) => s.key);
    assert.ok(keys.includes(`timeclock:${siteId}`));
    assert.ok(keys.includes(`timeclock_approvals:${siteId}`));
    const auto = b.body.punches.find((x: any) => x.flags?.autoClosed);
    assert.ok(auto);
    const { punchSchema } = await import("../shared/punches");
    assert.equal(punchSchema.parse(auto).flags?.autoClosed?.reason, "max_shift");
    assert.equal(punchSchema.parse({ ...auto, flags: "junk" }).flags, undefined, "bad flags are dropped, not fatal");
  });
});
