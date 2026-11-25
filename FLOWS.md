# Main flows (baseline from v1, must keep working)

## Sign in
- Start: app root
- Steps: enter admin password, press Unlock
- Expect: home dashboard with "Saved Timesheets"

## Saved timesheets dashboard
- Expect: grid of saved timesheets (filename / custom label, period, employee count, total pay, time ago)
- Rename a timesheet inline (pencil), delete a timesheet (trash)
- Click a card -> opens saved results

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

## Settings
- Square token connect/replace/remove
- Classification cutoffs (clock-in by / clock-out by) with preview
- Change password

# Requested changes (v2 acceptance checks)
- Multiple locations (sites), each with its own rules, Square connection, categories and saved wages; site switcher in header; timesheets belong to a site
- Many more settings: classification method (cutoffs / hours), grace minutes, weekday overrides, flagged-day pay, split-shift merging, min shift length, hourly pay + overtime, rounding, timezone, week start, pay period, date format, currency, app name, theme, retention
- Toast scheduling / time entry PDF import with a review step before analysis
- Database selectable in Settings (local SQLite or any Supabase project), test connection, setup SQL, copy data across
- Stability: one shared payroll engine (no duplicated math), autosave with status, undo/redo, ISO dates internally, overnight shifts, legacy record migration, no silent deletion of history
- Delete dead code (unused sidebar, legacy analyzer endpoint, unused deps)
