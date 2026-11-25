# Employee portal (`/me`)

A separate page for staff, on their own phone: their hours this pay period,
their pay statements, their schedule for the next two weeks, and time-off
requests. Staff don't need a user account; they sign in with the name and
PIN they already use on the time clock.

## Turning it on (owners and administrators)

**Settings → Locations → Time clock → Employee portal**: a switch per
location, **off by default**. When it is on, the card shows the link to give
staff (`https://<your address>/me`) with **Copy link** and **Open**.

- Only active employees with a PIN (Employees page) can sign in.
- Turning it off signs everyone at that location out of the portal at once.
- Changing someone's PIN, deactivating or removing them also ends their
  portal sessions straight away.

## For staff

Open `/me` (iPhone: Share → Add to Home Screen; Android: menu → Install app.
It installs as its own "My Work" app). Pick the location (skipped when only one
has the portal on), type your name (full name, or just your first name when no
one else at the location has it), and your time clock PIN. Sessions last 12
hours. **Sign out** signs you out on all your devices.

Bottom tabs:

- **Hours**: this pay period (the location's pay period setting) or the last
  one, live from the time clock, day by day with each shift and break. Each day
  shows *Working now* / *On break now*, *Being checked* (a punch problem the
  manager hasn't approved yet, e.g. "Auto-closed" or "Very short shift"),
  *Approved* (approved on Live → Fix punches), or *Worked*. These are raw
  time-clock hours; the pay statement has the final numbers.
- **Pay**: every **finalized** (locked) timesheet of the location that includes
  the person (matched by name, the same way statements and year-to-date are),
  newest first, with their own take-home or gross total. Tap one to download
  their pay statement PDF, made on the phone in the same format as the owner's
  statements (including year to date for that year up to that period). Drafts
  and reopened timesheets don't show.
- **Schedule**: the next 14 days of their shifts from **published** weeks
  only, plus approved time off. A week that isn't published yet says so.
  Note: a published week that was changed afterwards shows the current shifts
  (the schedule keeps one version of each week).
- **Time off**: ask for a day or a range (up to 60 days, starting today or
  later, up to a year ahead) with an optional note. The list shows Waiting /
  Approved / Declined for the last 60 days and everything ahead, including time
  off the owner entered. A request still waiting can be cancelled; approved
  ones can't (ask the manager). At most 10 requests can wait at once, and a
  request can't overlap their existing time off or requests.

## Owner side: answering requests

On **Schedule**, waiting requests appear in a **Time-off requests** list above
the grid with **Approve** and **Decline** (managers with "Manage the schedule"
and up; viewers only see them). Approved requests are ordinary approved time
off: grey block on the schedule, skipped by "Copy last week", silence late
alerts, left out of the forecast. Tapping the grey block edits it as before.
The Schedule page updates live when a request arrives.

## Security

The portal is meant to be reachable through Cloudflare Tunnel, so:

- **Lockout**: 5 wrong tries for one person lock that person's portal sign-in
  for 5 minutes, then 10, 20 … up to 24 hours (forgotten after a day without a
  wrong try). 15 wrong tries from one address lock that address for 15
  minutes, doubling likewise. Attempts are checked one at a time, so parallel
  guesses can't get around it. Locks are in memory (a restart clears them).
  Lockouts are recorded in Activity (`portal.lockout`).
- A wrong name and a wrong PIN get the same answer and take the same time.
- The session is a signed cookie (`payroll_portal`), httpOnly, SameSite=Strict,
  Secure on https, limited to `/api/portal`, 12 hours. It is signed differently
  from the admin session; the admin API never accepts it and the portal never
  accepts the admin session.
- Every answer is built on the server for the signed-in person only (no ids in
  the URL can reach someone else's hours, statements or requests).
- Activity log: `portal.login`, `portal.lockout`, `portal.settings`,
  `timeoff.request`, `timeoff.cancel`.

## Storage and API

App settings (included in backups; nothing secret): `portal:<siteId>`
(`{ enabled }`), `portal_revoked:<siteId>` (sign-out times per employee).
Requests are entries in the existing `timeoff:<siteId>` list with
`requestedBy: "employee"`, `status: "pending"`.

`/api/portal/*` (own session, registered before the admin middleware):
`GET sites`, `POST login`, `POST logout`, `GET me`, `GET hours?offset=0|-1…`,
`GET statements`, `GET statements/:id`, `GET schedule`, `GET|POST time-off`,
`DELETE time-off/:id`. Owner/admin: `GET|PUT /api/sites/:siteId/portal`.
Pure rules are in `shared/portal.ts`; tests in `tests/portal.test.ts`.
