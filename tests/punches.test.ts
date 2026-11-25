import { test } from "node:test";
import assert from "node:assert/strict";
import { type Punch, type PunchType, clockState, punchesToShifts, sequenceIssues, validateChange, workedMinutes, localRange, allowedActions } from "../shared/punches";
import { shiftSchema } from "../shared/schema";

let n = 0;
function p(type: PunchType, at: string, emp = "e1", name = "Ana Ruiz", extra: Partial<Punch> = {}): Punch {
  n++;
  return {
    id: `p${String(n).padStart(8, "0")}`, siteId: "main", employeeId: emp, employeeName: name, type, at: new Date(at).toISOString(),
    source: "kiosk", deviceId: "d1", note: "", createdAt: at, editedAt: null, edits: [], ...extra,
  };
}
const NY = "America/New_York";

test("pairs in/out into a shift in the site time zone, with breaks", () => {
  // 9:02 → 17:30 New York (UTC-5 in January), 30-minute break
  const r = punchesToShifts([
    p("in", "2026-01-05T14:02:00Z"), p("break_start", "2026-01-05T17:00:00Z"), p("break_end", "2026-01-05T17:30:00Z"), p("out", "2026-01-05T22:30:00Z"),
  ], { timezone: NY });
  assert.equal(r.shifts.length, 1);
  const s = r.shifts[0];
  assert.equal(s.date, "2026-01-05");
  assert.equal(s.start, 9 * 60 + 2);
  assert.equal(s.end, 17 * 60 + 30);
  assert.equal(s.breakMinutes, 30);
  assert.equal(s.source, "kiosk");
  assert.equal(s.employee, "Ana Ruiz");
  assert.equal(r.warnings.length, 0);
  assert.ok(shiftSchema.safeParse(s).success, "valid Shift");
});

test("several breaks add up; clocking out during a break ends it", () => {
  const r = punchesToShifts([
    p("in", "2026-01-05T14:00:00Z"),
    p("break_start", "2026-01-05T16:00:00Z"), p("break_end", "2026-01-05T16:10:00Z"),
    p("break_start", "2026-01-05T18:00:00Z"), p("break_end", "2026-01-05T18:20:00Z"),
    p("break_start", "2026-01-05T21:45:00Z"), p("out", "2026-01-05T22:00:00Z"),
  ], { timezone: NY });
  assert.equal(r.shifts[0].breakMinutes, 10 + 20 + 15);
});

test("overnight shifts belong to the start date and end after midnight", () => {
  // 22:00 → 03:15 next day, New York
  const r = punchesToShifts([p("in", "2026-01-06T03:00:00Z"), p("out", "2026-01-06T08:15:00Z")], { timezone: NY });
  assert.equal(r.shifts[0].date, "2026-01-05");
  assert.equal(r.shifts[0].start, 22 * 60);
  assert.equal(r.shifts[0].end, 1440 + 3 * 60 + 15);
});

test("uses the location's time zone, not the server's", () => {
  const punches = [p("in", "2026-07-01T01:30:00Z"), p("out", "2026-07-01T09:30:00Z")];
  const bkk = punchesToShifts(punches, { timezone: "Asia/Bangkok" }).shifts[0]; // UTC+7
  assert.equal(bkk.date, "2026-07-01");
  assert.equal(bkk.start, 8 * 60 + 30);
  const la = punchesToShifts(punches, { timezone: "America/Los_Angeles" }).shifts[0]; // UTC-7 (PDT)
  assert.equal(la.date, "2026-06-30");
  assert.equal(la.start, 18 * 60 + 30);
  assert.equal(la.end, 18 * 60 + 30 + 480);
});

test("a shift across a DST change counts real elapsed time", () => {
  // US clocks spring forward 2026-03-08 02:00 → 03:00. 22:00 → 06:00 local is 7 real hours.
  const r = punchesToShifts([p("in", "2026-03-08T03:00:00Z"), p("out", "2026-03-08T10:00:00Z")], { timezone: NY });
  assert.equal(r.shifts[0].end - r.shifts[0].start, 7 * 60);
});

test("open shifts are skipped and reported as warnings", () => {
  const now = Date.parse("2026-01-07T12:00:00Z");
  const r = punchesToShifts([
    p("in", "2026-01-05T14:00:00Z", "e1"), // never clocked out (stale)
    p("in", "2026-01-06T14:00:00Z", "e1"), p("out", "2026-01-06T22:00:00Z", "e1"),
    p("in", "2026-01-07T11:00:00Z", "e2", "Ben Lee"), // still working
    p("out", "2026-01-06T22:00:00Z", "e3", "Cy Day"), // orphan clock-out
  ], { timezone: NY, now });
  assert.equal(r.shifts.length, 1);
  assert.equal(r.shifts[0].date, "2026-01-06");
  assert.equal(r.open.length, 2);
  assert.ok(r.warnings.some((w) => /Ana Ruiz clocked in .* with no clock-out/.test(w)));
  assert.ok(r.warnings.some((w) => /Ben Lee is still clocked in/.test(w)));
  assert.ok(r.warnings.some((w) => /Cy Day: clock out .* without a clock-in/.test(w)));
});

test("date range filter keeps shifts by their start date; current names win", () => {
  const r = punchesToShifts([
    p("in", "2026-01-04T14:00:00Z"), p("out", "2026-01-04T22:00:00Z"),
    p("in", "2026-01-05T14:00:00Z"), p("out", "2026-01-05T22:00:00Z"),
  ], { timezone: NY, start: "2026-01-05", end: "2026-01-05", names: { e1: "Ana  Ruiz-Lopez" } });
  assert.equal(r.shifts.length, 1);
  assert.equal(r.shifts[0].employee, "Ana Ruiz-Lopez");
});

test("state transitions", () => {
  assert.deepEqual(allowedActions("out"), ["in"]);
  assert.deepEqual(allowedActions("in"), ["break_start", "out"]);
  assert.deepEqual(allowedActions("break"), ["break_end", "out"]);
  const a = p("in", "2026-01-05T14:00:00Z");
  const now = Date.parse("2026-01-05T15:00:00Z");
  assert.equal(clockState([a], now).status, "in");
  assert.equal(clockState([a, p("break_start", "2026-01-05T14:30:00Z")], now).status, "break");
  // An open shift from 20 hours ago is treated as forgotten
  assert.equal(clockState([a], Date.parse("2026-01-06T10:00:00Z")).stale, true);
  assert.equal(clockState([a], Date.parse("2026-01-06T10:00:00Z")).status, "out");

  const dup = p("in", "2026-01-05T14:05:00Z");
  assert.equal(validateChange([a], [a, dup], NY, "kiosk"), "You're already clocked in.");
  const brk = p("break_end", "2026-01-05T14:05:00Z");
  assert.equal(validateChange([a], [a, brk], NY, "kiosk"), "You're not on a break.");
  const out = p("out", "2026-01-05T14:05:00Z");
  assert.equal(validateChange([a], [a, out], NY, "kiosk"), null);
  assert.equal(validateChange([], [out], NY, "kiosk"), "You're not clocked in yet.");
  // Admin message names the punch
  assert.match(validateChange([], [out], NY, "admin")!, /Clock out at 9:05 AM .* they were not clocked in/);
  // Inserting a clock-in before an existing clock-in breaks the later one
  const early = p("in", "2026-01-05T13:00:00Z");
  assert.ok(validateChange([a], [early, a], NY, "admin"));
  // Pre-existing problems are not blamed on a new punch
  assert.equal(sequenceIssues([out]).length, 1);
  assert.equal(validateChange([out], [out, p("in", "2026-01-05T16:00:00Z")], NY), null);
});

test("worked minutes today exclude breaks and count an open shift until now", () => {
  const list = [p("in", "2026-01-05T14:00:00Z"), p("break_start", "2026-01-05T16:00:00Z"), p("break_end", "2026-01-05T16:30:00Z")];
  const day = localRange("2026-01-05", "2026-01-05", NY);
  assert.equal(day.from, "2026-01-05T05:00:00.000Z");
  assert.equal(day.to, "2026-01-06T05:00:00.000Z");
  const now = Date.parse("2026-01-05T18:00:00Z");
  assert.equal(workedMinutes(list, Date.parse(day.from), Date.parse(day.to), now), 120 + 90);
});
