// Square client: bad replies are errors (not "no timecards"), 429s are retried,
// duplicate timecards across pages count once, and unreadable times are skipped with a warning.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pullTimecards, pullDailySales, SquareError } from "../server/square";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Reply = { status?: number; body: string; headers?: Record<string, string> };
function stub(handler: (path: string, body: any, n: number) => Reply) {
  let n = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const r = handler(url.pathname.replace("/v2", ""), init?.body ? JSON.parse(String(init.body)) : null, n++);
    return new Response(r.body, { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return () => n;
}
const opts = { locationId: "L1", start: "2026-01-05", end: "2026-01-06", timezone: "America/New_York" };
const tc = (id: string, start_at: string, end_at: string | null = "2026-01-05T22:00:00Z") => ({ id, team_member_id: "tm1", start_at, end_at, breaks: [] });
const team = { status: 200, body: JSON.stringify({ team_members: [{ id: "tm1", given_name: "Ana", family_name: "Ruiz" }] }) };

test("a 200 with a non-JSON body is an error, not zero shifts", async () => {
  stub(() => ({ body: "<html>Bad gateway</html>" }));
  await assert.rejects(pullTimecards("tok", opts), (e: any) => e instanceof SquareError && /couldn't be read/.test(e.message));
});

test("429 is retried, honoring Retry-After", async () => {
  const calls = stub((path, _b, n) => {
    if (path.startsWith("/team-members")) return team;
    return n === 0 ? { status: 429, body: "{}", headers: { "Retry-After": "0.01" } } : { body: JSON.stringify({ timecards: [tc("a", "2026-01-05T14:00:00Z")] }) };
  });
  const r = await pullTimecards("tok", opts);
  assert.equal(r.shifts.length, 1);
  assert.ok(calls() >= 3, "search retried once, then team lookup");
});

test("429 that never clears gives a clear error", async () => {
  stub(() => ({ status: 429, body: "{}", headers: { "Retry-After": "0.01" } }));
  await assert.rejects(pullTimecards("tok", opts), /limiting requests/);
});

test("duplicates across pages count once; bad times are skipped with a warning", async () => {
  stub((path, body) => {
    if (path.startsWith("/team-members")) return team;
    if (!body.cursor) return { body: JSON.stringify({ timecards: [tc("a", "2026-01-05T14:00:00Z"), tc("bad", "not a date")], cursor: "p2" }) };
    return { body: JSON.stringify({ timecards: [tc("a", "2026-01-05T14:00:00Z"), tc("b", "2026-01-06T14:00:00Z", "2026-01-06T20:00:00Z")] }) };
  });
  const r = await pullTimecards("tok", opts);
  assert.deepEqual(r.shifts.map((s) => s.id).sort(), ["sq_a", "sq_b"]);
  assert.ok(!r.shifts.some((s) => s.date.includes("NaN")));
  assert.ok(r.warnings.some((w) => /unreadable start or end time/.test(w)), r.warnings.join("; "));
});

test("a pull that runs past the page limit says so", async () => {
  let i = 0;
  stub((path) => {
    if (path.startsWith("/team-members")) return team;
    i++;
    return { body: JSON.stringify({ timecards: [tc(`t${i}`, "2026-01-05T14:00:00Z")], cursor: `c${i}` }) };
  });
  const r = await pullTimecards("tok", opts);
  assert.equal(r.shifts.length, 100);
  assert.ok(r.warnings.some((w) => /only the first 100/.test(w)), r.warnings.join("; "));
});

test("daily sales count a duplicated order once", async () => {
  const order = { id: "o1", closed_at: "2026-01-05T18:00:00Z", net_amounts: { total_money: { amount: 1000, currency: "USD" } } };
  stub((_p, body) => (!body.cursor ? { body: JSON.stringify({ orders: [order], cursor: "x" }) } : { body: JSON.stringify({ orders: [order, { id: "o2", closed_at: "garbage" }] }) }));
  assert.deepEqual(await pullDailySales("tok", opts), { "2026-01-05": 10 });
});
