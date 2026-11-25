import type { Shift } from "@shared/schema";
import { addDays, instantToLocal, localToInstant } from "@shared/dates";
import { normalizeName } from "@shared/engine";
import { fetchWithTimeout } from "./http";

const API = "https://connect.squareup.com/v2";
const VERSION = "2025-05-21";

export class SquareError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Square-Version": VERSION, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, 20000);
  } catch (err: any) {
    throw new SquareError(`Could not reach Square: ${err.message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SquareError("Square rejected the access token. Reconnect Square in Settings → Locations.", 400);
  if (!res.ok || data.errors) throw new SquareError(data.errors?.[0]?.detail ?? `Square returned ${res.status}`);
  return data;
}

export async function listLocations(token: string): Promise<{ id: string; name: string; timezone: string | null }[]> {
  const data = await call(token, "/locations");
  return (data.locations ?? []).filter((l: any) => l.status !== "INACTIVE").map((l: any) => ({ id: l.id, name: l.name ?? l.id, timezone: l.timezone ?? null }));
}

export async function pullTimecards(token: string, opts: { locationId?: string; start: string; end: string; timezone: string }) {
  let locationId = opts.locationId;
  if (!locationId) {
    const locs = await listLocations(token);
    if (!locs.length) throw new SquareError("No Square locations were found for this token.", 400);
    locationId = locs[0].id;
  }
  const startAt = localToInstant(opts.start, 0, opts.timezone);
  const endAt = localToInstant(addDays(opts.end, 1), 0, opts.timezone);

  const timecards: any[] = [];
  let cursor: string | undefined;
  let open = 0;
  let guard = 0;
  do {
    const body: any = { query: { filter: { location_ids: [locationId], start: { start_at: startAt, end_at: endAt } } }, limit: 200 };
    if (cursor) body.cursor = cursor;
    const data = await call(token, "/labor/timecards/search", { method: "POST", body });
    for (const tc of data.timecards ?? []) {
      if (!tc.end_at) { open++; continue; }
      timecards.push(tc);
    }
    cursor = data.cursor;
  } while (cursor && ++guard < 100);

  const names: Record<string, string> = {};
  const needed = new Set(timecards.map((tc) => tc.team_member_id).filter(Boolean));
  if (needed.size) {
    // Look up only this location's team, and stop once every name is known.
    let tmCursor: string | undefined;
    guard = 0;
    do {
      const body: any = { limit: 200, query: { filter: { location_ids: [locationId] } } };
      if (tmCursor) body.cursor = tmCursor;
      const data = await call(token, "/team-members/search", { method: "POST", body });
      for (const tm of data.team_members ?? []) {
        names[tm.id] = `${tm.given_name ?? ""} ${tm.family_name ?? ""}`.trim() || tm.id;
        needed.delete(tm.id);
      }
      tmCursor = data.cursor;
    } while (tmCursor && needed.size && ++guard < 50);
    // Members no longer assigned to this location: fetch them one by one.
    for (const id of [...needed].slice(0, 50)) {
      try {
        const data = await call(token, `/team-members/${encodeURIComponent(id)}`);
        const tm = data.team_member;
        if (tm) names[id] = `${tm.given_name ?? ""} ${tm.family_name ?? ""}`.trim() || id;
      } catch { /* keep the id */ }
    }
  }

  const shifts: Shift[] = timecards.map((tc) => {
    const s = instantToLocal(tc.start_at, opts.timezone);
    const e = instantToLocal(tc.end_at, opts.timezone);
    const dayDiff = Math.round((Date.parse(e.date) - Date.parse(s.date)) / 86400000);
    const end = e.minutes + dayDiff * 1440;
    const unpaid = (tc.breaks ?? []).filter((b: any) => b.is_paid === false && b.end_at)
      .reduce((m: number, b: any) => m + Math.max(0, (Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 0);
    return {
      id: `sq_${tc.id}`, employee: normalizeName(names[tc.team_member_id] ?? tc.team_member_id ?? "Unknown"),
      date: s.date, start: s.minutes, end: Math.max(end, s.minutes + 1), breakMinutes: Math.round(unpaid),
      role: tc.wage?.title ?? "", source: "square" as const, note: "",
    };
  });
  const warnings = open ? [`${open} timecard${open === 1 ? " is" : "s are"} still open (not clocked out) and were skipped.`] : [];
  return { shifts, warnings, locationId };
}
