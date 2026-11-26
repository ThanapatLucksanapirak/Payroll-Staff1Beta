# Accountant access and email notifications

## Accountant role
- Settings → Users → Add user → Role **Accountant**. Give them a **Notification email**.
- Accountants only see payroll you **publish**: Home, Published payroll (`/timesheets`), the read-only timesheet, Reports, and Export (PDFs and CSV). They can change their own name, password, notification email and two-factor.
- They never see drafts, unpublished timesheets, Live, the schedule, employees, punches or settings. The server enforces this (default deny, `ACCOUNTANT_RULES` in `server/access.ts`), not just the screens.
- Limiting an accountant to some locations works like managers and viewers.

## Publishing
- Finalize a timesheet first (it locks). A **Publish…** bar then appears on it for owners and administrators.
- Publishing shows it to accountants and emails each one who has a notification email and access to that location. **Email again** resends; **Unpublish** hides it again.
- **Reopen** unpublishes. Finalizing again does not publish again on its own.
- Timesheet lists show a **Published** badge.

## Email (Settings → Email)
- Optional. Pick a service (Gmail, Microsoft 365, Resend, Postmark or other), enter the server, port, username, password or API key, and the from address. **Send test email** uses what's on screen, even before saving.
- The password is stored on your server only: it is never shown again, never logged, and left out of downloaded backups (without secrets) and offsite copies.
- If email is off or fails, publishing still works; the failure shows on the timesheet and in Settings → Email, and is written to Activity.

## Branded emails
- Emails come from **contact@shijiri.com** as **Shijiri Payroll Service** by default (change both in Settings → Email). Your email service must allow sending from that address (verify the domain or add it as a send-as address).
- Every email uses the same branded layout: the test email, "Payroll ready", and sign-in codes.

## Email sign-in codes (two-step verification)
- Settings → Security → Two-step verification → **Email me codes** (needs email set up and a notification email on your account). Or **Use an app** for authenticator codes as before.
- At sign-in, after the password, a 6-digit code is emailed. It expires in 10 minutes, allows 5 tries, and **Send a new code** waits 30 seconds between sends. Recovery codes still work.
- Only an owner can change the notification email of someone who uses email codes, and it can't be cleared while they're on.
- Marking a timesheet **Final** does not email anyone. Only **Publish** does.
