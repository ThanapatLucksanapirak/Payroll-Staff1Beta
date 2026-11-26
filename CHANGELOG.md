# What's new

Plain-language notes for each update, newest first. They appear in the app under
Settings → About, next to the matching update.

Add an entry with every pull request: a `## YYYY-MM-DD · Title (#PR)` heading and a
few short bullets written for the people who use the app, not for developers.

## 2026-11-26 · iPhone home screen edges, and labor from Square (#32)
- On an iPhone added to the home screen, the app now fills the whole screen neatly: the tab bar sits above the home bar, the top bar clears the status bar and camera, and nothing is cut off by the rounded corners, in portrait and landscape. The time clock and staff portal got the same care.
- Home and Reports: for a location that tracks time in Square, "Labor vs. sales" now counts this week's Square timecards at your saved pay rates (marked est.), instead of showing $0.00 labor until a timesheet is saved. The payroll forecast counts them too.
- If Square won't share timecards, Reports says so. When there are sales but no labor cost yet, Home and Reports show "—" instead of 0.0%, and say whether it's because no hours are in yet or someone has no pay rate.
- Reports: the labor vs. sales table fits on phones (hours sit under the labor cost).
- Long-pressing a tab, button or link no longer opens Safari's link menu (Open, Add to Reading List, Copy Link), and buttons don't get text-selected. Typed text and page content can still be selected.

## 2026-11-26 · Clearer first steps, part 2 (#29)
- Home: a new install shows the five steps of a first payroll, in order. The app is called Shijiri Payroll everywhere.
- Timesheets: after an upload, the Payroll tab says who still needs a pay rate, with a button to the Rates tab. The pay card says plainly whether amounts are take-home (no tax taken) or before tax. A CSV upload is named after its dates, and "Break (minutes)" columns are read.
- On phones, pay rates are one card per person with only the rate that applies.
- Email PDFs without email set up says what's missing and offers Download instead. Publish waits until an accountant exists, and the banner names who it was published to.
- Employees: "Give everyone a PIN" makes PINs for everyone without one and shows them once. New timesheets offer to add people who aren't on the list yet. The staff portal switch and link are on the Employees page too.
- Staff portal: the schedule says "No schedule published yet" or "Not out yet" instead of "Off". My pay rows are named by dates and a download says where the file went. Pay statements say "Pay statement for (name)" instead of "for internal use only".
- Time clock: tapping Clock out while on a break asks whether you meant End break. The setup screen uses your device's time zone, and the clock names the location's time zone if the tablet is set differently. Setting paths now read Settings → Locations & rules → Time clock.

## 2026-11-26 · Clearer first steps (#28)
- Staff portal: My hours now shows hours from your finalized pay statement when they came from Square or a spreadsheet, instead of "No hours" next to your pay. Each row under My pay shows the hours too.
- Pay rates: new people start on Hourly (or Day rate if most of your saved staff use it), so the total isn't $0.00 with blank boxes. A "Set everyone to…" menu switches everyone at once, and Net and the saved-rates buttons are explained.
- Time clock: the PIN screen says to tap the check mark, and once 4 digits are in it says "Tap the check mark to continue".
- Flagged days: the rules and the pre-export checklist now say that only day-rate staff are affected. Hourly staff are paid for the hours they worked.

## 2026-11-26 · Download the Android time clock app from the kiosk (#26)
- On Android tablets, a "Get the Android app" button at the top downloads the Time Clock app directly, without the Play Store.

## 2026-11-26 · Steadier screens on iPhone and iPad (#25)
- The app no longer slides around as a whole when you scroll: the side menu stays put and only the page content scrolls, with no empty black band at the bottom.
- The time clock fits the screen on phones and tablets, with a smaller keypad on short phones, so the PIN screen no longer scrolls.
- Date and time boxes (for example Arrive before and Stay until, and From and To in New timesheet) are now the same size as other boxes on iPhone and iPad and stay inside their card.

## 2026-11-26 · Mark as final and Export side by side (#27)
- On a timesheet, Mark as final and Export are now two buttons next to each other at the top, on phones and iPads too.
- The order is clear: on a draft, Mark as final is the main button and Export says you're downloading a draft. Once it's final, Export becomes the main button.
- PDFs exported from a draft have a faint DRAFT across each page and "DRAFT, not final" in the footer, and the file names end in DRAFT.
- Email PDFs is in the Export menu, with the same preview and confirm step. It's greyed out with the reason until the timesheet is final.
- In the email preview, tapping Open payroll no longer blanks the preview. Links work once the email is sent.
- Timesheets pulled from Square or the time clock keep the day range you picked as their pay period (for example Nov 9 – Nov 22), even if nobody worked on the first day. It's used in the header, the PDFs and email subjects, and you can change it in Details.

## 2026-11-26 · New Shijiri look (#24)
- A new Shijiri logo, colours and sign-in page, shared by the admin app, time clock, staff portal and emails.
- Easier to use on phones: timesheets, schedule, settings and the two-factor notice fit small screens.
- The time clock is easier to read, and "Fix a missed punch" fits on the tablet without scrolling.

## 2026-11-26 · Kiosk and app polish from feedback (#22)
- Live: each person who is clocked in has Clock out and Cancel clock-in, for when the kiosk went offline or someone clocked in by mistake.
- With photos on, the time clock checks for a face: a blocked or covered camera, or nobody in view, stops the punch and says "Face not detected".
- Settings → Locations: kiosk options, stations, break reminder, auto clock-out and the employee portal now save with the one Save changes button, which lists what's unsaved.
- Owners can show employee PINs on the Employees page after re-entering their password. PINs set before this update need to be set again to be shown.
- On phones the app no longer zooms on pinch, double-tap or when you tap a text box. On iPhone Safari, a tip explains Add to Home Screen to open it full screen.

## 2026-11-26 · Time Clock app for Android (#21)
- The kiosk can be installed as an Android app from Google Play. It opens straight to the time clock, full screen, with no zooming.
- `sudo payroll android fingerprint ...` links the app to your kiosk address.

## 2026-11-26 · About page with version history (#15)
- Settings → About shows the installed version, when it was installed and when it last checked for updates.
- Version history lists every update with notes on what changed.

## 2026-11-25 · Fixes from the final stress test (#14)
- Double shifts worked straight through keep all their hours under the early clock-in rule.
- Restoring a backup keeps your Square connection and paired kiosks.
- Finalized timesheets show the totals saved when they were finalized.
- Spreadsheet exports are safe to open and keep their dates the right way round.

## 2026-11-25 · Clearer sign-in username (#12)
- Your sign-in username is shown clearly and can be changed.

## 2026-11-25 · Update now button and safer reinstall (#10)
- Settings → Software update shows the installed version and has an Update now button.
- Running the installer again recovers a half-finished install instead of failing.
- Start-up errors are explained in plain words.

## 2026-11-25 · Set the admin and kiosk web addresses from the command line (#11)
- `payroll tunnel hosts` changes the admin and kiosk addresses.
- `payroll admin list` shows who can sign in.

## 2026-11-25 · Accountant role, publish payroll and email notifications (#13)
- New Accountant role that only sees payroll you publish.
- Publish a finalized payroll to send it to your accountant.
- Settings → Email to send notifications from your own address.

## 2026-11-25 · Installer follow-ups (#9)
- Editing a location no longer resets its other settings.
- `payroll start` and re-running the installer recover from a stopped install.

## 2026-11-25 · Time clock, schedule, employee portal and more (#7)
- Schedule page with shifts, time off, late alerts and labor vs sales.
- Fix punches page, day approval, overtime watch and automatic clock-out.
- Kiosk extras: photo on punch, stations, break reminders and fix requests.
- Employee portal at /me: hours, pay statements, schedule and time-off requests.
- Pay extras: locked timesheets, cash breakdown, holidays, tips, advances and year-to-date totals.
- Role permissions, two-factor sign-in and offsite backups.

## 2026-11-25 · Stress-test fixes (#6)
- Fixes to installer recovery, restore, CSV import, sign-out, layout and overtime math.

## 2026-11-25 · Kiosk manager PIN lock (#5)
- A manager PIN locks the kiosk tablet's settings, with a lockdown guide.

## 2026-11-25 · New design, time clock and payment methods (#4)
- Redesigned app with a sidebar, Home, Reports and a command palette.
- Kiosk time clock app, Live page and Employees page.
- Redesigned PDF report, pay statements and manager summary.
- Pay by cash, bank transfer, check, or cash and bank split.
- User accounts with roles and an activity log.

## 2026-11-25 · One-command installer (#2)
- Install on Debian or Ubuntu with one command, with Cloudflare Tunnel and automatic updates.
- The `payroll` command manages the server: status, logs, update, rollback and backups.

## 2026-11-25 · Stability and data safety (#1)
- Safer saving, data backups and first-run security.
