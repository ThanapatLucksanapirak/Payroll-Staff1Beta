import type { NextFunction, Request, Response } from "express";

/**
 * Conservative security headers. The content policy only allows the app's own
 * scripts; inline styles are allowed because the UI components position
 * popovers with style attributes.
 */
export function securityHeaders(production: boolean) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  // The kiosk's face check runs WebAssembly, which needs 'wasm-unsafe-eval'
  // (it allows compiling wasm only, not JavaScript eval). Only on the kiosk page.
  const kioskCsp = csp.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    // The kiosk page may use the front camera (photo on punch); nothing else may.
    const kioskPage = req.path === "/kiosk" || req.path === "/kiosk/" || req.path === "/kiosk.html";
    res.setHeader("Permissions-Policy", `camera=${kioskPage ? "(self)" : "()"}, microphone=(), geolocation=(), payment=()`);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // Vite's dev server injects inline scripts, so the policy is production-only.
    if (production) res.setHeader("Content-Security-Policy", kioskPage ? kioskCsp : csp);
    next();
  };
}
