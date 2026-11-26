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
- Changing your own notification email asks for your password. Only an owner can change the notification email of someone else who uses email codes, and it can't be cleared while they're on.
- Marking a timesheet **Final** does not email anyone. Only **Publish** does.

## Gmail: Connect with Google (no App password)
Settings → Email → **Gmail / Google Workspace** → How to sign in: **Connect with Google**.

One-time setup in Google Cloud (console.cloud.google.com), signed in as the Google account that will send:
1. Create a project (any name).
2. **APIs & Services → OAuth consent screen**: pick **Internal** if you use Google Workspace (no Google review needed), otherwise External and add yourself as a test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**. Under **Authorized redirect URIs**, add the address shown in Settings → Email (e.g. `https://payroll.yourcompany.com/api/email/google/callback`).
4. Paste the **Client ID** and **Client secret** into Settings → Email, then press **Connect with Google**, sign in and press **Allow**.

- The app asks for Gmail's sending permission (`https://mail.google.com/`), which Gmail's SMTP server requires.
- The client secret and the Google token stay on your server; they're never shown again, logged, or put in backups without secrets. **Disconnect** removes the token and cancels it at Google.
- The From address must be the Google account's own address or a "Send mail as" address in Gmail, otherwise Gmail sends from the account's address.
- The App password method still works (choose **App password**).

## Email payroll PDFs to anyone
On a finalized timesheet, **Email PDFs…** (next to Publish, or in Export) sends the reports as attachments from the address in Settings → Email.
- Pick any of: Full report, Manager summary, Pay statements, Pay-out sheet (the same PDFs as Export).
- Send to accountants in the app and/or any email addresses you type (up to 10 per email). Optionally send yourself a copy and add a message.
- **Preview…** shows exactly what will go out (from, to, replies-to, subject, attachments and the email itself). Nothing is sent until you press **Send email**.
- Owners and administrators only, 10 emails per person per hour, and every send is in Activity with its recipients. Replies go to the person who sent it.

## Replies and tidying
- **Block replies** (Settings → Email, on by default): app emails set Reply-To to `no-reply@<your domain>` (replies bounce), ask mail servers not to send out-of-office replies, and say the mailbox isn't read. Emails a person sends (PDFs) still reply to that person.
- **Keep the app's emails out of your inbox** (Connect with Google only, on by default): each sent copy gets a Gmail label named after the From name and is archived and marked read. Needs the **Gmail API** turned on in the same Google Cloud project (APIs & Services → Library → Gmail API → Enable). With an App password instead, make a Gmail filter: from `contact@shijiri.com` → Skip the inbox, apply a label.
