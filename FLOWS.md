# Main flows (baseline from v1, must keep working)

## Navigation (v3)
- Sidebar on desktop (collapsible), bottom tab bar + slide-over menu on phones; ⌘K / Ctrl-K opens the command palette (pages, actions, settings sections, timesheets)
- Location switcher at the top of the sidebar; account menu (name, role, Account & password, Sign out, Sign out everywhere) at the bottom
- Home `/` · Timesheets `/timesheets` · Live `/live` · Employees `/employees` · Reports `/reports` · Settings `/settings/<section>`
- Employee time clock (kiosk) is a separate page at `/kiosk`, paired per device from Settings → Locations & rules → Time clock

## Sign in
- Start: app root
- First run: setup code, your name, username, password + confirm -> "Create owner account"
- Steps: enter username and password (a single owner may leave the username blank), press Sign in
- Expect: Home (greeting, quick actions, at a glance, recent timesheets, payroll by period)

## Home
- Quick actions open the import flow: Time clock (when the location uses the kiosk), Pull from Square (when it uses Square), Upload CSV, Toast PDF, New timesheet. Hidden for viewers.

## Timesheets (`/timesheets`)
- Expect: grid or list of saved timesheets (name / custom label, period, employee count, total pay, status, time ago); search, status filter, sort
- Card menu: rename, duplicate, mark final / reopen, move to location, delete (to Trash). Hidden for viewers.
- Trash button: restore (editors), delete forever / empty Trash (owners and admins)
- Click a card -> opens the timesheet workspace (Payroll, Rates, Shifts, Details tabs); Export menu: Full report (PDF), Manager summary (PDF), Pay statements (PDF), Summary CSV, Shifts CSV; per-employee "Pay statement" on the Payroll tab

## Live (`/live`) and Employees (`/employees`)
- Live: who is working / on break right now, updated in real time; today's punches; editors can add or fix punches (with a note)
- Employees: the people who can use the time clock, each with a 4–6 digit PIN; owners and admins add, edit, import names and remove

## Pull from Square
- Steps: "Pull from Square" -> pick From/To -> Fetch Timecards
- Expect: wages step listing employees; offer to load saved wages

## Upload CSV
- Steps: Upload CSV -> drop/select Square CSV
- Expect: wages step with employees

## Wages step
- Category select / custom full + half day rates / Net-Gross toggle per employee
- Save Wages (profile), Categories manager (create/edit/delete)
- Manual employees: lump sum or by-date pay
- Analyze Timesheet -> results

## Results
- Stats (employees, total pay, full days, flags), per-employee cards with day table
- Adjust a day: override status, cancel pay, dock amount, day bonuses, note
- Add day to employee
- Period deductions and general bonuses (save & re-analyze)
- Exclude / include employee
- Save progress, CSV export, PDF export, Re-analyze, Edit wages, Home

## Reports (`/reports`)
- Totals and charts across saved timesheets for the current location

## Settings
- Payroll: Locations & rules (Square token connect/replace/remove, classification cutoffs with preview, time clock: hours from Square / Time clock / Both, kiosk sign-in mode, kiosk devices), Pay categories
- App: Preferences (appearance, formats, PDF options and logo)
- Access: Account & password (everyone), Users and Activity (owners and admins)
- System: Database, Backup & history
- Managers and viewers only see Account & password

# Requested changes (v2 acceptance checks)
- Multiple locations (sites), each with its own rules, Square connection, categories and saved wages; site switcher in header; timesheets belong to a site
- Many more settings: classification method (cutoffs / hours), grace minutes, weekday overrides, flagged-day pay, split-shift merging, min shift length, hourly pay + overtime, rounding, timezone, week start, pay period, date format, currency, app name, theme, retention
- Toast scheduling / time entry PDF import with a review step before analysis
- Database selectable in Settings (local SQLite or any Supabase project), test connection, setup SQL, copy data across
- Stability: one shared payroll engine (no duplicated math), autosave with status, undo/redo, ISO dates internally, overnight shifts, legacy record migration, no silent deletion of history
- Delete dead code (unused sidebar, legacy analyzer endpoint, unused deps)

# Brainstorm features (v3.1)
Each area has a user guide in `docs/features/`:
- Time clock review (`timeclock.md`): auto clock-out per location, Fix punches page `/live/fix`, shift approval, overtime watch on Live, payroll checklist (Home quick action and timesheet Export menu)
- Kiosk (`kiosk.md`): photo on punch, confirmation screen, wrong-action guard, idle reset, per-device options, stations, shift notes, break reminders, fix requests (approved on Live)
- Pay (`pay.md`): final timesheets are locked (Owner reopens with a reason), cash denominations, advances, standing bonuses/deductions, rate history, holidays, tips, year to date, variance card, accounting journal CSV
- Schedule (`schedule.md`): Schedule page `/schedule`, late / no-show alerts on Live, time off, early clock-in rule, labor vs. sales, payroll forecast
- Access (`access.md`): Settings → Users → Roles, two-factor sign-in, installable app, offsite backups
- Employee portal (`portal.md`): `/me` for staff (hours, pay statements, schedule, time-off requests); off by default per location
