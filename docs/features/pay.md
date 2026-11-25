# Pay: closing periods, cash, advances, tips and more

Everything here works per location. Settings live in **Settings → Pay extras** (owners and administrators). The pay math is in `shared/payExtras.ts` and runs after the payroll engine, so a timesheet that uses none of these features adds up exactly as before.

## Closing a pay period (finalize and lock)
- Mark a timesheet **final** from the Timesheets list (card menu → *Mark as final*) or the Details tab. It is then locked everywhere: the workspace shows a lock banner and every control is disabled; the server refuses edits, moves, deletes and status changes with a 409 and a clear message. Renaming is still allowed, and *Duplicate* makes an editable draft copy.
- Finalized timesheets show a lock on their **Final** badge in the lists.
- Finalizing takes a snapshot of the location's holidays, standing items, advance repayments and rate history, so a closed period never changes later.
- **Reopen** (owners only): the banner's *Reopen…* button, or the card menu. A reason is required and is saved in **Settings → Activity**. Reopening puts back any advance repayments the timesheet took.

## Cash pay-out with bills and coins
- The **Pay-out sheet (PDF)** now lists the bills and coins to pull from the bank, in total and per person, under the cash list. The **Tips & extras** tab shows the same as a small panel.
- Denominations are set per location (default US: 100, 50, 20, 10, 5, 1, 0.25, 0.10, 0.05, 0.01; presets for euro and pound, or add your own).
- *Round cash to whole amounts* rounds each cash hand-out on the pay-out sheet to the nearest whole unit. Timesheet totals are not changed; the sheet notes what was owed.
- If an amount cannot be made with the chosen denominations (e.g. notes only), the leftover is shown instead of guessed.

## Advances and loans
- Record an advance from **Settings → Pay extras → Advances** or the workspace **Tips & extras** tab (managers can record; owners/admins can write off or delete). Enter the amount, the date given, and either a fixed amount per period or a number of periods (split evenly, to the cent).
- It is taken automatically from that person's later timesheets at the same location (pay periods ending on or after the date given) as its own **Advance repayment** line on statements and reports, never more than they earn that period.
- The balance counts a repayment once the timesheet is **finalized**; reopening reverses it. The remaining balance is shown in settings and next to each repayment.
- An advance with no repayments can be deleted; otherwise *Write off* stops further repayments.

## Standing bonuses and deductions
- Per person, per location: e.g. *Uniform −$10* or *Attendance bonus +$50* each period. They are added to every draft timesheet that includes the person, shown as their own lines, and can be removed from one timesheet (and put back) on the **Tips & extras** tab or in the person's card on the Payroll tab.

## Rates with effective dates
- **Rates → Save as defaults** now asks for an *Effective from* date (the period start by default). Days before that date keep the old saved rate, so older periods recalculate with the rate they had. *Fix a mistake instead* replaces the saved rate without keeping history.
- Saved rates from before this feature count as effective since forever.
- Limit: a pay category's own rates have no history; history records the actual amounts a person was paid. On a pay statement for an hourly person with overtime across a rate change, the regular/overtime lines show the current rate (the totals are right).

## Holidays
- Per location: date, name, and either a pay multiplier (e.g. 1.5× the day's pay) or a flat bonus. Anyone who works (and is paid) on that day gets the premium as a dated bonus line on their statement.

## Tips
- On the **Tips & extras** tab enter one total or an amount per day. Share by hours worked, or by hours × points per pay category (default points per category in settings). Shares are exact to the cent and are added to take-home pay as a **Tips** line on statements, with a *Tips included above* list on the pay-out sheet. Manual and left-out people get no tips. Tips for a day nobody worked are flagged.
- Tips are entered by hand (Square tips are not fetched).

## Year to date
- **Employees** page → *Year to date*: gross (earnings before deductions) and net (paid) per person from finalized timesheets whose period ends in that year, with a **YTD CSV** export.
- **Pay statements (PDF)** print *Year to date: gross · net*, including the current timesheet.

## Period-over-period check
- The workspace shows e.g. *Total is 18% higher than last period* against the previous finalized timesheet of the same location (highlighted at 10% or more), and lists the people whose pay moved most.

## Accounting export
- **Export → Accounting journal (CSV)**: one balanced journal entry (Journal No, Date, Account, Debit, Credit, Memo) for QuickBooks / Xero journal imports. Debits: wages (base pay, bonuses, premiums) and tips; credits: deductions, advance repayments, cash, bank and checks. Anything left (e.g. someone owing money back) goes to a clearing account. Account names, journal number prefix and date format are in settings.

## Storage
- `pay:settings:<siteId>`, `pay:advances:<siteId>`, `pay:rates:<siteId>` in app settings (included in backups). Each timesheet keeps its snapshot in `meta_json.payExtras`; rate history is copied to the employees in the timesheet (`rateHistory`).
