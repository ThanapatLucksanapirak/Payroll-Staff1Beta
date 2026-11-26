import test from "node:test";
import assert from "node:assert/strict";
import { jsPDF } from "jspdf";
import { parseCsvText, shiftsToCsv } from "../shared/importers/csv";
import { parseRange, parseScheduleItems } from "../shared/importers/schedule";
import { extractPdfText } from "../server/pdf";
import { rowToDoc } from "../shared/legacy";
import { DEFAULT_RULES } from "../shared/schema";

test("Square CSV export", () => {
  const csv = "Team Member,Clockin date,Clockin time,Clockout time\nKen Khanchalee,11/1/26,10:25:00 AM,8:33:00 PM\nKen Khanchalee,10/31/26,4:00:00 PM,1:15:00 AM\n";
  const r = parseCsvText(csv);
  assert.equal(r.format, "Square timecards");
  assert.equal(r.shifts.length, 2);
  assert.equal(r.shifts[0].date, "2026-11-01");
  assert.equal(r.shifts[1].end, 1440 + 75);
});

test("Toast TimeEntries.csv export", () => {
  const csv = [
    "Location,Employee Id,Employee,Job Title,In Date,Out Date,Auto Clock-out,Total Hours,Unpaid Break Time,Paid Break Time,Payable Hours",
    "Main,1,\"Doe, Jane\",Server,9/20/26 10:44 AM,9/20/26 9:02 PM,No,10.3,0.5,0,9.8",
    "Main,2,John Smith,Line Cook,9/20/26 4:00 PM,9/21/26 12:30 AM,No,8.5,0,0,8.5",
  ].join("\n");
  const r = parseCsvText(csv);
  assert.equal(r.format, "Toast time entries");
  assert.equal(r.shifts.length, 2);
  assert.equal(r.shifts[0].start, 644);
  assert.equal(r.shifts[0].breakMinutes, 30);
  assert.equal(r.shifts[0].role, "Server");
  assert.equal(r.shifts[1].end, 1440 + 30);
});

test("unknown CSV asks for a mapping, then works with one", () => {
  const csv = "Person,Day,From,Until\nAnn Lee,2026-11-02,10:00,21:00\n";
  const r = parseCsvText(csv);
  assert.equal(r.needsMapping, true);
  const r2 = parseCsvText(csv, { mapping: { name: "Person", date: "Day", start: "From", end: "Until" } });
  assert.equal(r2.shifts.length, 1);
  assert.equal(r2.shifts[0].end, 21 * 60);
});

test("canonical CSV round-trips", () => {
  const r = parseCsvText("Team Member,Clockin date,Clockin time,Clockout time\nA B,11/1/26,4:00:00 PM,1:15:00 AM\n");
  const back = parseCsvText(shiftsToCsv(r.shifts));
  assert.equal(back.shifts[0].end, r.shifts[0].end);
  assert.equal(back.shifts[0].id, r.shifts[0].id);
});

test("time range parsing", () => {
  assert.deepEqual(parseRange("10a", "9p"), { start: 600, end: 1260 });
  assert.deepEqual(parseRange("10:00 AM", "2:30 PM"), { start: 600, end: 870 });
  assert.deepEqual(parseRange("4", "11:30pm"), { start: 960, end: 1410 });
  assert.deepEqual(parseRange("17:00", "01:00"), { start: 1020, end: 1500 });
  assert.equal(parseRange("1", "2"), null);
});

function gridPdf(withDates: boolean): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt" });
  doc.setFontSize(14);
  doc.text("Shijiri Sushi Bar - Schedule" + (withDates ? " Nov 2 - Nov 8, 2026" : ""), 40, 40);
  doc.setFontSize(9);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  days.forEach((d, i) => doc.text(withDates ? `${d} 11/${2 + i}` : d, 170 + i * 90, 80));
  const rows: [string, (string | null)[]][] = [
    ["Ken Khanchalee", ["10:00a - 9:00p", null, "10:00a - 9:00p", "11a-3p", "4:00 PM - 10:30 PM", null, null]],
    ["Supharat Ratana", [null, "10:30 AM - 8:30 PM", null, null, "10:00 AM - 9:30 PM", "12:00 PM - 11:00 PM", null]],
    ["Open Shifts", ["10a - 2p", null, null, null, null, null, null]],
  ];
  rows.forEach(([name, cells], r) => {
    const y = 110 + r * 40;
    doc.text(name, 40, y);
    doc.text("32h", 40, y + 10);
    cells.forEach((c, i) => { if (c) { doc.text(c, 160 + i * 90, y); doc.text("Server", 160 + i * 90, y + 10); } });
  });
  return Buffer.from(doc.output("arraybuffer"));
}

test("Sling/Toast week-grid schedule PDF", async () => {
  const items = await extractPdfText(gridPdf(true));
  const r = parseScheduleItems(items);
  assert.equal(r.format, "grid");
  const ken = r.shifts.filter((s) => s.employee === "Ken Khanchalee");
  assert.equal(ken.length, 4);
  assert.deepEqual(ken.map((s) => s.date), ["2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.equal(ken[3].start, 960);
  const sup = r.shifts.filter((s) => s.employee === "Supharat Ratana");
  assert.deepEqual(sup.map((s) => s.date), ["2026-11-03", "2026-11-06", "2026-11-07"]);
  assert.equal(r.shifts.length, 7, "open shifts are skipped");
});

test("grid PDF without dates asks for the week start", async () => {
  const items = await extractPdfText(gridPdf(false));
  const r = parseScheduleItems(items);
  assert.equal(r.needsWeekStart, true);
  const r2 = parseScheduleItems(items, { weekStart: "2026-11-02" });
  assert.equal(r2.needsWeekStart, false);
  assert.equal(r2.shifts.find((s) => s.employee === "Ken Khanchalee")?.date, "2026-11-02");
});

test("list-style time entry PDF", async () => {
  const doc = new jsPDF({ unit: "pt" });
  doc.setFontSize(9);
  doc.text("Time Entries Report", 40, 40);
  doc.text("Employee", 40, 70); doc.text("Job Title", 160, 70); doc.text("In Date", 260, 70); doc.text("Out Date", 380, 70); doc.text("Hours", 500, 70);
  doc.text("Jane Doe", 40, 90); doc.text("Server", 160, 90); doc.text("11/3/26 10:02 AM", 260, 90); doc.text("11/3/26 9:15 PM", 380, 90); doc.text("11.22", 500, 90);
  doc.text("John Smith", 40, 105); doc.text("Line Cook", 160, 105); doc.text("11/3/26 4:00 PM", 260, 105); doc.text("11/4/26 12:30 AM", 380, 105); doc.text("8.5", 500, 105);
  doc.text("Monday, November 4, 2026", 40, 140);
  doc.text("Ann Lee   Host   5:00 PM - 10:00 PM", 40, 155);
  const r = parseScheduleItems(await extractPdfText(Buffer.from(doc.output("arraybuffer"))));
  assert.equal(r.format, "list");
  const jane = r.shifts.find((s) => s.employee === "Jane Doe")!;
  assert.equal(jane.role, "Server");
  assert.equal(jane.start, 602);
  const john = r.shifts.find((s) => s.employee === "John Smith")!;
  assert.equal(john.end, 1440 + 30);
  const ann = r.shifts.find((s) => s.employee.startsWith("Ann Lee"));
  assert.ok(ann, "date-grouped rows are read");
  assert.equal(ann!.date, "2026-11-04");
});

test("legacy v1 rows convert, including lost Add Day entries", () => {
  const doc = rowToDoc({
    csv_data: "Team Member,Clockin date,Clockin time,Clockout time\nCarmela Moralez,10/20/26,10:11:00 AM,8:50:00 PM\n",
    wages_json: [{ name: "Carmela Moralez", fullDayRate: "150", halfDayRate: "80", isNetPay: true, categoryId: "custom", excluded: false,
      adjustments: { "11/1/26": { cancelled: false, overrideStatus: "full_day" }, "10/20/26": { dockAmount: 10 } }, bonuses: [{ date: "10/20/26", description: "x", amount: 5 }], deductions: [] }],
    manual_employees_json: [{ id: "z", name: "Zoey", payMode: "lump_sum", lumpSum: "90", payDates: [{ date: "", amount: "0" }], isNetPay: false, bonuses: [], deductions: [], excluded: false }],
    result_json: { employees: [] },
  }, { defaultSiteId: "main", rules: { ...DEFAULT_RULES, clockInCutoff: 720, clockOutCutoff: 1200 } });
  assert.equal(doc.employees[0].fullDayRate, 150);
  assert.ok(doc.employees[0].adjustments["2026-10-20"]);
  assert.equal(doc.employees[0].bonuses[0].date, "2026-10-20");
  assert.equal(doc.shifts.length, 2);
  assert.ok(doc.shifts.some((s) => s.date === "2026-11-01" && s.source === "manual"));
  assert.equal(doc.manualEmployees[0].lumpSum, 90);
});

const HDR = "Team Member,Clockin date,Clockin time,Clockout time,Clockout date\n";
const T = { today: "2026-11-26" };

test("exact duplicate rows are dropped with a warning (hourly staff are not paid twice)", () => {
  const csv = HDR + "Ana Ruiz,11/2/26,9:00 AM,5:00 PM,11/2/26\nAna Ruiz,11/2/26,9:00 AM,5:00 PM,11/2/26\nAna Ruiz,11/3/26,9:00 AM,5:00 PM,11/3/26\n";
  const r = parseCsvText(csv, T);
  assert.equal(r.shifts.length, 2);
  assert.ok(r.warnings.some((w) => /1 duplicate row skipped/.test(w)), r.warnings.join("|"));
});

test("dates far from today are skipped with a warning", () => {
  const csv = HDR + "Ana Ruiz,11/1/1926,9:00 AM,5:00 PM,11/1/1926\nBo Lee,3/4/2099,9:00 AM,5:00 PM,3/4/2099\nAna Ruiz,11/2/26,9:00 AM,5:00 PM,11/2/26\n";
  const r = parseCsvText(csv, T);
  assert.equal(r.shifts.length, 1);
  assert.ok(r.warnings.some((w) => /2 rows skipped: the date is more than a year from today/.test(w)), r.warnings.join("|"));
});

test("a shift cut to 72 hours is reported with the person and date", () => {
  const csv = HDR + "Ana Ruiz,11/2/26,9:00 AM,5:00 PM,11/10/26\n";
  const r = parseCsvText(csv, T);
  assert.equal(r.shifts[0].end, 4320);
  assert.ok(r.warnings.some((w) => /72 hours/.test(w) && /Ana Ruiz 2026-11-02/.test(w)), r.warnings.join("|"));
});
