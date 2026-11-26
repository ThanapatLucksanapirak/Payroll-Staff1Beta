// Switching database with "copy data" must bring time-clock punches along, not just settings and timesheets.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Punch } from "../shared/punches";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-switch-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SUPABASE_URL;

function punch(id: string, type: Punch["type"], at: string): Punch {
  return { id, siteId: "main", employeeId: "e1", employeeName: "Ana Ruiz", type, at, source: "kiosk", deviceId: "d1", note: "", createdAt: at, editedAt: null, edits: [] };
}

after(async () => {
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("switch with copyData copies punches, settings and timesheets", async () => {
  const { initDatabase, db, switchDatabase } = await import("../server/db");
  await initDatabase();
  const old = await db();
  await old.setSetting("hello", "world");
  await old.insertPunch(punch("p00000001", "in", "2026-01-05T14:00:00.000Z"));
  await old.insertPunch(punch("p00000002", "out", "2026-01-05T22:00:00.000Z"));

  const r = await switchDatabase({ kind: "sqlite", path: "second.db" } as any, { copyData: true });
  assert.equal(r.copied?.punches, 2);
  const next = await db();
  assert.notEqual(next, old);
  const ids = (await next.allPunches()).map((p) => p.id).sort();
  assert.deepEqual(ids, ["p00000001", "p00000002"]);
  assert.equal(await next.getSetting("hello"), "world");
});

test("switch without copyData leaves the new database's punches alone", async () => {
  const { db, switchDatabase } = await import("../server/db");
  const r = await switchDatabase({ kind: "sqlite", path: "third.db" } as any, { copyData: false });
  assert.equal(r.copied, null);
  assert.equal((await (await db()).allPunches()).length, 0);
});
