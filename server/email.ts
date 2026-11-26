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
/** smtp: a server, username and password. google: send through Gmail after signing in with Google (no password). */
export const PROVIDERS = ["smtp", "google"] as const;
/** Who emails come from unless changed in Settings → Email. */
export const DEFAULT_FROM_ADDRESS = "contact@shijiri.com";
export const DEFAULT_FROM_NAME = "Shijiri Payroll Service";
export const emailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(PROVIDERS).default("smtp"),
  host: z.string().trim().max(200).default(""),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  /** starttls: port 587 (most providers). ssl: port 465. none: local relays only. */
  security: z.enum(SECURITY).default("starttls"),
  username: z.string().trim().max(200).default(""),
  password: z.string().max(500).default(""),
  fromAddress: z.string().trim().max(200).default(DEFAULT_FROM_ADDRESS),
  fromName: z.string().trim().max(100).default(DEFAULT_FROM_NAME),
  /** The address people open the app at, used for links in emails (e.g. https://payroll.example.com). */
  appUrl: z.string().trim().max(300).default(""),
  /** "Sign in with Google": the OAuth client from the owner's Google Cloud project. */
  googleClientId: z.string().trim().max(300).default(""),
  googleClientSecret: z.string().max(300).default(""),
  /** Set only by the Google sign-in callback (never from the browser). */
  googleRefreshToken: z.string().max(2000).default(""),
  googleAccount: z.string().trim().max(200).default(""),
  /** Replies go to no-reply@<from domain> (they bounce) and emails say the mailbox isn't read. */
  blockReplies: z.boolean().default(true),
  /** Gmail (Connect with Google): label the app's emails and keep copies out of the inbox. */
  tidySent: z.boolean().default(true),
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;

export interface EmailStatus { lastSentAt: string | null; lastFailureAt: string | null; lastError: string | null; tidyError?: string | null }
const emptyStatus = (): EmailStatus => ({ lastSentAt: null, lastFailureAt: null, lastError: null, tidyError: null });

export async function getEmailConfig(): Promise<EmailConfig> {
  const raw = await (await db()).getSetting(EMAIL_CONFIG_KEY).catch(() => null);
  if (!raw) return emailConfigSchema.parse({});
  try {
    const r = emailConfigSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : emailConfigSchema.parse({});
  } catch { return emailConfigSchema.parse({}); }
}

export async function saveEmailConfig(cfg: EmailConfig) {
  await (await db()).setSetting(EMAIL_CONFIG_KEY, JSON.stringify(emailConfigSchema.parse(cfg)));
}

export async function getEmailStatus(): Promise<EmailStatus> {
  const raw = await (await db()).getSetting(EMAIL_STATUS_KEY).catch(() => null);
  try { return { ...emptyStatus(), ...(raw ? JSON.parse(raw) : {}) }; } catch { return emptyStatus(); }
}

let statusChain: Promise<unknown> = Promise.resolve();
/** Remember whether tidying sent Gmail worked (shown in Settings → Email). */
export function recordTidyStatus(error: string | null) {
  const p = statusChain.then(async () => {
    const st = await getEmailStatus();
    if ((st.tidyError ?? null) === error) return;
    await (await db()).setSetting(EMAIL_STATUS_KEY, JSON.stringify({ ...st, tidyError: error }));
  });
  statusChain = p.catch(() => undefined);
  return p;
}

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
  const { password, googleClientSecret, googleRefreshToken, ...rest } = cfg;
  return { ...rest, hasPassword: !!password, hasGoogleSecret: !!googleClientSecret, googleConnected: !!(googleRefreshToken && cfg.googleAccount) };
}

export const GMAIL_HOST = "smtp.gmail.com";
/** Signed in with Google and ready to send through Gmail. */
export const googleReady = (cfg: EmailConfig) => !!(cfg.googleClientId && cfg.googleClientSecret && cfg.googleRefreshToken && cfg.googleAccount);

/** Whether emails will be attempted. */
export const emailReady = (cfg: EmailConfig) => cfg.enabled && !!cfg.fromAddress && (cfg.provider === "google" ? googleReady(cfg) : !!cfg.host);

/** A message for people, with anything that looks like a credential removed. */
export function cleanError(err: unknown, cfg?: Partial<Pick<EmailConfig, "password" | "googleClientSecret" | "googleRefreshToken" | "provider">>): string {
  const e = err as any;
  let msg = String(e?.response || e?.message || e || "Unknown error");
  if (e?.code === "EAUTH" && cfg?.provider === "google") msg = "Google refused to send. Connect your Google account again in Settings → Email.";
  else if (e?.code === "EAUTH") msg = `The email server refused the username or password. ${e?.response ? `(${String(e.response).slice(0, 160)})` : ""}`.trim();
  else if (e?.code === "ESOCKET" && /wrong version number|ssl3_get_record|packet length too long/i.test(msg)) msg = "Security setting doesn't match the port. Use STARTTLS with port 587, or SSL with port 465.";
  // Connection problems get one message, so the test can't be used to map which hosts and ports exist.
  else if (["ECONNREFUSED", "ETIMEDOUT", "ETIMEOUT", "EDNS", "ENOTFOUND", "ECONNECTION", "ESOCKET", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(e?.code) || /timeout|connect|getaddrinfo/i.test(msg)) {
    msg = "Could not reach the email server. Check the server name, port and security setting.";
  }
  for (const secret of [cfg?.password, cfg?.googleClientSecret, cfg?.googleRefreshToken]) {
    if (secret && secret.length >= 4) msg = msg.split(secret).join("••••");
  }
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Settings that can't work. `sending`: also needs a connected Google account. */
function check(cfg: EmailConfig, sending = false) {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (cfg.provider === "google") {
    if (!cfg.googleClientId || !cfg.googleClientSecret) throw bad("Enter the Google client ID and client secret.");
    if (sending && !googleReady(cfg)) throw bad("Connect your Google account first (the \"Connect with Google\" button).");
  } else if (!cfg.host) throw bad("Enter the email server (SMTP host).");
  if (!cfg.fromAddress || !notificationEmailSchema.safeParse(cfg.fromAddress).success) throw bad("Enter a valid \"from\" email address.");
  if (cfg.appUrl && !/^https?:\/\/[^\s/]+/i.test(cfg.appUrl)) throw bad("The app address should start with https://");
}

function transportFor(cfg: EmailConfig) {
  if (cfg.provider === "google") {
    return nodemailer.createTransport({
      host: GMAIL_HOST,
      port: 465,
      secure: true,
      // nodemailer swaps the refresh token for a short-lived access token as needed.
      auth: { type: "OAuth2", user: cfg.googleAccount, clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, refreshToken: cfg.googleRefreshToken },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      debug: false,
    });
  }
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

export interface EmailAttachment { filename: string; content: Buffer; contentType: string }
export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Where replies should go (a person). Without it, replies are blocked when blockReplies is on. */
  replyTo?: string;
}

/** The address replies go to when they're blocked: no-reply at the sender's domain. */
export const noReplyAddress = (cfg: Pick<EmailConfig, "fromAddress">) => `no-reply@${cfg.fromAddress.split("@")[1] || "invalid"}`;
export const NO_REPLY_NOTE = "This mailbox isn't monitored, so please don't reply to this email.";
/** Where brandedHtml leaves room for the no-reply note. */
const NOTE_SLOT = "<!--email-note-->";

/** Reply-To, headers and the no-reply note for one message. */
export function replyPolicy(cfg: Pick<EmailConfig, "fromAddress" | "blockReplies">, msg: Pick<OutgoingEmail, "replyTo" | "text" | "html">) {
  const block = cfg.blockReplies && !msg.replyTo;
  const note = block ? NO_REPLY_NOTE : "";
  return {
    replyTo: msg.replyTo || (block ? noReplyAddress(cfg) : undefined),
    // Ask mail servers not to send out-of-office or other automatic replies.
    headers: { "Auto-Submitted": msg.replyTo ? "no" : "auto-generated", "X-Auto-Response-Suppress": "All", ...(block ? { Precedence: "bulk" } : {}) },
    text: note ? `${msg.text}\n\n${note}` : msg.text,
    html: msg.html?.replace(NOTE_SLOT, note ? `<br><br>${escapeHtml(note)}` : ""),
  };
}

/** Test seam: replaces the SMTP transport (tests only). */
let sendOverride: ((cfg: EmailConfig, msg: OutgoingEmail) => Promise<void>) | null = null;
export function setEmailSenderForTests(fn: typeof sendOverride) { sendOverride = fn; }

/** Send one email with the given settings. Throws a cleaned-up error. */
async function deliver(cfg: EmailConfig, msg: OutgoingEmail) {
  const policy = replyPolicy(cfg, msg);
  if (sendOverride) return sendOverride(cfg, { ...msg, text: policy.text, html: policy.html, replyTo: policy.replyTo });
  const transport = transportFor(cfg);
  let messageId = "";
  try {
    const info = await transport.sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
      to: msg.to,
      ...(msg.cc?.length ? { cc: msg.cc } : {}),
      ...(policy.replyTo ? { replyTo: policy.replyTo } : {}),
      headers: policy.headers,
      subject: msg.subject,
      text: policy.text,
      ...(policy.html ? { html: policy.html } : {}),
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    });
    messageId = String(info?.messageId ?? "");
  } finally {
    transport.close();
  }
  // Gmail keeps a copy of everything sent (and in the inbox when you email yourself): label it and archive it, in the background.
  if (messageId && cfg.provider === "google" && cfg.tidySent) {
    void import("./emailGoogle").then((g) => g.tidySentGmail(cfg, messageId)).catch(() => undefined);
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
    // Never log the subject: sign-in code emails carry the code in it.
    console.error(`[email] could not send an email to ${to.length} recipient${to.length === 1 ? "" : "s"}: ${error}`);
    await recordStatus(false, error).catch(() => undefined);
    return { ok: false, error };
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The sender name shown in emails (Settings → Email "From name", else the app name). */
export async function brandName(cfg?: EmailConfig): Promise<string> {
  const c = cfg ?? (await getEmailConfig().catch(() => null));
  if (c?.fromName) return c.fromName;
  try { return (await settings.getPrefs()).appName || DEFAULT_FROM_NAME; } catch { return DEFAULT_FROM_NAME; }
}

export interface BrandedEmail {
  brand: string;
  /** Hidden preview line shown by mail apps next to the subject. */
  preheader?: string;
  heading: string;
  paragraphs: string[];
  /** A big one-time code (sign-in emails). */
  code?: string;
  /** Label / value rows in a light panel. */
  details?: [string, string][];
  button?: { label: string; url: string };
  /** Small print at the bottom. */
  footer?: string;
}

/**
 * A clean, branded HTML email (white card on a light grey page, brand mark,
 * big heading). Table-based with inline styles so it looks the same in Gmail,
 * Outlook and Apple Mail. Everything passed in is escaped.
 */
export function brandedHtml(e: BrandedEmail): string {
  const x = escapeHtml;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const initial = x((e.brand.trim()[0] || "P").toUpperCase());
  const para = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:23px;color:#3a3a3c">${x(t)}</p>`;
  const code = e.code
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px"><tr><td align="center" style="background:#f2f6ff;border:1px solid #dbe6ff;border-radius:14px;padding:18px 12px">
<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:34px;line-height:40px;letter-spacing:10px;font-weight:700;color:#0a2a66">${x(e.code)}</div></td></tr></table>`
    : "";
  const details = e.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;background:#f7f7f9;border-radius:12px">${e.details.map(([k, v], i) =>
      `<tr><td style="padding:11px 16px;font-size:13px;color:#86868b;${i ? "border-top:1px solid #ececf0;" : ""}">${x(k)}</td><td align="right" style="padding:11px 16px;font-size:14px;font-weight:600;color:#1d1d1f;${i ? "border-top:1px solid #ececf0;" : ""}">${x(v)}</td></tr>`).join("")}</table>`
    : "";
  const button = e.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 8px"><tr><td style="border-radius:12px;background:#0a84ff"><a href="${x(e.button.url)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">${x(e.button.label)}</a></td></tr></table>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${x(e.heading)}</title></head>
<body style="margin:0;padding:0;background:#f2f2f7;font-family:${font}">
${e.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${x(e.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 4px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#3a8dff,#0a5bd8);background-color:#0a84ff;color:#ffffff;font-size:18px;font-weight:700;text-align:center;vertical-align:middle">${initial}</td>
<td style="padding-left:10px;font-size:15px;font-weight:600;color:#1d1d1f">${x(e.brand)}</td></tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:18px;padding:32px 28px;border:1px solid #e5e5ea">
<h1 style="margin:0 0 14px;font-size:22px;line-height:28px;font-weight:700;color:#1d1d1f">${x(e.heading)}</h1>
${e.paragraphs.map(para).join("\n")}${code}${details}${button}
</td></tr>
<tr><td style="padding:18px 8px 0;font-size:12px;line-height:18px;color:#8e8e93;text-align:center">${x(e.footer ?? `Sent by ${e.brand}.`)}${NOTE_SLOT}</td></tr>
</table></td></tr></table></body></html>`;
}

// ── Routes (owner / admin: no POLICY rule, so the default applies) ───────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

// The Google connection itself (token and account) is only ever set by the sign-in callback.
const inputSchema = z.unknown().transform((v) => {
  const { googleRefreshToken: _t, googleAccount: _a, ...rest } = parsePatch(emailConfigSchema, v ?? {});
  return rest;
});

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
  // The Google secret and connection belong to one OAuth client: a new client ID starts over.
  const sameClient = next.googleClientId === cur.googleClientId;
  if (!input.googleClientSecret) next.googleClientSecret = sameClient ? cur.googleClientSecret : "";
  if (!sameClient) { next.googleRefreshToken = ""; next.googleAccount = ""; }
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
    const parts = [!next.enabled ? "off" : next.provider === "google" ? `on (Google: ${next.googleAccount || "not connected"}, from ${next.fromAddress})` : `on (${next.host}:${next.port}, ${next.security}, from ${next.fromAddress})`];
    if (input.password) parts.push("new password");
    if (input.googleClientSecret) parts.push("new Google client secret");
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
    try { check(cfg, true); } catch (err: any) { return res.json({ ok: false, message: err.message }); }
    const brand = await brandName(cfg);
    try {
      await deliver(cfg, {
        to: [to],
        subject: `Test email from ${brand}`,
        text: `Email is working.\n\nThis is a test from ${brand}. If you can read this, payroll notifications and sign-in codes will arrive here.\n\nSent by ${user.displayName || user.username}.`,
        html: brandedHtml({
          brand, preheader: "If you can read this, email is set up.", heading: "Email is working",
          paragraphs: [`This is a test from ${brand}. If you can read this, payroll notifications and sign-in codes will arrive here.`],
          details: [["Sent by", user.displayName || user.username], ["Sent through", cfg.provider === "google" ? `Gmail (${cfg.googleAccount})` : `${cfg.host}:${cfg.port}`]],
          footer: `You got this because someone pressed "Send test email" in ${brand}.`,
        }),
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
