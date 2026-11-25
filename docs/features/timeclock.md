# Time clock review (owner and manager side)

Tools for cleaning up time-clock punches before payroll. They apply to
locations whose hours come from the time clock (Settings → Locations → Time
clock → *Hours come from*: Time clock or Both).

## Auto clock-out

Settings → Locations → Time clock → **Auto clock-out** (owners and admins).

- **Close open shifts at**: a local time such as 2:00 AM. A shift still open at
  that time is closed **at that time** (not when the app notices). A shift that
  started less than an hour before the cutoff is closed at the next day's cutoff.
- **Longest possible shift**: a safety net. Any shift open longer than this many
  hours is closed at that length. 0 = off. With both set, whichever comes first wins.
- If the person was on a break, the break is ended at the same moment.
- The closing punch is added as an admin punch with the note *"Auto-closed:
  forgot to clock out"* and is marked **Auto-closed** (on Live and in Fix punches).
- The server checks every 5 minutes (and right after you save the setting);
  set `TIMECLOCK_AUTO_CLOSE_MS` to change the interval or `off` to stop it. It
  looks back 8 days. Running it again never adds a second clock-out, and it
  catches up after a restart. Each auto-close is in Settings → Activity as
  `timeclock.auto_close` by "System".
- Off by default.

## Fix punches

Live → **Fix punches & approve** (or `/live/fix`, or ⌘K "Fix punches").
Pick the dates (last 7 or 14 days, this or last pay period).

**Needs fixing** (hours can't be worked out until fixed):
- **No clock-out**: an old shift never closed (or followed by another clock-in). *Add the clock-out.*
- **Out of order**: e.g. a clock-out with no clock-in, a break started twice. *Change this punch* or *Delete it.*

**Double-check**:
- **Auto-closed**: *Set the real clock-out*, or approve the day to keep it.
- **Break never ended**: a break that ran into the clock-out for 2 hours or more. *Add the break end.*
- **Very long shift**: longer than the location's long-shift warning (default 14 h).
- **Very short shift**: under 5 minutes (a double tap). *Delete this shift* or fix the time.

Every fix asks for the real time (pre-filled) and keeps a note, and goes through
the normal punch add / edit / delete, so the punch keeps its edit history. If a
change doesn't fit the punches around it you're told why and can save anyway.

## Approving days

On Fix punches, each employee's day (the day the shift started) has
**Approve**. **Approve clean days** approves every day in the range with no
problems at all. Live shows how many of yesterday's and today's days are
approved and offers the same button.

- A day can't be approved while someone is still clocked in, or while it has a
  "needs fixing" problem. Approving accepts its "double-check" items.
- Any later change to that day's punches (add, edit, delete, even a note-only
  edit) clears the approval automatically; the day shows **Changed**.
- Managers and admins can approve; viewers see the state only.

## Overtime watch (Live)

When the location has overtime on (Locations & rules → Overtime), Live shows who:
- is **in overtime** this week (or today, with a daily limit),
- is **near** it (within 4 hours of the weekly limit, or 1 hour of the daily limit
  while working), with the time they'll cross if they stay,
- is **on pace** to go over by the end of the week (hours so far ÷ days so far × 7).

Hours are worked time from punches (breaks excluded, open shifts count until
now), for the location's week (week starts on its week-start day, in its time
zone). People saved on a day rate are left out, as overtime only applies to
hourly pay. It is an early warning: the timesheet's numbers are the ones paid.

## Pre-payroll checklist

Home → **Payroll checklist** (time-clock locations), or in a timesheet:
Export → **Check before export…**. It lists what's still wrong for the pay
period, each line linking to where to fix it:
- people still clocked in, punch problems to fix, auto-closed shifts,
  shifts to double-check, days not approved;
- employees with no pay rate (from saved rates on Home; from the timesheet
  itself in the workspace), flagged days and other shift warnings (timesheet only).

It never blocks exporting. Ranges are limited to 62 days.

## Storage

- `timeclock:<siteId>` (app settings): auto clock-out settings.
- `timeclock_approvals:<siteId>` (app settings): approved days with who, when and a
  fingerprint of the day's punches (kept 400 days). Both are in backups.
- Auto-closed punches carry `flags.autoClosed` in the punch's `meta_json`
  (older punches have none; included in backups and restores).

## Related server changes

- Live updates (`/api/live`) disconnect a client whose unsent data passes
  512 KB (`LIVE_MAX_BUFFER_BYTES`), so stalled browsers can't grow server
  memory. Browsers reconnect by themselves.
- With the local SQLite database, the activity log appends one JSON line per
  entry to `DATA_DIR/audit/YYYY-MM.jsonl` instead of rewriting the month in
  app settings. Older entries in `audit:YYYY-MM` settings are still read.
  `AUDIT_STORAGE=settings` keeps the old behaviour; Supabase always uses settings.
  These files are not part of the JSON backup export (activity is never restored anyway);
  copy the `audit` folder to keep it.
