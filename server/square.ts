import type { Shift } from "@shared/schema";
import { addDays, instantToLocal, localToInstant } from "@shared/dates";
import { normalizeName } from "@shared/engine";

const API = "https://connect.squareup.com/v2";
const VERSION = "2025-05-21";

export class SquareError extends Error {
  /** Square's error code, e.g. INSUFFICIENT_SCOPES. */
  code?: string;
  constructor(message: string, public status = 502) { super(message); }
}

/** Per-request limit in ms (headers and body together). A test hook. */
export const squareTimeout = { ms: 20000 };
const MAX_RETRIES = 3;
/** Pages of timecards read per pull (200 each). */
const MAX_PAGES = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait before retry `attempt` (0-based): Square's Retry-After when given (capped), else 0.5 s, 1 s, 2 s. */
function retryDelay(res: Response, attempt: number) {
  const after = Number(res.headers.get("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : 500 * 2 ** attempt;
}

async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    // One timer covers the headers AND the body, so a reply that stalls half-way can't hang the pull.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), squareTimeout.ms);
    try {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, "Square-Version": VERSION, "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctl.signal,
      });
    } catch (err: any) {
      throw new SquareError(`Could not reach Square: ${ctl.signal.aborted ? "Square took too long to answer." : err.message}`);
    }
    // Rate limited or a passing Square outage: wait and try again a few times.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await res.body?.cancel().catch(() => undefined);
      await sleep(retryDelay(res, attempt));
      continue;
    }
    let text: string;
    try { text = await res.text(); } catch {
      throw new SquareError(`Square sent a reply that couldn't be read (status ${res.status}). Try again in a minute.`);
    }
    let data: any = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (res.status === 401) throw new SquareError("Square rejected the access token. Reconnect Square in Settings → Locations.", 400);
    if (res.status === 429) throw new SquareError("Square is limiting requests right now. Wait a minute and try again.", 503);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      // A proxy error page or a cut-off reply: never read it as "no timecards".
      throw new SquareError(`Square sent a reply that couldn't be read (status ${res.status}). Try again in a minute.`);
    }
    if (!res.ok || data.errors) {
      const e = new SquareError(data.errors?.[0]?.detail ?? `Square returned ${res.status}`);
      e.code = data.errors?.[0]?.code ?? (res.status === 403 ? "FORBIDDEN" : undefined);
      throw e;
    }
    return data;
    } finally { clearTimeout(timer); }
  }
}

const validInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

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
  const seen = new Set<string>();
  let cursor: string | undefined;
  let open = 0;
  let bad = 0;
  let pages = 0;
  do {
    const body: any = { query: { filter: { location_ids: [locationId], start: { start_at: startAt, end_at: endAt } } }, limit: 200 };
    if (cursor) body.cursor = cursor;
    const data = await call(token, "/labor/timecards/search", { method: "POST", body });
    for (const tc of Array.isArray(data.timecards) ? data.timecards : []) {
      // The same timecard can come back on two pages if it changes while we read.
      if (!tc || typeof tc !== "object" || (tc.id && seen.has(tc.id))) continue;
      if (tc.id) seen.add(tc.id);
      if (!validInstant(tc.start_at)) { bad++; continue; }
      if (!tc.end_at) { open++; continue; }
      if (!validInstant(tc.end_at)) { bad++; continue; }
      timecards.push(tc);
    }
    cursor = typeof data.cursor === "string" && data.cursor ? data.cursor : undefined;
  } while (cursor && ++pages < MAX_PAGES);
  const truncated = !!cursor;

  const names: Record<string, string> = {};
  const needed = new Set(timecards.map((tc) => tc.team_member_id).filter(Boolean));
  if (needed.size) {
    // Look up only this location's team, and stop once every name is known.
    let tmCursor: string | undefined;
    let guard = 0;
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
  const warnings: string[] = [];
  if (open) warnings.push(`${open} timecard${open === 1 ? " is" : "s are"} still open (not clocked out) and ${open === 1 ? "was" : "were"} skipped.`);
  if (bad) warnings.push(`${bad} timecard${bad === 1 ? " has" : "s have"} an unreadable start or end time and ${bad === 1 ? "was" : "were"} skipped. Check ${bad === 1 ? "it" : "them"} in Square.`);
  if (truncated) warnings.push(`Square has more than ${MAX_PAGES * 200} timecards in this period, so only the first ${timecards.length} were brought in. Pull a shorter period.`);
  return { shifts, warnings, locationId };
}

/** Currencies without minor units (Square amounts are already whole units). */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG"]);
const moneyOf = (m: any) => {
  const n = Number(m?.amount);
  if (!Number.isFinite(n)) return 0;
  return ZERO_DECIMAL.has(String(m?.currency ?? "").toUpperCase()) ? n : n / 100;
};

/**
 * Net sales per local date (completed orders, after discounts and returns,
 * without tax and tips), from the Orders API. Needs the ORDERS_READ permission.
 */
export async function pullDailySales(token: string, opts: { locationId?: string; start: string; end: string; timezone: string }): Promise<Record<string, number>> {
  let locationId = opts.locationId;
  if (!locationId) {
    const locs = await listLocations(token);
    if (!locs.length) throw new SquareError("No Square locations were found for this token.", 400);
    locationId = locs[0].id;
  }
  const startAt = localToInstant(opts.start, 0, opts.timezone);
  const endAt = localToInstant(addDays(opts.end, 1), 0, opts.timezone);
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  let cursor: string | undefined;
  let guard = 0;
  do {
    const body: any = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: { state_filter: { states: ["COMPLETED"] }, date_time_filter: { closed_at: { start_at: startAt, end_at: endAt } } },
        sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
      },
    };
    if (cursor) body.cursor = cursor;
    const data = await call(token, "/orders/search", { method: "POST", body });
    for (const o of Array.isArray(data.orders) ? data.orders : []) {
      if (!o || typeof o !== "object" || (o.id && seen.has(o.id))) continue;
      if (o.id) seen.add(o.id);
      const at = o.closed_at ?? o.created_at;
      if (!validInstant(at)) continue;
      const a = o.net_amounts ?? {};
      const total = a.total_money ? moneyOf(a.total_money) : moneyOf(o.total_money);
      const tax = a.tax_money ? moneyOf(a.tax_money) : moneyOf(o.total_tax_money);
      const tip = a.tip_money ? moneyOf(a.tip_money) : moneyOf(o.total_tip_money);
      const date = instantToLocal(at, opts.timezone).date;
      out[date] = Math.round(((out[date] ?? 0) + total - tax - tip) * 100) / 100;
    }
    cursor = typeof data.cursor === "string" && data.cursor ? data.cursor : undefined;
  } while (cursor && ++guard < 200);
  if (cursor) console.warn("[square] daily sales stopped after 200 pages; later orders were not counted");
  return out;
}
