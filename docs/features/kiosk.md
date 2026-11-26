# Time clock kiosk: extras

These build on the time clock described in `docs/KIOSK.md`. Everything is set up in
**Settings → Locations → Time clock** (owners and administrators), except shift
notes and fix requests, which managers handle on the **Live** page.

## Per-device options

Each device in the *Kiosk devices* list has an **Options** button:

| Option | What it does | Default |
|---|---|---|
| Photo with each punch | Takes a small front-camera photo at every punch. | Off |
| Ask for a station at clock-in | Shows the location's station list at clock-in. | On (only used when the location has stations) |
| Sign-in on this device | *Same as location*, *PIN only*, or *Name list, then PIN*. | Same as location |
| Back to the start screen after | Seconds without a touch before the PIN and action screens reset. 5 to 120. | 10 |

Changes reach the tablet the next time it refreshes (within a minute, or right
away when it is reopened). The tablet's own settings sheet shows the current
options.

## Photo on punch

When photos are on for a device, the camera starts when someone reaches the
action screen (a small preview in the corner says "Photo taken with your
punch") and a 320-pixel JPEG is taken at the moment they tap.

**A punch needs a face in the photo.** Before sending, the kiosk checks the
picture on the tablet itself (MediaPipe's BlazeFace model, served by this app
from `/face/`; nothing leaves the device). The punch is stopped, with a message
on screen, when:

- the camera is blocked (permission denied): "Camera blocked…";
- there is no camera or it stopped: "Camera not available…";
- the lens is covered or the picture is black: "Face not detected: the camera looks covered…";
- nobody is in view: "Face not detected. Look at the camera and try again."

The preview in the corner turns red and says "Face not detected" while no face
is in view. The server also refuses a live punch without a photo. Punches saved
on the tablet while it was offline are still accepted without one, so they are
never lost; they show the "no photo" icon on Live. If a tablet's camera breaks, add the punches on Live or turn
photos off for that device. On a very old tablet that can't run the face model,
the covered/black check still applies.

- Photos are files on the server: `DATA_DIR/punch-photos/<location>/<punch>.jpg`
  (set `PUNCH_PHOTO_DIR` to move them).
- On **Live**, editors see a thumbnail next to each kiosk punch; click it to
  enlarge. Viewers, kiosk devices and signed-out visitors can't open photos.
- Photos are deleted automatically after the location's retention period
  (**Punch photos → days**, default 90), checked daily, and when their punch is
  deleted.
- **Photos are not in backups** (JSON exports or the automatic daily backups):
  they would make them far too big. The punch itself is backed up and remembers
  that it had a photo. To keep photos, copy the `punch-photos` folder yourself.
- The camera needs HTTPS (the Cloudflare Tunnel address is fine). The browser
  asks for camera permission the first time; allow it once on the tablet.
- Photos taken while offline are kept with the queued punch (up to 20; after
  that, queued punches are saved without a photo).

## Big buttons, high contrast, idle reset

The kiosk uses large, high-contrast buttons (at least 64 px, bigger keypad)
so it works with wet hands and gloves. After the device's idle time without a
touch, the PIN and action screens go back to the start screen.

## Confirmation screen

After each punch a full-screen, colour-coded confirmation shows for about five
seconds: "Clocked in 9:02 AM", the person's name, hours worked today, and their
break status (on a break since…, break taken today, or no break yet). Tap
anywhere to finish early. Punches saved offline show a shorter version, since
today's hours aren't known until they are sent.

## Wrong action guard

If an action doesn't fit the person's state (clock in while already in, end a
break when not on one, and so on), the kiosk says so and offers the right
action, for example "You're already clocked in. Clock out instead?" with a
**Clock out** button. The server checks this too, so two tablets can't create an
impossible sequence. Punches for the same person are handled in the order they
arrive, even from two tablets a moment apart.

## Stations

Add stations under **Stations** (e.g. Sushi bar, Kitchen, Front). At clock-in
the kiosk asks "Where are you working?" (with a *Not listed* option). The
station is saved with the clock-in punch and shown on Live (on the person's card
and in the punch list). With no stations, or with the option off for the
device, the question is skipped.

## Break reminders

Turn on **Break reminder** and choose the hours (e.g. 5). When someone has
worked that long since clocking in or since their last break, the kiosk shows
"5h 10m without a break. Time for a break." and highlights **Start break**, and
Live shows a **Break due** badge on their card. This is a reminder only; it
doesn't change any hours.

## Shift notes

On **Live → Shift notes → Post a note**, managers write a note for everyone or
for chosen people, shown until the end of today, tomorrow, a week, or until
removed. Each person sees it once, right after they clock in, and taps **OK**.
Live lists who has seen each note. Notes that ended more than 30 days ago are
cleaned up.

## Fix requests

After signing in with their PIN, an employee can tap **Fix a missed punch**,
pick what they forgot (clock in, break start/end, clock out), the day (up to a
week back), the time, and an optional note. It needs a connection.

Requests appear under **Fix requests** on Live (managers of that location and
administrators). **Approve** adds the punch exactly like *Add punch* (checked
against the person's other punches, with the note kept on the punch, flagged as
edited in the payroll import). You can adjust the time before approving, and
approve anyway if it doesn't fit. **Decline** takes an optional reason. Approved
and declined requests are kept for 60 days. Each employee can have at most 10
requests waiting.

## Where things are stored

All in the settings table, so they are included in backups and restores:
`kiosk_config:<location>` (stations, break reminder, photo retention),
`kiosk_notes:<location>`, `kiosk_fix_requests:<location>`, and device options
inside `kiosk_devices`. Punches keep their station and photo flag in the
punch's `meta_json`. Photos are files (see above). Changes are recorded in the
activity log (`kiosk.*`).
