import { test } from "node:test";
import assert from "node:assert/strict";
import { patchToRow, punchToRow, rowToPunch } from "../server/db/types";
import type { Punch } from "@shared/punches";

const base: Punch = {
  id: "abcdefgh1234", siteId: "s1", employeeId: "e1", employeeName: "Ana", type: "out", at: "2026-11-01T10:00:00.000Z",
  source: "admin", deviceId: null, note: "", createdAt: "2026-11-01T10:00:00.000Z", editedAt: null, edits: [],
  flags: { autoClosed: { reason: "cutoff", closedAt: "2026-11-01T10:00:00.000Z" } },
  meta: { station: "Kitchen", photo: "saved" },
};

test("punch flags (auto clock-out) and meta (kiosk extras) share meta_json without losing each other", () => {
  const back = rowToPunch(JSON.parse(JSON.stringify(punchToRow(base))));
  assert.deepEqual(back.flags, base.flags);
  assert.deepEqual(back.meta, base.meta);
  assert.equal((back.meta as any).flags, undefined);
  const patched = patchToRow({ edits: [], flags: back.flags, meta: back.meta });
  const again = rowToPunch({ ...punchToRow(base), meta_json: JSON.stringify(patched.meta_json) });
  assert.deepEqual(again.flags, base.flags);
  assert.equal(again.meta?.station, "Kitchen");
});

test("old punches with only edits still read cleanly", () => {
  const p = rowToPunch({ ...punchToRow(base), meta_json: JSON.stringify({ edits: [] }) });
  assert.equal(p.flags, undefined);
  assert.equal(p.meta, undefined);
});
