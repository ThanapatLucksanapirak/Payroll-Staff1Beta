// Supabase caps each reply (1000 rows by default): reads must page so backups,
// database copies and restores see every row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { SupabaseStore } from "../server/db/supabase";

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const CAP = 1000;
const punches = Array.from({ length: 2503 }, (_, i) => ({
  id: `p${String(i).padStart(6, "0")}`, site_id: "main", employee_id: "e1", employee_name: "Ana", type: i % 2 ? "out" : "in",
  at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), source: "kiosk", device_id: "d1", note: "", created_at: "2026-01-01T00:00:00Z",
  edited_at: null, edits: [], meta_json: null,
}));
const settings = Array.from({ length: 1200 }, (_, i) => ({ key: `k${String(i).padStart(5, "0")}`, value: "v" }));
const deleted: string[] = [];

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(String(input));
  const table = url.pathname.split("/").pop()!;
  const method = init?.method ?? "GET";
  if (method === "DELETE") { deleted.push(decodeURIComponent(url.search)); return new Response(null, { status: 204 }); }
  if (method !== "GET") return new Response(null, { status: 201 });
  const rows: any[] = table === "punches" ? punches : table === "app_settings" ? settings : [];
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? CAP), CAP); // the server cap wins
  return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const store = new SupabaseStore("https://example.supabase.co", "sb_secret_0123456789abcdefghij");

test("allPunches reads past the 1000-row cap", async () => {
  const all = await store.allPunches();
  assert.equal(all.length, punches.length);
  assert.equal(new Set(all.map((p) => p.id)).size, punches.length);
});

test("allSettings reads past the cap", async () => {
  assert.equal((await store.allSettings()).length, settings.length);
});

test("listPunches stops at its limit", async () => {
  assert.equal((await store.listPunches({ limit: 1500 })).length, 1500);
});

test("restore deletes punches beyond the first 1000 that the file doesn't have", async () => {
  const keep = punches.slice(0, 10).map((r) => ({ id: r.id, siteId: "main", employeeId: "e1", employeeName: "Ana", type: r.type as any, at: r.at, source: "kiosk" as const, deviceId: "d1", note: "", createdAt: r.created_at, editedAt: null, edits: [] }));
  deleted.length = 0;
  await store.importAll({ settings: settings, timesheets: [], punches: keep }, { replace: true });
  const ids = deleted.filter((q) => q.startsWith("?id=")).join(",");
  assert.ok(ids.includes(punches[2502].id), "the last punch (row 2503) was found and removed");
});
