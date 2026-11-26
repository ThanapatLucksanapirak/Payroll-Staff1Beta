// Outgoing email (optional). Owners and administrators enter an SMTP server in
// Settings → Email; the app then emails people when something needs them (for
// now: accountants when a payroll is published, see server/publish.ts).
//
// - The settings live in app settings under "email:config". The password is
//   never sent back to the browser, never written to the activity log or the
//   console, and left out of downloaded backups without secrets and of offsite
//   copies (see isSecretSetting in offsite.ts and the backup route).
// - Nothing depends on email: when it is off or failing, every feature works the
//   same and the failure is only reported (status + activity log).
import type { Express, NextFunction, Request, Response } from "express";
import nodemailer from "nodemailer";
import { z } from "zod";
import { parsePatch } from "@shared/patch";
import { db } from "./db";
import { actorOf, audit } from "./audit";
import { currentUser } from "./auth";
import { notificationEmailSchema } from "./users";
import * as settings from "./settings";

export const EMAIL_CONFIG_KEY = "email:config";
export const EMAIL_STATUS_KEY = "email:status";

export const SECURITY = ["starttls", "ssl", "none"] as const;
export const emailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().max(200).default(""),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  /** starttls: port 587 (most providers). ssl: port 465. none: local relays only. */
  security: z.enum(SECURITY).default("starttls"),
  username: z.string().trim().max(200).default(""),
  password: z.string().max(500).default(""),
  fromAddress: z.string().trim().max(200).default(""),
  fromName: z.string().trim().max(100).default(""),
  /** The address people open the app at, used for links in emails (e.g. https://payroll.example.com). */
  appUrl: z.string().trim().max(300).default(""),
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;

export interface EmailStatus { lastSentAt: string | null; lastFailureAt: string | null; lastError: string | null }
const emptyStatus = (): EmailStatus => ({ lastSentAt: null, lastFailureAt: null, lastError: null });

export async function getEmailConfig(): Promise<EmailConfig> {
  const raw = await (await db()).getSetting(EMAIL_CONFIG_KEY).catch(() => null);
  if (!raw) return emailConfigSchema.parse({});
  try {
    const r = emailConfigSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : emailConfigSchema.parse({});
  } catch { return emailConfigSchema.parse({}); }
}

async function saveEmailConfig(cfg: EmailConfig) {
  await (await db()).setSetting(EMAIL_CONFIG_KEY, JSON.stringify(emailConfigSchema.parse(cfg)));
}

export async function getEmailStatus(): Promise<EmailStatus> {
  const raw = await (await db()).getSetting(EMAIL_STATUS_KEY).catch(() => null);
  try { return { ...emptyStatus(), ...(raw ? JSON.parse(raw) : {}) }; } catch { return emptyStatus(); }
}

let statusChain: Promise<unknown> = Promise.resolve();
function recordStatus(ok: boolean, error?: string) {
  const p = statusChain.then(async () => {
    const st = await getEmailStatus();
    const now = new Date().toISOString();
    const next = ok ? { ...st, lastSentAt: now, lastError: null } : { ...st, lastFailureAt: now, lastError: (error ?? "Unknown error").slice(0, 300) };
    await (await db()).setSetting(EMAIL_STATUS_KEY, JSON.stringify(next));
  });
  statusChain = p.catch(() => undefined);
  return p;
}

/** What the browser may see: never the password. */
export function publicEmailConfig(cfg: EmailConfig) {
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: !!password };
}

/** Whether emails will be attempted. */
export const emailReady = (cfg: EmailConfig) => cfg.enabled && !!cfg.host && !!cfg.fromAddress;

/** A message for people, with anything that looks like a credential removed. */
export function cleanError(err: unknown, cfg?: Pick<EmailConfig, "password">): string {
  const e = err as any;
  let msg = String(e?.response || e?.message || e || "Unknown error");
  if (e?.code === "EAUTH") msg = `The email server refused the username or password. ${e?.response ? `(${String(e.response).slice(0, 160)})` : ""}`.trim();
  else if (e?.code === "ESOCKET" && /wrong version number|ssl3_get_record|packet length too long/i.test(msg)) msg = "Security setting doesn't match the port. Use STARTTLS with port 587, or SSL with port 465.";
  // Connection problems get one message, so the test can't be used to map which hosts and ports exist.
  else if (["ECONNREFUSED", "ETIMEDOUT", "ETIMEOUT", "EDNS", "ENOTFOUND", "ECONNECTION", "ESOCKET", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(e?.code) || /timeout|connect|getaddrinfo/i.test(msg)) {
    msg = "Could not reach the email server. Check the server name, port and security setting.";
  }
  if (cfg?.password && cfg.password.length >= 4) msg = msg.split(cfg.password).join("••••");
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

function check(cfg: EmailConfig) {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!cfg.host) throw bad("Enter the email server (SMTP host).");
  if (!cfg.fromAddress || !notificationEmailSchema.safeParse(cfg.fromAddress).success) throw bad("Enter a valid \"from\" email address.");
  if (cfg.appUrl && !/^https?:\/\/[^\s/]+/i.test(cfg.appUrl)) throw bad("The app address should start with https://");
}

function transportFor(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === "ssl",
    requireTLS: cfg.security === "starttls",
    ignoreTLS: cfg.security === "none",
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });
}

export interface OutgoingEmail { to: string[]; subject: string; text: string; html?: string }

/** Test seam: replaces the SMTP transport (tests only). */
let sendOverride: ((cfg: EmailConfig, msg: OutgoingEmail) => Promise<void>) | null = null;
export function setEmailSenderForTests(fn: typeof sendOverride) { sendOverride = fn; }

/** Send one email with the given settings. Throws a cleaned-up error. */
async function deliver(cfg: EmailConfig, msg: OutgoingEmail) {
  if (sendOverride) return sendOverride(cfg, msg);
  const transport = transportFor(cfg);
  try {
    await transport.sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
  } finally {
    transport.close();
  }
}

export type SendResult = { ok: true; sent: number } | { ok: false; skipped: true; reason: string } | { ok: false; skipped?: false; error: string };

/**
 * Send with the saved settings. Never throws: when email is off it reports
 * "skipped", and failures are returned (and remembered for Settings → Email).
 */
export async function sendEmail(msg: OutgoingEmail): Promise<SendResult> {
  let cfg: EmailConfig;
  try { cfg = await getEmailConfig(); } catch { return { ok: false, skipped: true, reason: "Email settings could not be read." }; }
  if (!emailReady(cfg)) return { ok: false, skipped: true, reason: "Email is not set up." };
  const to = [...new Set(msg.to.map((t) => t.trim()).filter(Boolean))];
  if (!to.length) return { ok: false, skipped: true, reason: "Nobody to email." };
  try {
    await deliver(cfg, { ...msg, to });
    await recordStatus(true).catch(() => undefined);
    return { ok: true, sent: to.length };
  } catch (err) {
    const error = cleanError(err, cfg);
    console.error(`[email] could not send "${msg.subject}": ${error}`);
    await recordStatus(false, error).catch(() => undefined);
    return { ok: false, error };
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A simple, readable HTML email: a heading, lines of text and an optional button. */
export function simpleHtml(opts: { appName: string; heading: string; lines: string[]; button?: { label: string; url: string } }) {
  const p = (t: string) => `<p style="margin:0 0 12px;font-size:15px;line-height:22px;color:#1d1d1f">${escapeHtml(t)}</p>`;
  const button = opts.button
    ? `<p style="margin:20px 0"><a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600;font-size:15px">${escapeHtml(opts.button.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
<p style="margin:0 0 6px;font-size:13px;color:#86868b">${escapeHtml(opts.appName)}</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:26px;color:#1d1d1f">${escapeHtml(opts.heading)}</h1>
${opts.lines.map(p).join("\n")}${button}
</div></body></html>`;
}

// ── Routes (owner / admin: no POLICY rule, so the default applies) ───────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const inputSchema = z.unknown().transform((v) => parsePatch(emailConfigSchema, v ?? {}));

/** Where the saved password would be sent. Changing any of these needs the password typed again. */
const destination = (c: Pick<EmailConfig, "host" | "port" | "security" | "username">) => [c.host.trim().toLowerCase(), c.port, c.security, c.username.trim().toLowerCase()].join("|");
export const PASSWORD_AGAIN = "Enter the password again: the server, port, security or username changed, and the saved password is only ever sent to the server it was entered for.";

/**
 * Merge a change onto the saved settings. A blank password keeps the saved one
 * (unless `clearPassword`), but only while the server details are unchanged:
 * otherwise the saved password could be sent to a server someone else controls.
 */
function merge(cur: EmailConfig, input: Partial<EmailConfig>, clearPassword = false): EmailConfig {
  const next = { ...cur, ...input };
  if (!input.password) {
    if (clearPassword) next.password = "";
    else if (cur.password && destination(next) !== destination(cur)) throw Object.assign(new Error(PASSWORD_AGAIN), { status: 400 });
    else next.password = cur.password;
  }
  return emailConfigSchema.parse(next);
}

// Test emails: a few per person every 10 minutes.
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 10 * 60_000;
const testLog = new Map<string, number[]>();
function testAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (testLog.get(userId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) { testLog.set(userId, recent); return false; }
  recent.push(now);
  testLog.set(userId, recent);
  return true;
}
/** Tests only. */
export function resetTestEmailLimit() { testLog.clear(); }

export function registerEmailRoutes(app: Express) {
  app.get("/api/email", h(async (_req, res) => {
    const [cfg, status] = await Promise.all([getEmailConfig(), getEmailStatus()]);
    res.json({ config: publicEmailConfig(cfg), status, ready: emailReady(cfg) });
  }));

  app.put("/api/email", h(async (req, res) => {
    const body = req.body ?? {};
    const input = inputSchema.parse(body.config ?? body);
    const before = await getEmailConfig();
    const next = merge(before, input, body.clearPassword === true);
    if (next.enabled) check(next);
    await saveEmailConfig(next);
    const parts = [next.enabled ? `on (${next.host}:${next.port}, ${next.security}, from ${next.fromAddress})` : "off"];
    if (input.password) parts.push("new password");
    else if (body.clearPassword === true && before.password) parts.push("password removed");
    audit({ ...actorOf(req, res), action: "settings.email", target: "email", detail: parts.join("; ") });
    res.json({ config: publicEmailConfig(next), status: await getEmailStatus(), ready: emailReady(next) });
  }));

  /** Send a test email with the settings on screen (saved settings fill the gaps). */
  app.post("/api/email/test", h(async (req, res) => {
    const body = req.body ?? {};
    const user = currentUser(res)!;
    const cfg = merge(await getEmailConfig(), inputSchema.parse(body.config ?? {}));
    if (!testAllowed(user.id)) return res.status(429).json({ error: "That's a lot of test emails. Wait a few minutes and try again." });
    const to = notificationEmailSchema.parse(typeof body.to === "string" && body.to.trim() ? body.to : user.notificationEmail ?? "");
    if (!to) return res.status(400).json({ error: "Enter the address to send the test to." });
    try { check(cfg); } catch (err: any) { return res.json({ ok: false, message: err.message }); }
    const appName = (await settings.getPrefs().catch(() => null))?.appName || "Payroll";
    try {
      await deliver(cfg, {
        to: [to],
        subject: "Test email from your payroll app",
        text: `This is a test from your payroll app. If you can read this, email notifications are working.\n\nSent by ${user.displayName || user.username}.`,
        html: simpleHtml({ appName, heading: "Email is working", lines: ["This is a test from your payroll app. If you can read this, email notifications are working.", `Sent by ${user.displayName || user.username}.`] }),
      });
      await recordStatus(true).catch(() => undefined);
      audit({ ...actorOf(req, res), action: "email.test", target: "email", detail: `sent to ${to}` });
      res.json({ ok: true, message: `Sent a test email to ${to}. Check the inbox (and the spam folder).` });
    } catch (err) {
      const message = cleanError(err, cfg);
      await recordStatus(false, message).catch(() => undefined);
      audit({ ...actorOf(req, res), action: "email.test", target: "email", detail: `failed: ${message}` });
      res.json({ ok: false, message });
    }
  }));
}
