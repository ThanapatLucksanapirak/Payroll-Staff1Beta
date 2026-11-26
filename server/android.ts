// Digital Asset Links for the Android "Time Clock" app (a Trusted Web Activity
// that opens the kiosk page; see android/README.md). Android only hides the
// browser bar when this file lists the app's package name and the SHA-256
// fingerprint of the key that signed it, so both come from the environment:
//
//   ANDROID_APP_PACKAGE=com.shijirigroup.timeclock        (this is the default)
//   ANDROID_CERT_SHA256=AB:CD:...,12:34:...                (comma-separate several)
//
// With Play App Signing, list Google's app-signing key fingerprint (Play
// Console → Test and release → App integrity), and optionally the upload key's
// too so builds you install directly also open full screen.
import type { Express } from "express";

export const DEFAULT_ANDROID_PACKAGE = "com.shijirigroup.timeclock";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Normalises "ab cd…", "abcd…" or "AB:CD:…" to "AB:CD:…"; null if it isn't a SHA-256. */
export function normaliseFingerprint(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 64) return null;
  const out = hex.match(/../g)!.join(":");
  return FINGERPRINT.test(out) ? out : null;
}

export function assetLinks(env: NodeJS.ProcessEnv = process.env) {
  const pkg = (env.ANDROID_APP_PACKAGE ?? "").trim() || DEFAULT_ANDROID_PACKAGE;
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(pkg)) return null;
  const prints = [...new Set((env.ANDROID_CERT_SHA256 ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(normaliseFingerprint).filter((f): f is string => !!f))];
  if (!prints.length) return null;
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
  }];
}

export function registerAndroidRoutes(app: Express) {
  // Read on every request so the fingerprint can be added without a rebuild.
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const body = assetLinks();
    res.setHeader("Cache-Control", "public, max-age=300");
    if (!body) return res.status(404).json({ error: "Android app not configured (set ANDROID_CERT_SHA256)." });
    res.type("application/json").send(JSON.stringify(body, null, 2));
  });
}
