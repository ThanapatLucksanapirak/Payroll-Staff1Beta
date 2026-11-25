// Pieces of two-factor sign-in shared by the sign-in page and Account settings.
import { useMemo, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { encodeQr, qrSvgPath } from "@shared/qr";
import { downloadBlob } from "@/lib/doc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A QR code drawn as SVG (black on white, so phones can always scan it). */
export function QrCode({ text, className = "h-44 w-44" }: { text: string; className?: string }) {
  const qr = useMemo(() => { try { return encodeQr(text); } catch { return null; } }, [text]);
  if (!qr) return null;
  const n = qr.size + 8;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className={className} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrSvgPath(qr)} fill="#000" />
    </svg>
  );
}

const groups = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/** Scan the QR code (or type the key), then enter the first code. */
export function EnrollStep({ secret, otpauthUrl, busy, error, onSubmit, submitLabel = "Turn on" }: {
  secret: string; otpauthUrl: string; busy: boolean; error?: string; onSubmit: (code: string) => void; submitLabel?: string;
}) {
  const [code, setCode] = useState("");
  const [showKey, setShowKey] = useState(false);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onSubmit(code.trim()); }}>
      <ol className="space-y-1 text-[13px] text-muted-foreground">
        <li>1. Open an authenticator app on your phone (Apple Passwords, Google Authenticator, 1Password, Authy…).</li>
        <li>2. Scan this code.</li>
        <li>3. Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex justify-center rounded-xl border border-border/80 bg-white p-3"><QrCode text={otpauthUrl} /></div>
      <div className="text-center">
        {showKey ? (
          <p className="select-all break-all font-mono text-[13px] tracking-wider" data-testid="text-2fa-secret">{groups(secret)}</p>
        ) : (
          <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => setShowKey(true)}>Can't scan? Enter a key instead</button>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="enroll-code">Code from the app</Label>
        <Input id="enroll-code" className="h-10 text-center font-mono text-lg tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))} placeholder="123456" data-testid="input-2fa-enroll-code" />
      </div>
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy || code.length < 6} data-testid="button-2fa-enroll">{busy && <Loader2 className="animate-spin" />}{submitLabel}</Button>
    </form>
  );
}

/** Show new recovery codes once, with copy and download. */
export function RecoveryCodes({ codes, appName }: { codes: string[]; appName: string }) {
  const [copied, setCopied] = useState(false);
  const text = `${appName} recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">If you lose your phone, sign in with one of these instead of a code. Each works once. Save them somewhere safe — they won't be shown again.</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-border/80 bg-muted/40 px-4 py-3 font-mono text-[14px] tracking-wider" data-testid="list-recovery-codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* not allowed */ } }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => downloadBlob(text, "recovery-codes.txt", "text/plain")}><Download />Download</Button>
      </div>
    </div>
  );
}
