# What's new

Plain-language notes for each update, newest first. They appear in the app under
Settings → About, next to the matching update.

Add an entry with every pull request: a `## YYYY-MM-DD · Title (#PR)` heading and a
few short bullets written for the people who use the app, not for developers.

## 2026-11-27 · Saved backups stay with the owner (#59)
- Only an owner can download the backups the server saves each day, because they include sign-in details. Admins can still see the list, back up now and restore.
- A backup downloaded by an admin leaves out employee PINs. Restoring it keeps everyone's current PIN instead of removing it.

## 2026-11-27 · Clearer activity log for finalize and reopen (#58)
- Finalizing, reopening, renaming or moving a timesheet now names the timesheet in the activity log, a rename shows the old name, and a move names the new location.

## 2026-11-27 · Bigger logo in the desktop sidebar (#57)
- The logo at the top of the desktop sidebar is about half as big again, so "By SHIJIRI GROUP" is easier to read, with more room before the collapse button.

## 2026-11-27 · Portal sign-out, publishing and small screen fixes (#54)
- Turning the staff portal off now signs everyone out for good: turning it back on doesn't bring old sign-ins back.
- Publishing a timesheet no longer waits on a slow email server, and pressing Publish several times sends one email, not several. If the email fails, the result is shown on the timesheet and in the activity log. If the server restarts while the email is sending, the timesheet says so and Publish sends it again.
- Sending a PDF that is too big now says so plainly ("the limit is 10 MB"), and emails that fail to send no longer use up your 10 per hour.
- Finalizing a timesheet twice at the same moment is logged once. A tab left open on a timesheet that was finalized elsewhere stops trying to save it.
- Viewers no longer see the Trash button, Home shows no change figure without an earlier pay period, "Leave out of totals" can be clicked, and the page shows "Loading your data…" while it retries.

## 2026-11-27 · Safer imports and Square pulls (#51)
- Tapping Create timesheet twice (New timesheet, Start blank, or the CSV review) no longer makes two sheets.
- CSV imports now skip exact duplicate rows (same person, clock-in, clock-out and break), skip dates more than 3 years back or more than a year ahead (like 1926 or 2099), and say so in the review warnings. A shift that runs past midnight at the end of its third day is cut there, as before, and now a warning names it with its real and saved hours.
- A Square pull whose reply is cut off or stalls now shows an error instead of "0 shifts", and "1 timecard is still open" reads correctly.

## 2026-11-27 · Faster photo punches, and small faces are found (#50)
- The face check now runs in the background, so the rest of the app stays quick while time clocks send photos. Large photos are shrunk first.
- A punch that can't work anyway (like clocking out when not clocked in) is refused right away, without checking the face.
- Someone standing a bit far from the time clock is no longer told "Face not detected". When no face is found, the time clock now says to move closer and look straight at the camera.

## 2026-11-27 · Full logo in the app header (#56)
- The sidebar and the phone top bar now show the whole "Payroll by SHIJIRI Group" logo, with "By SHIJIRI GROUP" in black (white in dark mode), instead of just "Payroll".

## 2026-11-27 · Easier-to-read sign-in button and time clock location name (#55)
- A main button that can't be pressed yet (like Sign in before you type a password) is now solid grey with readable text instead of faded orange.
- On a phone, the time clock shows a long location name on up to two lines instead of cutting it off.
- The colour choices for a location no longer include orange, so a location dot is never mistaken for the new orange highlight. Locations that already use orange keep it.

## 2026-11-27 · Small fixes to face data, backups and sign-in (#53)
- The face consent notice now says what is protected: face templates are encrypted, photos are stored on your server with restricted file access, and none of it is in backups.
- Recording consent or adding reference photos for someone whose face data can't be read is now refused until you delete their face data, instead of overwriting it.
- Deleting face data together with punch photos now clears the photo marker on those punches, so Live no longer asks for photos that are gone. The photo gallery now shows at most the number of photos asked for per page.
- Older backups and the activity log files are made private (owner-only) when the app starts.
- Safety copies made before a restore are now kept separately (the 10 newest), so many restores can't push out your daily and manual backups.
- An empty database file now stops the app with a clear message instead of starting a blank database. A database made by a newer version of the app logs a warning.
- Switching to a database file in a folder that doesn't exist, or to a folder, is now refused with a clear message (so a typo can't quietly start an empty database), and any other path that can't be opened says why. Nothing is switched or created, and the Test button checks the same.
- Owners (and admins, for accounts other than the owner) can clear someone's sign-in lock from Settings → Users.
- Downloading a backup uses less memory on big databases.

- A backup too big for the server's free memory is now refused with a clear message (how much memory it needs and how much is free) before anything changes, instead of the app stopping part-way.

## 2026-11-27 · Safer backups, real dates only (#52)
- Only an owner can include sign-in details (password hashes and two-factor secrets) in a downloaded backup. Administrators can still download a backup without them, and the option is hidden for them.
- Dates that don't exist, like 2026-13-45 or 30 February, are now refused with a clear message on pay rates, advances, time off, sales, the schedule and timesheets, instead of being saved or causing an error.
- A new timesheet must be for a location that exists.
- The kiosk-only address (KIOSK_HOST) now also applies when it is written with a trailing dot.
- The break reminder can't be set below 0.5 hours; a smaller number is refused instead of quietly turning the reminder off.

## 2026-11-27 · New look around the Payroll by Shijiri Group logo (#49)
- The new logo is on the sign-in screen, the sidebar, the time clock and the staff portal.
- New browser tab icon and home-screen and Android app icons: the logo's gold and orange blocks with the red dot. Installed apps may take a restart to show the new icon.
- Buttons, selection and focus are now Payroll orange instead of plum, in light and dark mode. Emails use the logo blocks and an orange button.

## 2026-11-27 · No punches lost during a restore or database switch (#48)
- While a backup restore or a database switch runs, the time clock's punches (and other changes) wait a few seconds instead of being saved into data that's about to be replaced. The tablet keeps each punch and sends it again on its own, so it's never lost.
- A restore or switch first waits for anything already being saved to finish, and a second one can't start while one is running.
- Automatic clock-out skips a run while a restore or switch is under way.
- If a restore to a Supabase database stops part-way, it now says so and asks you to run the same restore again, instead of a general database error.

## 2026-11-27 · Face data is kept through a database switch or restore (#47)
- Switching to another database, or restoring an older backup, no longer lets the daily clean-up delete saved face data. Face data isn't in backups, so before this it couldn't be got back after switching back.
- The clean-up now skips a location when the database in use doesn't have it, has no employees there, or has no punches there within the face data retention period.
- Face data for someone who isn't in the employee list is kept for 30 days before it's deleted. Removing an employee still deletes their face data straight away.

## 2026-11-27 · Clearer face match alerts and removed staff on Live (#46)
- Live → Face match refused now labels each refusal: "Face didn't match", or "Face profile needs redoing" when someone's face data can't be read, with the steps to set it up again.
- Removing someone who is clocked in now clocks them out first (the dialog says so and the button reads "Clock out and remove"), so no open shift is left behind. The server refuses to remove a clocked-in employee without that.
- Anyone already removed while still clocked in shows on Live as "Removed" (not "Working") and no longer counts in "working". Clock out on their card now works: a manager who can add punches can record a clock-out for a removed person with an open shift (only a clock-out), so their hours are kept.

## 2026-11-27 · Face match at the time clock (#45)
- Employees → camera button → Face match: once someone has three reference photos, turn on **Require face match at the time clock** for just that person.
- With it on, a punch is refused if the face doesn't match their reference photos. They're asked to try again or ask a manager, and Live shows it under "Face didn't match" with the photo, until you dismiss it.
- A punch saved on the tablet while it was offline is never lost: if the face didn't match, it's kept and tagged "Face didn't match" on Live so you can check it.
- Every time clock takes a photo of them, even one with photos turned off, so face match can't be skipped by using another tablet.
- If someone's face data can't be read (for example, after the server's key changes), their punches are refused rather than let through unchecked, and Employees shows who needs face match set up again.
- Photos: a removed employee's photos show their full name with "(removed)". Removing someone now says that their punch photos stay until the photo retention period, as pay records.

## 2026-11-26 · Photo gallery and face match set-up (#44)
- Employees → Photos: see every punch photo at the location, newest first, or one person's photos. The camera button next to each employee opens their photos.
- Face match set-up: print the consent notice for an employee to sign, record that they signed it, then pick three clear photos of them as reference photos. The app checks each one shows only them and looks like the same person.
- Delete someone's face data at any time (optionally with all their punch photos). It's also deleted when you remove the employee, and automatically after they haven't punched for a while (Settings → Locations & rules → Face data, default one year).
- Face data stays on your server, encrypted, and is never in backups.
## 2026-11-26 · Small safety checks (#43)
- Pay extras: a holiday on a date that doesn't exist (like 2026-02-30) is refused instead of saved.
- Locations: an unknown time zone is refused, so a typo can't shift every time at a location.
- Settings → Activity now lists when an employee is added, changed or removed, and when a PIN is set or cleared (never the PIN itself).
- The sign-in page no longer shows the database's name or technical errors to people who aren't signed in.
- The local database file and its backup copies can only be read by the app's own server account.
- Emailing PDFs or restoring a backup that is too large now says what was too large and the size limit.

## 2026-11-26 · Time clock lockout and camera polish (#42)
- The wrong-PIN countdown shows the right time from the very first second, isn't thrown off if someone changes the tablet's clock, and comes back if the page is reloaded during a lockout.
- The lockout message now says that each lockout in a row lasts longer (1 minute, then 2, then 4, up to 15 minutes). This was already how it worked.
- If camera access is taken away while the time clock is open, it now says "Camera blocked" (a manager can allow it again) instead of "Camera not available".
- Admin app on iPhone and iPad: you can long-press a punch photo on Live to save it again.

## 2026-11-26 · New timesheet, time clock and backup fixes (#41)
- New timesheet → Start blank: the window now closes once the timesheet is created, and a quick double tap no longer makes two of them. If creating fails, the reason shows in the window.
- A timesheet that arrives already finalized (for example, from another app through the API) now gets the same pay snapshot and advance repayments as one you finalize yourself.
- Time clock: if the database is busy for more than a few seconds (for example, during a big backup), the punch is saved on the tablet and sent automatically a moment later, instead of showing an error.
- Settings → Data → Download backup uses less extra server memory on large databases (the file is sent in pieces instead of being built as one big block of text first).

## 2026-11-26 · Safer restores, Square pulls and Supabase backups (#40)
- Restore: if any time clock punch in the file can't be read, nothing is restored and you're told how many are bad. Before, those punches were skipped, so a damaged file could wipe out punches.
- Restore: a backup with no timesheets or no punches (for example, one that was edited) no longer silently deletes all of yours. The app says what would be deleted and asks first.
- Restore: a file with timesheets that aren't from this app (no id) is refused, so it can't replace your timesheets with blank ones.
- Restore: a damaged, cut-off or wrong file gets a plain message instead of a technical error. The result says how many settings the file had, and says "kept as they were" when the file has no punches.
- Restore: several restores in a row each keep their own "before restore" backup instead of overwriting the previous one.
- Square: when Square is busy ("too many requests") or briefly down, the app waits and tries again. A garbled reply from Square now shows an error instead of looking like "no timecards". Timecards with unreadable times are skipped with a warning, a timecard is never counted twice, and a very long period says when it was cut short.
- Supabase: backups, database copies and restores now read every row. Before, Supabase returned at most 1,000 rows per request, so larger databases could get incomplete backups.

## 2026-11-26 · Stronger sign-in protection (#38)
- Wrong passwords now count against the account being tried, not only the device trying. After 8 wrong passwords for one account, that account waits 15 minutes, whichever devices the guesses came from. Signing in successfully clears it.
- Signing in to your own account no longer resets the wrong-password count for everyone else on the same network. One network gets 30 wrong tries in 15 minutes, shared by everyone on it.
- Two-step sign-in codes are limited the same way: 8 wrong codes for an account lock its second step for 15 minutes, even when the password is entered again to get a new code screen.
- Changing your password, and every other "enter your password" check, counts toward the same 8 wrong tries per account as signing in.

## 2026-11-26 · "No photo" tag for offline punches without a photo (#39)
- On Live, a punch saved on a tablet while it was offline and sent without a photo now says "No photo" instead of "No face". "No face" is only for a photo that shows no face.

## 2026-11-26 · Your server checks punch photos for a face (#37)
- The time clock no longer tries to recognize faces on the phone or tablet. It takes the photo and your server checks it for a face before it accepts the punch, so it works the same on iPhone, iPad and Android, and can't be skipped.
- No face, no punch: the kiosk says "Face not detected" and asks the person to try again.
- A punch saved on a tablet while it was offline is still kept, but if it has no photo or its photo shows no face it gets a "No face" tag on Live. If the server couldn't check its photo, the tag says "Not checked".
- If the server's face check isn't working or is busy, the kiosk says so and doesn't save the punch for later.

## 2026-11-26 · Switching database keeps time clock punches (#36)
- Settings → Database → switch with "Copy my data" now copies every time clock punch along with timesheets, locations, rates and the password. Before, the new database started with no clock-ins or clock-outs.
- The confirmation says how many punches were copied.

## 2026-11-26 · Time clock lockout countdown (#33)
- After too many wrong PINs, the time clock counts down to when it unlocks ("Try again in 0:57") instead of a fixed message, also after it goes back to the start screen, and then says "You can try again now."
- On small phones, wrong-PIN messages and the name-then-PIN screen fit without scrolling.

## 2026-11-26 · iPhone home screen edges, and labor from Square (#32)
- On an iPhone added to the home screen, the app now fills the whole screen neatly: the tab bar sits above the home bar, the top bar clears the status bar and camera, and nothing is cut off by the rounded corners, in portrait and landscape. The time clock and staff portal got the same care.
- Home and Reports: for a location that tracks time in Square, "Labor vs. sales" now counts this week's Square timecards at your saved pay rates (marked est.), instead of showing $0.00 labor until a timesheet is saved. The payroll forecast counts them too.
- If Square won't share timecards, Reports says so. When there are sales but no labor cost yet, Home and Reports show "—" instead of 0.0%, and say whether it's because no hours are in yet or someone has no pay rate.
- Reports: the labor vs. sales table fits on phones (hours sit under the labor cost).
- Long-pressing a tab, button or link no longer opens Safari's link menu (Open, Add to Reading List, Copy Link), and buttons don't get text-selected. Typed text and page content can still be selected.

## 2026-11-26 · Face check works on the kiosk web address (#35)
- On the time clock's own web address, the face check couldn't load, so every punch said "This tablet couldn't check for a face", on iPhone and iPad too. It loads now, and faces are recognized again.

## 2026-11-26 · Clearer camera messages on the time clock (#34)
- When the camera has been denied for the time clock, the screen now says "Camera blocked" (with how to fix it) instead of "Camera not available", also on Android tablets.
- The no-face messages all say the same thing: show your face to the camera and try again.

## 2026-11-26 · The time clock checks for a face before a punch (#30)
- With photos on, the time clock now always checks that a face is in the photo, also on Android tablets where the check could switch itself off. Covering the camera no longer goes through unnoticed.
- New time clock devices take a photo with each punch from the start, so the face check is on by default. Devices you already set up keep their setting. Turning photos off also turns off the face check.
- No face, no punch: the kiosk asks the person to look at the camera and try again. If it still can't see a face, a manager can add the punch on Live.
- The camera view on the time clock is much bigger and sits at the top of the screen, with a green or red frame showing whether your face is in view.

## 2026-11-26 · Clearer first steps, part 3 (#31)
- Export menu: each download says what it's for, and a toast confirms the file downloaded (with a reminder when the timesheet is still a draft). The manager summary file is named "_manager_summary".
- Check before export: "Review flagged days" opens the Payroll tab at the first flagged day.
- Sign-in: hints for the username, the setup code and a forgotten password. After a failed sign-in, a note says older installs that used one shared password sign in as admin.
- Time clock: a wrong PIN says how many tries are left before the clock locks. After clocking in, the screen says to enter the PIN again for a break or to clock out. Add device is off while hours come from Square, with a note why.
- Settings → Users marks your own sign-in as "Now (you)". Home shows "Flags (reviewed)" on a final timesheet. The staff portal header shows your full name.

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
