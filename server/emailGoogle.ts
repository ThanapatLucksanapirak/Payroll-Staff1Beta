// "Connect with Google" for Settings → Email: send through Gmail after the
// owner signs in with Google and presses Allow, instead of making an App
// password.
//
// Google only lets an app ask for Gmail access through an OAuth client that the
// owner creates once in their own Google Cloud project (client ID + secret, and
// this app's callback address as the redirect URI). The flow:
//
//   1. POST /api/email/google/start: owner/admin only. Returns Google's consent
//      URL with a one-time `state` tied to that person (10 minutes).
//   2. Google sends the browser back to GET /api/email/google/callback with a
//      code. It is public (it arrives from Google), so the `state` is what
//      proves the request: it must match one we issued, and is used up.
//   3. We swap the code for a refresh token (server to Google, never through the
//      browser) and save it with the account's address. nodemailer then sends
//      through smtp.gmail.com with short-lived access tokens.
//
// The client secret and refresh token are secrets like the SMTP password: never
// sent to the browser, logged, or included in backups without secrets.
import type { Express, NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { actorOf, audit } from "./audit";
import { currentUser } from "./auth";
import { type EmailConfig, brandName, getEmailConfig, recordTidyStatus, saveEmailConfig } from "./email";
import { getUser } from "./users";

export const GOOGLE_CALLBACK_PATH = "/api/email/google/callback";
/** The scope Gmail's SMTP server needs (sending only uses it to send). */
export const GMAIL_SCOPE = "https://mail.google.com/";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const STATE_MS = 10 * 60_000;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let fetcher: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
/** Tests only: stand-in for Google's token endpoint. */
export function setGoogleFetchForTests(fn: Fetch | null) { fetcher = fn ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })); }

const pendingStates = new Map<string, { userId: string; exp: number; redirectUri: string; clientId: string }>();

/** Where Google sends people back: the app address saved in Settings → Email. */
export const googleRedirectUri = (appUrl: string) => appUrl ? `${appUrl.trim().replace(/\/+$/, "")}${GOOGLE_CALLBACK_PATH}` : "";

/** Read the account address from the ID token Google returned with the tokens. */
function accountFromIdToken(idToken: unknown): { email: string; verified: boolean } | null {
  if (typeof idToken !== "string") return null;
  try {
    // Received straight from Google's token endpoint over TLS, so its claims can be read without re-checking the signature.
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload?.email !== "string") return null;
    return { email: payload.email, verified: payload.email_verified === true || payload.email_verified === "true" };
  } catch { return null; }
}

/** Back to Settings → Email, with the outcome in the query string (the app reads it once and removes it). */
function backToSettings(res: Response, appUrl: string, outcome: string) {
  const base = appUrl.trim().replace(/\/+$/, "");
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, `${base || ""}/?google=${encodeURIComponent(outcome)}#/settings/email`);
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function registerGoogleEmailRoutes(app: Express) {
  app.post("/api/email/google/start", h(async (req, res) => {
    const user = currentUser(res)!;
    const cfg = await getEmailConfig();
    if (!cfg.googleClientId || !cfg.googleClientSecret) return res.status(400).json({ error: "Save the Google client ID and client secret first." });
    if (!/^https?:\/\/[^\s/]+/i.test(cfg.appUrl)) return res.status(400).json({ error: "Save the app address first (for example https://payroll.yourcompany.com)." });
    const now = Date.now();
    for (const [k, v] of pendingStates) if (v.exp < now) pendingStates.delete(k);
    if (pendingStates.size > 1000) pendingStates.clear();
    const state = randomBytes(32).toString("base64url");
    const redirectUri = googleRedirectUri(cfg.appUrl);
    pendingStates.set(state, { userId: user.id, exp: now + STATE_MS, redirectUri, clientId: cfg.googleClientId });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `${GMAIL_SCOPE} openid email`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    }).toString();
    res.json({ url: url.toString(), redirectUri });
  }));

  app.get(GOOGLE_CALLBACK_PATH, h(async (req, res) => {
    const cfg = await getEmailConfig();
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const pending = state ? pendingStates.get(state) : undefined;
    if (state) pendingStates.delete(state);
    if (!pending || pending.exp < Date.now()) return backToSettings(res, cfg.appUrl, "expired");
    if (typeof req.query.error === "string") return backToSettings(res, cfg.appUrl, req.query.error === "access_denied" ? "denied" : "failed");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code || code.length > 2000) return backToSettings(res, cfg.appUrl, "failed");
    if (pending.clientId !== cfg.googleClientId || !cfg.googleClientSecret) return backToSettings(res, cfg.appUrl, "changed");

    let tokens: any;
    try {
      const r = await fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: pending.redirectUri, grant_type: "authorization_code" }).toString(),
      });
      tokens = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error(`[email] Google sign-in failed: ${String(tokens?.error ?? r.status).slice(0, 80)}`);
        return backToSettings(res, cfg.appUrl, tokens?.error === "invalid_client" ? "client" : "failed");
      }
    } catch {
      console.error("[email] Google sign-in failed: could not reach Google");
      return backToSettings(res, cfg.appUrl, "failed");
    }
    const scopes = String(tokens?.scope ?? "").split(/\s+/);
    if (!scopes.includes(GMAIL_SCOPE)) return backToSettings(res, cfg.appUrl, "scope");
    const account = accountFromIdToken(tokens?.id_token);
    if (!account?.verified) return backToSettings(res, cfg.appUrl, "failed");
    if (typeof tokens?.refresh_token !== "string" || !tokens.refresh_token) return backToSettings(res, cfg.appUrl, "refresh");

    // Save onto the latest settings (they may have changed while the person was at Google).
    const latest = await getEmailConfig();
    if (latest.googleClientId !== pending.clientId) return backToSettings(res, latest.appUrl, "changed");
    await saveEmailConfig({ ...latest, provider: "google", googleRefreshToken: tokens.refresh_token, googleAccount: account.email });
    const who = await getUser(pending.userId).catch(() => null);
    audit({ ...actorOf(req, res, who), action: "settings.email", target: "email", detail: `connected Google account ${account.email}` });
    backToSettings(res, latest.appUrl, "connected");
  }));

  app.post("/api/email/google/disconnect", h(async (req, res) => {
    const cfg = await getEmailConfig();
    const token = cfg.googleRefreshToken;
    await saveEmailConfig({ ...cfg, googleRefreshToken: "", googleAccount: "" });
    // Best effort: also cancel the access at Google.
    if (token) {
      void fetcher(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => undefined);
    }
    audit({ ...actorOf(req, res), action: "settings.email", target: "email", detail: `disconnected Google account${cfg.googleAccount ? ` ${cfg.googleAccount}` : ""}` });
    res.json({ ok: true });
  }));
}

// ── Tidy sent mail (Gmail) ───────────────────────────────────────────────────
// Gmail keeps a copy of every email the app sends in Sent, and in the inbox too
// when someone emails themselves (a test email, a sign-in code). After each
// send we put those copies under a label named after the sender ("Shijiri
// Payroll Service") and take them out of the inbox, marked read. Needs the
// Gmail API turned on in the same Google Cloud project; when it isn't, sending
// still works and Settings → Email says how to turn it on. Never throws.
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
let tidyDelayMs = 2_000;
/** Tests only. */
export function setTidyDelayForTests(ms: number) { tidyDelayMs = ms; }

async function accessToken(cfg: EmailConfig): Promise<string> {
  const r = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, refresh_token: cfg.googleRefreshToken, grant_type: "refresh_token" }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j?.access_token !== "string") throw new Error("Google didn't give an access token. Connect your Google account again.");
  return j.access_token;
}

const gmailError = (status: number, j: any) => {
  const reason = String(j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? "");
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + JSON.stringify(j?.error?.details ?? ""))) return "Turn on the Gmail API in your Google Cloud project (APIs & Services → Library → Gmail API → Enable) so the app can tidy its sent emails.";
  return `Gmail said ${status}${reason ? ` (${reason.slice(0, 60)})` : ""}.`;
};

export async function tidySentGmail(cfg: EmailConfig, messageId: string): Promise<{ ok: boolean; tidied: number; error?: string }> {
  try {
    const token = await accessToken(cfg);
    const auth = { Authorization: `Bearer ${token}` };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetcher(`${GMAIL_API}${path}`, { method, headers: body ? { ...auth, "Content-Type": "application/json" } : auth, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(gmailError(r.status, j));
      return j;
    };
    const id = messageId.replace(/^<|>$/g, "");
    // Gmail can take a moment to file a message it just accepted.
    let ids: string[] = [];
    for (let attempt = 0; attempt < 4 && !ids.length; attempt++) {
      if (attempt || tidyDelayMs) await new Promise((r) => setTimeout(r, tidyDelayMs * (attempt + 1)));
      const found = await call("GET", `/messages?q=${encodeURIComponent(`rfc822msgid:${id}`)}&maxResults=10`);
      ids = (found?.messages ?? []).map((m: any) => String(m.id)).filter(Boolean);
    }
    if (!ids.length) { await recordTidyStatus(null); return { ok: true, tidied: 0 }; }
    const name = (await brandName(cfg)).replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 60) || "Payroll app";
    const labels = await call("GET", "/labels");
    let label = (labels?.labels ?? []).find((l: any) => String(l.name).toLowerCase() === name.toLowerCase());
    if (!label) label = await call("POST", "/labels", { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
    await call("POST", "/messages/batchModify", { ids, addLabelIds: [label.id], removeLabelIds: ["INBOX", "UNREAD"] });
    await recordTidyStatus(null);
    return { ok: true, tidied: ids.length };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 300);
    console.error(`[email] could not tidy sent Gmail: ${error}`);
    await recordTidyStatus(error).catch(() => undefined);
    return { ok: false, tidied: 0, error };
  }
}
