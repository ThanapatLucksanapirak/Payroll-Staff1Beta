// Send a finalized payroll's PDFs by email: to accountants in the app, or to
// any address the owner types.
//
// Owners and administrators pick which reports to send (the browser makes the
// PDFs, the same ones as Export), see a preview of the email, then confirm.
// The email goes from the address in Settings → Email (contact@shijiri.com by
// default), with the PDFs attached. Replies go to the person who sent it, if
// they have an email address.
//
// Because it can go to any address, it is owner/admin only, limited to 10
// recipients per email and 10 emails per person per hour, and every send is in
// the activity log with its recipients.
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "./db";
import * as settings from "./settings";
import { actorOf, audit } from "./audit";
import { currentUser } from "./auth";
import { type EmailAttachment, brandName, brandedHtml, emailReady, getEmailConfig, replyPolicy, sendEmail } from "./email";
import { periodText, recipientsFor } from "./publish";
import { notificationEmailSchema } from "./users";

export const SHARE_PATH = /^\/api\/timesheets\/[^/]+\/share$/;
export const REPORTS = {
  report: "Full report",
  summary: "Manager summary",
  statements: "Pay statements",
  payout: "Pay-out sheet",
} as const;
export type ReportKind = keyof typeof REPORTS;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 10;
const MAX_TOTAL = 18 * 1024 * 1024;
// Generous cap on the encoded text: oversize PDFs get the friendly message below, not a schema error.
const MAX_BODY_DATA = 24 * 1024 * 1024;

const bodySchema = z.object({
  /** Accountants picked from the list. */
  recipientIds: z.array(z.string().max(100)).max(50).default([]),
  /** Any other addresses, typed in. */
  emails: z.array(notificationEmailSchema.refine((v) => v !== "", "Enter a valid email address.")).max(MAX_RECIPIENTS).default([]),
  files: z.array(z.object({ kind: z.enum(Object.keys(REPORTS) as [ReportKind, ...ReportKind[]]), data: z.string().max(MAX_BODY_DATA) })).min(1, "Pick at least one report.").max(4),
  message: z.string().trim().max(1000).default(""),
  copyMe: z.boolean().default(false),
  /** false: only build the preview. */
  send: z.boolean().default(false),
});

// A few sends per person per hour.
const LIMIT = 10;
const WINDOW_MS = 60 * 60_000;
const sends = new Map<string, number[]>();
/** Tests only. */
export function resetShareLimit() { sends.clear(); }

const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Payroll";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function registerShareRoutes(app: Express) {
  // PDFs make this body bigger than the app's usual limit.
  app.post("/api/timesheets/:id/share", express.json({ limit: "26mb" }), h(async (req, res) => {
    const id = String(req.params.id);
    const user = currentUser(res)!;
    const body = bodySchema.parse(req.body ?? {});
    const row = await (await db()).getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    if (row.meta_json?.deletedAt) return res.status(410).json({ error: "This timesheet is in the Trash." });
    if (row.meta_json?.status !== "final") return res.status(409).json({ error: "Finalize the timesheet before sending it." });
    const cfg = await getEmailConfig();
    if (!emailReady(cfg)) return res.status(409).json({ error: "Email isn't set up. Set it up in Settings → Email first." });

    const siteId = row.site_id ?? (await settings.defaultSiteId());
    const allowed = (await recipientsFor(siteId)).filter((u) => !!u.notificationEmail);
    const picked = allowed.filter((u) => body.recipientIds.includes(u.id));
    if (picked.length !== new Set(body.recipientIds).size) return res.status(400).json({ error: "That accountant has no email address or can't see this location. Type their address instead." });
    // Everyone it goes to, once each (by address).
    const recipients = new Map<string, { name: string; email: string }>();
    for (const u of picked) recipients.set(u.notificationEmail!.toLowerCase(), { name: u.displayName || u.username, email: u.notificationEmail! });
    for (const e of body.emails) if (!recipients.has(e.toLowerCase())) recipients.set(e.toLowerCase(), { name: "", email: e });
    if (!recipients.size) return res.status(400).json({ error: "Add at least one email address." });
    if (recipients.size > MAX_RECIPIENTS) return res.status(400).json({ error: `Send to ${MAX_RECIPIENTS} addresses or fewer at a time.` });
    const toList = [...recipients.values()];

    // The PDFs: real PDFs only, one of each kind, named by the server.
    const site = await settings.getSite(siteId);
    const label = row.custom_label || row.filename || "Payroll";
    const kinds = new Set<string>();
    const attachments: EmailAttachment[] = [];
    let total = 0;
    for (const f of body.files) {
      if (kinds.has(f.kind)) return res.status(400).json({ error: "Each report can only be attached once." });
      kinds.add(f.kind);
      const content = Buffer.from(f.data, "base64");
      if (content.length < 5 || content.subarray(0, 5).toString("latin1") !== "%PDF-") return res.status(400).json({ error: `The ${REPORTS[f.kind].toLowerCase()} isn't a PDF.` });
      if (content.length > MAX_FILE) return res.status(413).json({ error: `The ${REPORTS[f.kind].toLowerCase()} is too big to email (the limit is 10 MB).` });
      total += content.length;
      attachments.push({ filename: `${fileSafe(`${site?.name ? `${site.name} ` : ""}${label}`)} - ${REPORTS[f.kind]}.pdf`, content, contentType: "application/pdf" });
    }
    if (total > MAX_TOTAL) return res.status(413).json({ error: "Those PDFs are too big to email together. Send fewer at a time." });

    const brand = await brandName(cfg);
    const by = user.displayName || user.username;
    const period = periodText(row.period_start, row.period_end);
    const where = site?.name ? ` for ${site.name}` : "";
    const subject = `Payroll documents${where}${period ? `: ${period}` : ""}`;
    const base = cfg.appUrl.replace(/\/+$/, "");
    const link = base ? `${base}/#/timesheet/${encodeURIComponent(row.id)}` : "";
    const details: [string, string][] = [
      ["Payroll", label],
      ...(site?.name ? [["Location", site.name] as [string, string]] : []),
      ...(period ? [["Pay period", period] as [string, string]] : []),
      ["Employees", String(row.employee_count)],
      ["Attached", body.files.map((f) => REPORTS[f.kind]).join(", ")],
      ["Sent by", by],
    ];
    const intro = `${by} sent you the payroll documents for ${label}${period ? ` (${period})` : ""}. They're attached as PDFs.`;
    const paragraphs = [intro, ...(body.message ? [`Message from ${by}: “${body.message}”`] : [])];
    const replyTo = user.notificationEmail || undefined;
    const msg = {
      to: toList.map((r) => r.email),
      cc: body.copyMe && user.notificationEmail && !recipients.has(user.notificationEmail.toLowerCase()) ? [user.notificationEmail] : [],
      subject,
      text: [...paragraphs, "", ...details.map(([k, v]) => `${k}: ${v}`), ...(link ? ["", `Open it in ${brand}: ${link}`] : [])].join("\n"),
      html: brandedHtml({
        brand, preheader: `${label}${period ? ` · ${period}` : ""}: ${attachments.length} PDF${attachments.length === 1 ? "" : "s"} attached.`, heading: "Payroll documents for you",
        paragraphs, details, button: link ? { label: "Open payroll", url: link } : undefined,
        footer: `Sent by ${by} from ${brand}.${replyTo ? ` Replies go to ${by}.` : ""}`,
      }),
      attachments,
      replyTo,
    };

    if (!body.send) {
      const shown = replyPolicy(cfg, msg);
      return res.json({
        from: `${cfg.fromName || brand} <${cfg.fromAddress}>`,
        to: toList,
        cc: msg.cc,
        replyTo: shown.replyTo ?? null,
        subject,
        html: shown.html,
        attachments: attachments.map((a) => ({ filename: a.filename, size: a.content.length })),
      });
    }

    const now = Date.now();
    const recent = (sends.get(user.id) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) return res.status(429).json({ error: "That's a lot of emails in an hour. Wait a while and try again." });
    sends.set(user.id, [...recent, now]);

    const result = await sendEmail(msg);
    // Only emails that actually went out count toward the hourly limit.
    if (!result.ok) { const list = sends.get(user.id); const i = list ? list.indexOf(now) : -1; if (list && i >= 0) list.splice(i, 1); }
    const names = toList.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", ");
    audit({ ...actorOf(req, res), action: "timesheet.share", target: `timesheet:${id}`, detail: `${label} · ${[...kinds].map((k) => REPORTS[k as ReportKind]).join(", ")} → ${names}: ${result.ok ? "sent" : "skipped" in result && result.skipped ? result.reason : `failed: ${(result as any).error}`}` });
    if (!result.ok) return res.status(502).json({ error: "skipped" in result && result.skipped ? result.reason : `The email couldn't be sent: ${(result as any).error}` });
    res.json({ ok: true, message: `Sent ${attachments.length} PDF${attachments.length === 1 ? "" : "s"} to ${toList.map((r) => r.name || r.email).join(", ")}.` });
  }));
}
