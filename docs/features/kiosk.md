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

**A punch needs a face in the photo.** The kiosk takes the photo and your
server checks it for a face (face-api's SSD MobileNet detector on CPU, in
`server/faceCheck.ts`; nothing is sent anywhere else). It works the same on
every phone and tablet, and a modified kiosk can't skip it. The punch is
refused, with a message on screen, when:

- the camera is blocked (permission denied, at start or taken away while the
  kiosk is open): "Camera blocked…";
- there is no camera or it stopped for another reason: "Camera not available…";
- the lens is covered or the picture is black (checked on the tablet): "Camera covered or too dark";
- no face is in the photo (the detector must be at least 60% sure): "Face not detected. Show your face to the camera and try again.";
- the face check isn't working or is busy on the server: "Ask a manager to add your punch" or "Wait a moment and try again". The kiosk shows these and never saves the punch for later.

A punch saved on the tablet while it was offline is still accepted, so it is
never lost. The server only treats a punch as saved offline when its time is
more than 2 minutes old (and less than 24 hours). If it has no photo, or the
photo shows no face, it gets a "No photo" or "No face" tag on Live for a
manager to check ("Not checked" when the face check wasn't working when it
arrived). A
newer punch is treated as live, so sending a time can't skip the check. If a
tablet's camera breaks, add the punches on Live or turn photos off for that
device.

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

## Photo gallery and face match set-up

**Employees → Photos** shows every punch photo kept at the location, newest
first, with a filter per person. The camera button on each employee opens
their own photos and **Face match**. Owners, administrators and managers can
look (the same people who can open photos on Live); setting up face match
(consent, reference photos, deleting face data) needs **Manage employees and PINs**.

Setting up face match for someone:

1. **Consent notice**: print or copy it, and have them read and sign it. It
   says what is collected, why, how long it's kept, and that it's never sold.
   Then tap **<name> signed it**. The date and who recorded it are saved and
   written to Settings → Activity. No face data is made before this.
2. **Reference photos**: open clear photos of them and tap **Use as reference
   photo**. The server checks there is exactly one clear face, and that it
   looks like the same person as their other reference photos (closest
   distance at most 0.55), so a coworker's photo can't be added by mistake.
   Three are needed; up to ten are kept (the oldest goes first).

The server turns each reference photo into a face template (128 numbers from
face-api's face recognition model, on the server, no outside service).

3. **Require face match at the time clock**: the switch in the Face match
   card, available once they have three reference photos (removing one below
   three turns it off).

With face match on for someone, every punch they make is checked against
their reference photos, on every time clock: one with photos turned off still
takes a photo of them (the kiosk is told per person), and a punch without one
is refused. A match needs their closest reference photo to be at
most 0.5 away (face-api's default is 0.6; 0.5 is stricter, so a lookalike
coworker is less likely to pass, while the same person usually scores 0.25 to
0.45). The distance is saved on the punch (`meta.faceMatch`).

- **Doesn't match, live**: the punch is refused with "Face not recognized.
  Look straight at the camera and try again. If it keeps happening, ask a
  manager to add your punch." It shows on Live under **Face didn't match**,
  with the photo, until a manager dismisses it. These alerts are kept for 14
  days (200 at most); their photos follow the punch photo retention.
- **Doesn't match, saved offline** (sent more than 2 minutes late): kept, so
  nothing saved on the tablet is lost, but tagged **Face didn't match** on Live.
- **No face** or the check isn't working: as for everyone (above).
- **Saved offline without a photo** (for example, the tablet didn't know
  face match was on yet): kept and tagged **No photo**.
- Turning face match off, or deleting their face data, stops the check at once.
- **Face data that can't be read** (a damaged `profile.enc`, or the server's
  PIN key changed, for example after moving servers without `config.json` or
  changing `PIN_KEY`): it fails closed. Live punches for that person are
  refused ("Face match isn't working for you right now. Ask a manager to add
  your punch.") with an alert on Live; offline ones are kept and tagged
  **Not checked**. Employees shows a red banner and badge naming them: open
  them, **Delete face data**, and set face match up again.

Limits worth knowing:

- **No liveness check.** A clear printed photo or a phone screen showing the
  person's face can pass, including one of their own reference photos. Face
  match stops someone casually using a coworker's PIN; it doesn't stop a
  determined attempt. The refused-punch photos on Live, and the photo kept with
  every punch, are the backstop.
- **Two faces in the photo**: the check uses the face the detector is most sure
  of. If the employee is in the frame and clearest, a punch made by someone
  standing next to them can pass. Reference photos themselves must have only
  one face.

Where face data lives: `DATA_DIR/face-data/<location>/<employee>/` (set
`FACE_DATA_DIR` to move it). The consent record and templates are in
`profile.enc`, encrypted (AES-256-GCM, key derived from the server's PIN key);
reference photos are copies in `refs/`, so they stay when punch photos expire.
**Face data is never in backups or the database.**

Deleting face data:

- **Delete face data** in the person's Face match card removes their consent
  record, reference photos and templates. Tick **Also delete all their punch
  photos** to remove those too (punches and hours are kept).
- Removing an employee deletes their face data.
- **Settings → Locations & rules → Face data** (default 365 days, 30 to 1095): face
  data is deleted automatically once someone hasn't punched for that long,
  checked daily.

Biometric privacy laws (Illinois BIPA, Texas, Washington and others) ask for
written consent, a published retention schedule and deletion when no longer
needed; the steps above are built for that, but they aren't legal advice.

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
