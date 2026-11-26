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
