# Schedule, late alerts, labor vs. sales and payroll forecast

## Weekly schedule (`/schedule`)

Sidebar → **Schedule** (also in ⌘K). One week per location: employees down the
side, days across.

- **Add a shift:** tap the **+** in a day (or **Add shift** at the top). Pick
  the start and end time, plus an optional station (e.g. "Grill") and note. An
  end time earlier than the start means the shift ends the next day. New shifts
  can be repeated on other days with **Also on**.
- **Edit or delete:** tap the shift.
- **Copy last week:** **⋯ → Copy last week**. If this week already has shifts
  you are asked before they are replaced. Days with approved time off are skipped.
- **Publish:** marks the week as ready. A published week that is changed shows
  "Changed since" and the button becomes **Publish changes**. **⋯ → Unpublish**
  undoes it. (Publishing does not notify anyone yet; it is the flag the
  employee portal will read.)
- **Print / PDF:** **⋯ → Print / PDF** downloads the week in the app's PDF style.
- The status line shows total hours, shifts and the **estimated labor cost** of
  the week at the saved rates (same pay engine as timesheets).
- The rows are the location's active employees (from the Employees page; a PIN
  is only needed for the time clock), plus anyone else on the schedule.
- Viewers see the schedule but cannot change it. Managers and up can edit.
- Changes save immediately. If someone else changed the week first, you are
  told to reload instead of overwriting their work. Other open screens update
  live.

## Time off

**⋯ → Add time off** (or tap a grey block to change it). Choose the person,
first and last day, and an optional reason. Approved time off shows as a grey
block, a shift on that day turns amber, and late alerts are silenced for that
day. Entries have a status (approved / pending / declined) so employee
requests can be added later; only approved entries affect the schedule.

## Late and no-show alerts (Live)

On **Live**, "Against the schedule" lists today's problems, updated as people
clock in and once a minute:

- "Kenji is 15 min late": past the grace time with no clock-in.
- "No-show: Ana (scheduled 9:00 AM)": no clock-in after the no-show time, or
  the shift is already over.
- A quiet line lists people who came in late.

Nothing shows when there is no schedule for today or everyone is on time.

## Schedule settings (owners and admins)

**Schedule → ⋯ → Schedule settings**, per location:

- **Late after**: grace minutes (default 5).
- **No-show after**: minutes with no clock-in (default 60).
- **Early clock-in rule** (off by default): when a timesheet is built from the
  time clock, a clock-in more than *X* minutes before a scheduled start is
  counted from the scheduled start (or, if you choose, from *X* minutes before
  it). Only days where that person is scheduled are touched; the shift's note
  says what was changed and the import shows a warning with the count. The
  punches themselves are never changed.

## Labor vs. sales (Reports and Home)

**Reports → Labor vs. sales** (current location): each day's sales, labor
cost, hours and labor %. Pick this week, last week, this month or 30 days.

- **Labor** comes from a saved timesheet covering that day when there is one
  (finalized first), otherwise from time-clock punches at the saved rates
  (marked "est."). Locations on Square-only hours show labor once a timesheet
  is saved.
- **Sales** come from Square (completed orders, net of tax and tips) when the
  location is connected and the token has the **Orders read** permission. If it
  doesn't, a plain message says so. Anyone who can edit can type a day's sales
  (**Add** / **Edit**); a typed number wins over Square, and **Clear** goes back.
- The total labor % only counts days that have sales.

**Home** shows a "Labor vs. sales this week" tile when there is labor or sales.

## Payroll forecast (Reports and Home)

"Projected payroll this period", labeled **Estimate**: what has been earned so
far in the current pay period (time-clock punches, including people still
clocked in, or saved timesheets for Square-only locations) plus the scheduled
shifts still to come, all priced at the saved rates in one pass (day rates and
overtime included). Approved time off is left out. Bonuses, deductions and
manual edits are not included. People without a saved rate are listed.

## Data and API

Stored as JSON in app settings (included in backups; nothing secret):
`schedule:<siteId>:<weekStart>`, `timeoff:<siteId>`,
`schedule-settings:<siteId>`, `sales:<siteId>:<YYYY-MM>`.

Read-only API for the future employee portal:
`GET /api/schedule?siteId=…&from=YYYY-MM-DD&to=YYYY-MM-DD` (up to 92 days)
returns `ScheduleApiResponse` from `shared/schedule.ts`: shifts (each with its
week and a `published` flag), time off overlapping the range, and each week's
publish state.
