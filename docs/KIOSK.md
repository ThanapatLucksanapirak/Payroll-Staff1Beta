# Time clock (kiosk)

Employees clock in and out on a tablet or PC at the door. Punches show up
instantly on the admin app's **Live** page and can be turned into a timesheet
like a Square pull.

## 1. Choose where each location's hours come from

Settings → Locations → pick a location → **Time clock** → *Hours come from*:

| Option      | Effect |
|-------------|--------|
| Square      | Default. The kiosk is turned off for this location. |
| Time clock  | Employees use the kiosk. "From the time clock" replaces "Pull from Square" when creating a timesheet. |
| Both        | Both import options are offered. |

Also choose the kiosk sign-in: **PIN only** (fastest) or **Tap name, then PIN**.
Click **Save location**.

## 2. Add employees

Open **Employees** (top bar). Use **Import names** to copy names from the
location's saved rates and recent timesheets, then edit each person to give
them a 4–6 digit PIN (**Generate** picks one). PINs are unique per location and
stored hashed (scrypt with a per-location salt); the admin app shows the PIN
once when it is saved.

Names should match how they appear in your timesheets so hours line up with
saved rates. Turn **Active** off to stop someone using the clock without
deleting their history.

## 3. Pair a device

Settings → Locations → Time clock → **Add device**. You get, once:

* a **pairing link** (`https://your-host/kiosk#pair=…`): open it on the tablet;
* a **pairing code** (`ABCD-1234`, single use, expires after 15 minutes): open
  `https://your-host/kiosk` on the tablet and type it.

The device keeps a long random token in its browser storage and sends it as
the `X-Kiosk-Token` header. The token only works for that one location and only
for `/api/kiosk/*`: it cannot read timesheets, pay, settings or other
locations. Remove a device (trash icon) to revoke it immediately.

Tip: on the tablet, add the page to the home screen and use the full-screen
button. The kiosk asks the browser to keep the screen on where supported.

## 4. Using the kiosk

PIN (or name → PIN) → the kiosk shows the person's state and only the actions
that make sense: **Clock in**, **Start break**, **End break**, **Clock out**
(clocking out during a break ends the break). A confirmation such as "Good
morning, Ana — Clocked in at 9:02 AM" shows for a few seconds, then the screen
resets. Impossible actions get a friendly message ("You're already clocked
in."). A shift left open for more than 16 hours is treated as forgotten, so the
person can clock in again; the import lists the open shift as a warning.

After 5 wrong PINs in a row a device is locked for 1 minute (doubling on each
further lockout, up to 15 minutes).

## 5. Offline behaviour

If the network drops, the top bar shows **Offline**. The kiosk switches to
"tap your name, then PIN" (a PIN alone can't be checked without the server),
uses the last known clock states, and saves punches on the device with the
time they happened and a unique id. When the connection returns they are sent
in order.

The server:

* ignores an id it already has, so a punch is never stored twice;
* accepts a device time up to 24 hours old and at most 2 minutes in the future
  (the kiosk corrects for its own clock drift using the server time);
* checks the PIN and the clock state when the punch arrives. A punch that is
  refused (wrong PIN, impossible sequence, too old) is dropped and the kiosk
  shows a notice asking the employee to tell a manager.

Queued punches (including the PIN typed with them) stay in the tablet's browser
storage until they are sent. Unpairing or removing the device discards them.

## 6. Live page and fixing punches

**Live** shows who is working, on break or out, since when, and today's hours,
plus today's punch feed. It updates instantly through Server-Sent Events
(`GET /api/live`, authenticated with a 60-second ticket from
`POST /api/live/ticket`; a heartbeat every 25 s keeps proxies such as
Cloudflare from closing the connection; it reconnects by itself).

Use **Fix** on a punch to change its type or time, or delete it, and **Add
punch** for a missed one. A note is required and is kept with the punch (with
the previous value). If the change would leave an impossible sequence you are
told why and can save anyway.

## 7. Creating a timesheet from punches

New timesheet → **From the time clock** → choose the dates. Clock-ins are paired
with clock-outs in the location's time zone; breaks become the shift's break
minutes; a shift belongs to the day it started (overnight shifts end after
midnight). Shifts with no clock-out are left out and listed as warnings.
Shifts that include an edited or admin-added punch are noted.

## 8. A separate hostname for the kiosk (KIOSK_HOST)

To give the tablets their own address without exposing the admin app there,
point a second Cloudflare Tunnel hostname at the same port and set:

```
KIOSK_HOST=clock.example.com          # comma-separate several
```

Requests whose `Host` is one of these names only get `/kiosk`, its own
script/style files, `/api/kiosk/*` and `/api/health`; `/` redirects to
`/kiosk`; everything else (admin pages, admin API, `/api/live`) is 404. The
main hostname is unaffected. Example `cloudflared` ingress:

```yaml
ingress:
  - hostname: payroll.example.com
    service: http://localhost:5000
  - hostname: clock.example.com
    service: http://localhost:5000
  - service: http_status:404
```

You can also put Cloudflare Access in front of the admin hostname only.

## 9. Database

* SQLite: punches live in a `punches` table, created by migration 4 on start.
* Supabase: run the setup SQL again (Settings → Database → copy setup SQL); it
  adds `public.punches` and is safe to re-run. Until then the kiosk reports
  that the table is missing; the rest of the app keeps working.
* Employees and devices are stored in `app_settings` (`employees:<siteId>`,
  `kiosk_devices`). Backups and exports include punches.

## 10. Lock the tablet to the time clock

Two layers keep the kiosk from being misused.

**Manager PIN (in the app).** Set one per location in **Settings → Locations →
Time clock → Manager PIN** (4 to 8 digits, stored hashed). On the kiosk, the
manager PIN is required to open the device settings, unpair the device, or
leave full screen. Unpairing from the kiosk also removes the device on the
server. Until a PIN is set, those actions stay locked. Wrong manager PINs share
the same lockout as employee PINs (5 tries, then 1 minute, doubling). The PIN
is left out of backups unless you export with secrets.

**Device lockdown (on the tablet).** This stops people leaving the app:

- **iPad: Guided Access.** Settings → Accessibility → Guided Access: on, and set
  a passcode. Open the kiosk in Safari, Share → Add to Home Screen, and open it
  from the Home Screen. Triple-click the side (or Home) button → Start. To leave,
  triple-click and enter the passcode.
- **Android: screen pinning.** Settings → Security → App pinning: on, with "Ask
  for PIN before unpinning". In Chrome, ⋮ → Add to Home screen → Install, then
  open it. Recent apps → tap the app icon → Pin. To leave, hold Back and
  Overview (or swipe up and hold) and enter the device PIN.
- **Windows / Linux PC: Chrome kiosk mode.** Run
  `chrome --kiosk --app=https://YOUR-ADDRESS/kiosk` from a startup shortcut
  (Windows: `shell:startup`; Linux: your desktop's autostart). For a fully
  locked Windows PC use Assigned Access (Settings → Accounts → Other users →
  Set up a kiosk). Leave with Alt+F4 / Ctrl+Shift+Q.

Also turn off auto-lock/sleep while charging and keep the device plugged in.
