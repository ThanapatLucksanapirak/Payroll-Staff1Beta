# Access: roles, two-factor sign-in, installable app, offsite backups

## Role permissions (Settings → Users → Roles)

Owners and Administrators can always do everything. For **Managers** and **Viewers** you tick what they can see and do:

| Permission | Manager (standard) | Viewer (standard) |
| --- | --- | --- |
| See pay rates and money totals | on | on |
| Export PDFs and CSV (needs pay) | on | on |
| Edit timesheets (needs pay) | on | off |
| Edit punches and approve shifts | on | off |
| Manage employees and PINs | off | off |
| See reports | on | on |
| Manage the schedule | on | off |

The standard settings are exactly how the roles worked before. "Reset to standard" puts them back. Changes apply straight away, including for people who are signed in, and are recorded in Activity.

- **Pay hidden**: amounts show as "—" everywhere. The server itself sends 0 for every rate, amount and total, so nothing leaks through the browser. Exports and timesheet editing switch off with it (you can't save a timesheet whose rates you can't see).
- **Export** and **See reports** hide the buttons and the Reports page. Someone who can see pay can still read the numbers on screen, so think of export as a convenience switch, not a security boundary.
- **Manage employees** lets a manager add people and set PINs at their own locations (kiosk devices and the manager PIN stay with owners and admins).

## Looking up employee PINs (owners)

Owners can press **Show PINs** on the Employees page and re-enter their password to see the time clock PINs at that location. They hide again after 2 minutes, and every look-up is written to Settings → Activity ("employee.pins-viewed"). Administrators, managers and everyone else can only set a new PIN.

How it's kept safe: each PIN is still stored as a salted scrypt hash for signing in, plus an encrypted copy (AES-256-GCM, tied to the location and employee) for look-ups. The encryption key is in `DATA_DIR/config.json` on the server (or the `PIN_KEY` environment variable, which must be 32 random bytes in base64url, e.g. `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`; a passphrase is refused), never in the database, backups or offsite copies. So a stolen database or backup file doesn't reveal PINs; someone with the server's data folder could. PINs set before this feature have no encrypted copy and show "Set a new one to see it". After restoring a backup onto a different server, PINs keep working on the kiosk but can't be shown until they are set again.
- Location limits on a user still apply on top of all of this.

For developers: a POLICY rule in `server/access.ts` can name a `perm`; for managers and viewers the permission then decides. Rules without one keep their role need. Routes whose path mentions `schedul…` or `approv…` (writes) or starts with `/report` (reads) also need that area's permission automatically.

## Two-factor sign-in (Settings → Account & password)

After the password, sign-in asks for a 6-digit code from an authenticator app (Apple Passwords, Google Authenticator, 1Password, Authy…).

- **Set up**: enter your password, scan the QR code (or type the key), enter the first code. You get **10 recovery codes**: each works once instead of a code if you lose your phone. Save them; they're not shown again. You can make new ones any time (the old ones stop working).
- **Remember this device for 30 days**: tick it at sign-in and that browser won't ask for a code for 30 days. "Forget remembered devices" ends that everywhere.
- **Require for owners and administrators**: off by default so nobody gets locked out. You can only turn it on once your own account uses two-factor. Owners and admins without it set it up the next time they sign in. Managers and viewers can turn it on for themselves.
- Until it's on, owners and admins see a small "Protect payroll with two-factor" note on Home (dismissable).
- **Lost phone**: an owner can reset another person's two-factor from Settings → Users (⋯ → Reset two-factor). If the only owner is locked out, on the server run `sudo payroll admin disable-2fa --username NAME` (or `node dist/index.cjs admin disable-2fa --username NAME`).
- Codes are rate limited like passwords, a code can't be used twice, and a sign-in attempt allows 5 tries.

## Install on a phone or tablet

The app can be added to the home screen and opens like a normal app (white, no browser bars).

- **iPhone/iPad**: open the app in Safari → Share → Add to Home Screen.
- **Android**: Chrome menu → Install app.
- **Kiosk tablet**: open `/kiosk` and add it to the home screen the same way. It's a separate "Time Clock" app that opens full screen.

Only the app's own files (pages, scripts, icons) are kept for fast start-up. Payroll data and sign-in are never stored offline; with no connection the app says it can't reach the server. Installing needs the https address (Cloudflare Tunnel) — plain `http://` on the local network works, just not as an installed app.

Icons are drawn from the logo by `npx tsx script/icons.ts` (already done; the PNGs are in `client/public/icons`).

## Offsite backup copies (Settings → Backup & history → Offsite copies)

The server already makes a backup every night. These copy each nightly (and "Back up now") backup somewhere else too, so losing the computer doesn't lose the data:

- **Folder**: a USB disk or network share mounted on the server, e.g. `/mnt/usb/payroll`. The folder must already exist — the app never creates it, so an unplugged disk shows as a failure instead of quietly filling the system disk. Keeps the newest N copies (other files there are left alone).
- **Cloud storage**: Amazon S3, Backblaze B2, Cloudflare R2 or any S3-compatible service. Enter endpoint (blank for Amazon), region (`auto` for R2), bucket, folder, access key and secret key. Keeps the newest N copies under that folder. Tip: use a key that can only write to that bucket.
- **Test** writes (and removes) a small test file with the settings on screen. **Copy now** sends the newest backup right away.
- The last success or failure is shown under each destination. A failing destination also shows a red note on Home for owners and admins.

Copies leave out user accounts, password hashes, two-factor secrets, Square tokens, the kiosk manager PIN and these storage credentials (a restore never uses those anyway; after restoring onto a new server, add the users again and reconnect Square). The secret key is never sent back to the browser, and the offsite settings are never included in any backup file. Note: the exact database-file copy kept on the server itself (SQLite) still contains everything; it never leaves the server.
