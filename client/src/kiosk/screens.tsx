// Kiosk screens added on top of the PIN / action flow: the full-screen
// confirmation, the wrong-action guard, station pick, shift notes, the break
// reminder and "fix a missed punch" requests. Big targets, high contrast.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Coffee, MessageSquareText, Minus, Plus, Send, WifiOff } from "lucide-react";
import { type PunchType, PUNCH_LABELS, PUNCH_TYPES } from "@shared/punches";
import { FIX_TYPE_LABELS } from "@shared/kiosk";
import { addDays, formatTime, instantToLocal, todayISO } from "@shared/dates";
import { type DayInfo, type KioskNote, serverNow } from "./api";
import { ACTION_STYLE, BigSecondary, duration, firstName, fmt, hourIn, timeOf, useIdle } from "./ui";

// ── Confirmation ─────────────────────────────────────────────────────────────
export interface Confirm {
  type: PunchType;
  name: string;
  at: string;
  tone: "ok" | "queued";
  note?: string;
  /** Today's numbers from the server (absent for punches saved offline). */
  day?: DayInfo;
  station?: string | null;
}

const DONE_LABEL: Record<PunchType, string> = { in: "Clocked in", break_start: "Break started", break_end: "Break ended", out: "Clocked out" };

function greeting(type: PunchType, name: string, tz: string) {
  const first = firstName(name);
  const h = hourIn(tz);
  if (type === "in") return `${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${first}`;
  if (type === "break_start") return `Enjoy your break, ${first}`;
  if (type === "break_end") return `Welcome back, ${first}`;
  return `Thanks, ${first}. See you next time`;
}

function breakLine(day: DayInfo, tz: string): string {
  if (day.status === "break") return `On break since ${day.since ? timeOf(day.since, tz) : "now"}`;
  if ((day.breakMinutes ?? 0) > 0) return `${duration(day.breakMinutes!)} taken today`;
  if ((day.breaks ?? 0) > 0) return "Under a minute today";
  return day.status === "in" ? "No break yet today" : "No break today";
}

/** Big full-screen confirmation after a punch; goes home by itself after a few seconds. */
export function ConfirmScreen({ c, tz, onDone }: { c: Confirm; tz: string; onDone: () => void }) {
  const nudge = !!c.day?.breakDue;
  const ms = c.tone === "queued" || nudge ? 7000 : 5000;
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t); }, [onDone, ms]);
  const style = ACTION_STYLE[c.type];
  const light = c.type === "break_start";
  return (
    <button type="button" className={`kiosk-fade-in flex flex-1 flex-col items-center justify-center px-6 py-8 text-center ${style.panel}`} onClick={onDone} data-testid="kiosk-done">
      <span className={`kiosk-pop flex h-24 w-24 items-center justify-center rounded-full ${light ? "bg-stone-950/10" : "bg-white/20"}`}>
        {c.tone === "queued" ? <WifiOff className="h-12 w-12" /> : <Check className="h-14 w-14" strokeWidth={3} />}
      </span>
      <p className="mt-6 text-2xl font-medium opacity-90">{greeting(c.type, c.name, tz)}</p>
      <h1 className="mt-2 text-5xl font-bold tracking-tight [text-wrap:balance] sm:text-7xl" data-testid="kiosk-confirmation">
        {DONE_LABEL[c.type]} <span className="tabular whitespace-nowrap">{timeOf(c.at, tz)}</span>
      </h1>
      <p className="mt-3 max-w-full text-3xl font-semibold [overflow-wrap:anywhere]" data-testid="kiosk-confirmation-name">{c.name}</p>
      {c.day && (
        <dl className="mt-8 grid w-full max-w-2xl grid-cols-2 gap-3 text-left">
          <div className={`rounded-3xl px-5 py-4 ${light ? "bg-stone-950/10" : "bg-white/15"}`}>
            <dt className="text-lg font-medium opacity-90">Worked today</dt>
            <dd className="tabular text-4xl font-bold" data-testid="kiosk-hours-today">{duration(c.day.todayMinutes)}</dd>
          </div>
          <div className={`rounded-3xl px-5 py-4 ${light ? "bg-stone-950/10" : "bg-white/15"}`}>
            <dt className="text-lg font-medium opacity-90">Break</dt>
            <dd className="text-2xl font-bold leading-tight [text-wrap:balance]" data-testid="kiosk-break-status">{breakLine(c.day, tz)}</dd>
          </div>
        </dl>
      )}
      {c.station && <p className="mt-5 rounded-full bg-white/90 px-5 py-2 text-xl font-semibold text-stone-900">Station: {c.station}</p>}
      {nudge && c.day && <div className="mt-5"><BreakNudge minutes={c.day.minutesWithoutBreak ?? 0} onDark={!light} /></div>}
      {c.note && <p className="mt-5 max-w-xl rounded-2xl bg-white/90 px-5 py-3 text-xl font-medium text-stone-950">{c.note}</p>}
      <span className={`mt-10 h-1.5 w-56 overflow-hidden rounded-full ${light ? "bg-stone-950/15" : "bg-white/25"}`}>
        <span className={`kiosk-countdown block h-full ${light ? "bg-stone-950/60" : "bg-white"}`} style={{ animationDuration: `${ms}ms` }} />
      </span>
      <span className="mt-3 text-lg font-medium opacity-90">Tap anywhere to finish</span>
    </button>
  );
}

/** "Time for a break" reminder for someone who has worked too long without one. */
export function BreakNudge({ minutes, onDark }: { minutes: number; onDark?: boolean }) {
  return (
    <p className={`inline-flex items-center gap-3 rounded-2xl px-5 py-3 text-xl font-semibold ${onDark ? "bg-amber-300 text-stone-950" : "bg-amber-100 text-amber-950 ring-2 ring-amber-400"}`} role="status" data-testid="kiosk-break-due">
      <Coffee className="h-6 w-6 shrink-0" />
      {minutes > 0 ? `${duration(minutes)} without a break. Time for a break.` : "Time for a break."}
    </p>
  );
}

// ── Wrong-action guard ───────────────────────────────────────────────────────
export function GuardScreen({ name, message, question, suggest, also, busy, error, idleMs, onSuggest, onCancel }: {
  name: string; message: string; question: string | null; suggest: PunchType | null; also?: PunchType; busy?: boolean; error?: string; idleMs: number;
  onSuggest: (t: PunchType) => void; onCancel: () => void;
}) {
  useIdle(idleMs, onCancel);
  const st = suggest ? ACTION_STYLE[suggest] : null;
  return (
    <div className="kiosk-guard flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center kiosk-fade-up" data-testid="kiosk-guard">
      <span className="kiosk-guard-icon flex h-20 w-20 items-center justify-center rounded-full bg-amber-100 text-amber-700"><AlertTriangle className="h-10 w-10" /></span>
      <p className="kiosk-guard-name mt-5 max-w-full text-2xl font-medium text-stone-700 [overflow-wrap:anywhere]">{name}</p>
      <h1 className="kiosk-guard-title mt-2 text-4xl font-display font-normal tracking-[-0.01em] text-stone-950 sm:text-5xl" data-testid="kiosk-guard-message">{message}</h1>
      {question && <p className="kiosk-guard-q mt-3 text-3xl font-semibold text-stone-800">{question}</p>}
      <div className="kiosk-guard-actions mt-10 grid w-full max-w-xl gap-4">
        {suggest && st && (
          <button type="button" disabled={busy} onClick={() => onSuggest(suggest)} className={`kiosk-tap kiosk-guard-main flex h-32 items-center justify-center gap-4 rounded-3xl text-3xl font-bold shadow-md transition active:scale-[0.98] disabled:opacity-60 ${st.cls}`} data-testid={`kiosk-suggest-${suggest}`}>
            <st.icon className="h-10 w-10" />{PUNCH_LABELS[suggest]}
          </button>
        )}
        {also && (
          <button type="button" disabled={busy} onClick={() => onSuggest(also)} className="kiosk-tap kiosk-guard-alt flex h-20 items-center justify-center gap-3 rounded-3xl border-2 border-stone-300 bg-white text-2xl font-bold text-stone-900 transition active:scale-[0.98] disabled:opacity-60" data-testid={`kiosk-also-${also}`}>
            {(() => { const I = ACTION_STYLE[also].icon; return <I className="h-8 w-8" />; })()}{PUNCH_LABELS[also]}
          </button>
        )}
        <BigSecondary onClick={onCancel} testid="kiosk-guard-cancel">Cancel</BigSecondary>
      </div>
      <p className={`kiosk-guard-err mt-5 min-h-7 text-xl font-medium ${error ? "text-red-700" : "text-transparent"}`} role="alert">{error || "·"}</p>
    </div>
  );
}

// ── Station pick at clock-in ─────────────────────────────────────────────────
export function StationScreen({ name, stations, idleMs, onPick, onCancel }: { name: string; stations: string[]; idleMs: number; onPick: (s: string | null) => void; onCancel: () => void }) {
  useIdle(idleMs, onCancel);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-6 pb-8 pt-4 text-center kiosk-fade-up" data-testid="kiosk-stations">
      <h1 className="text-4xl font-display font-normal tracking-[-0.01em] text-stone-950 sm:text-5xl">Where are you working, {firstName(name)}?</h1>
      <p className="mt-2 text-xl text-stone-700">Tap your station to clock in</p>
      <div className="mt-8 grid w-full max-w-4xl min-h-0 flex-1 auto-rows-min grid-cols-2 gap-4 overflow-y-auto pb-2 sm:grid-cols-3">
        {stations.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="kiosk-tap flex min-h-28 items-center justify-center rounded-3xl bg-stone-100 px-4 text-2xl font-semibold text-stone-950 ring-2 ring-stone-300 transition active:scale-[0.98] active:bg-stone-200" data-testid={`kiosk-station-${s}`}>
            {s}
          </button>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <BigSecondary onClick={() => onPick(null)} testid="kiosk-station-other">Not listed</BigSecondary>
        <BigSecondary onClick={onCancel}>Cancel</BigSecondary>
      </div>
    </div>
  );
}

// ── Shift notes ──────────────────────────────────────────────────────────────
export function NoteScreen({ note, index, total, tz, idleMs, onOk, onIdle }: { note: KioskNote; index: number; total: number; tz: string; idleMs: number; onOk: () => void; onIdle: () => void }) {
  useIdle(idleMs, onIdle, [note.id]);
  const when = fmt(tz, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(note.createdAt));
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center kiosk-fade-up" data-testid="kiosk-note">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--kiosk-accent-soft)] text-[var(--kiosk-accent-ink)]"><MessageSquareText className="h-10 w-10" /></span>
      <p className="mt-5 text-xl font-medium text-stone-700">Message from your manager{total > 1 ? ` (${index + 1} of ${total})` : ""}</p>
      <div className="mt-5 w-full max-w-2xl rounded-3xl bg-stone-50 px-8 py-7 text-left ring-2 ring-stone-200">
        <p className="whitespace-pre-wrap text-3xl font-semibold leading-snug text-stone-950" data-testid="kiosk-note-text">{note.text}</p>
        <p className="mt-4 text-lg text-stone-600">{note.createdBy ? `${note.createdBy} · ` : ""}{when}</p>
      </div>
      <button type="button" onClick={onOk} className="kiosk-tap kiosk-primary mt-8 flex h-24 w-full max-w-md items-center justify-center gap-3 rounded-3xl text-3xl font-bold shadow-md transition active:scale-[0.98]" data-testid="kiosk-note-ok">
        <Check className="h-9 w-9" /> OK
      </button>
    </div>
  );
}

// ── Fix a missed punch ───────────────────────────────────────────────────────
export interface FixInput { type: PunchType; date: string; minutes: number; note: string }

const DAYS_BACK = 6;

export function FixRequestScreen({ tz, name, online, busy, error, idleMs, onSubmit, onCancel }: {
  tz: string; name: string; online: boolean; busy?: boolean; error?: string; idleMs: number;
  onSubmit: (v: FixInput) => void; onCancel: () => void;
}) {
  // Typing a note takes a while: allow longer than the normal idle timeout.
  useIdle(Math.max(idleMs, 60_000), onCancel);
  const today = todayISO(tz);
  const nowLocal = instantToLocal(new Date(serverNow()), tz);
  const [type, setType] = useState<PunchType>("in");
  const [date, setDate] = useState(today);
  const [minutes, setMinutes] = useState(Math.max(0, Math.floor(nowLocal.minutes / 15) * 15 - 60));
  const [note, setNote] = useState("");
  const days = useMemo(() => Array.from({ length: DAYS_BACK + 1 }, (_, i) => addDays(today, -i)), [today]);
  const dayLabel = (d: string, i: number) => (i === 0 ? "Today" : i === 1 ? "Yesterday" : fmt("UTC", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${d}T12:00:00Z`)));
  const future = date === today && minutes > nowLocal.minutes + 5;
  const step = (d: number) => setMinutes((m) => Math.min(1439, Math.max(0, m + d)));

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 pb-6 pt-2 kiosk-fade-up" data-testid="kiosk-fix">
      <h1 className="text-center text-4xl font-display font-normal tracking-[-0.01em] text-stone-950">Fix a missed punch</h1>
      <p className="mt-1 text-center text-xl text-stone-700">{name} · a manager will check it</p>

      <div className="mt-5 w-full max-w-4xl space-y-5">
        <section>
          <p className="mb-2 text-lg font-semibold text-stone-800">What did you forget?</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {PUNCH_TYPES.map((t) => (
              <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)} className={`kiosk-tap rounded-2xl px-4 text-lg font-semibold leading-tight ring-2 transition active:scale-[0.98] sm:text-xl lg:text-lg ${type === t ? "kiosk-selected" : "bg-white text-stone-900 ring-stone-300 active:bg-stone-100"}`} data-testid={`kiosk-fix-type-${t}`}>
                {FIX_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="mb-2 text-lg font-semibold text-stone-800">Which day?</p>
          <div className="flex flex-wrap gap-2 lg:grid lg:grid-cols-7">
            {days.map((d, i) => (
              <button key={d} type="button" aria-pressed={date === d} onClick={() => setDate(d)} className={`kiosk-tap rounded-2xl px-5 text-lg font-semibold ring-2 transition active:scale-[0.98] lg:px-2 lg:text-base ${date === d ? "kiosk-selected" : "bg-white text-stone-900 ring-stone-300 active:bg-stone-100"}`}>
                {dayLabel(d, i)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="mb-2 text-lg font-semibold text-stone-800">What time?</p>
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-3xl bg-stone-50 p-2 ring-2 ring-stone-200 sm:flex-nowrap sm:justify-between">
            <StepButton label="1 hour earlier" onClick={() => step(-60)}><Minus className="h-6 w-6" />1h</StepButton>
            <StepButton label="15 minutes earlier" onClick={() => step(-15)}><Minus className="h-6 w-6" />15</StepButton>
            <StepButton label="5 minutes earlier" onClick={() => step(-5)} wide><Minus className="h-6 w-6" />5</StepButton>
            <span className="tabular order-first basis-full whitespace-nowrap py-1 text-center text-4xl font-bold text-stone-950 sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto sm:py-0 sm:text-5xl" data-testid="kiosk-fix-time">{formatTime(minutes)}</span>
            <StepButton label="5 minutes later" onClick={() => step(5)} wide><Plus className="h-6 w-6" />5</StepButton>
            <StepButton label="15 minutes later" onClick={() => step(15)}><Plus className="h-6 w-6" />15</StepButton>
            <StepButton label="1 hour later" onClick={() => step(60)}><Plus className="h-6 w-6" />1h</StepButton>
          </div>
          <div className="mt-2 flex justify-center gap-2 lg:hidden">
            {[-5, 5].map((d) => <button key={d} type="button" onClick={() => step(d)} className="kiosk-tap rounded-2xl px-5 text-lg font-semibold text-stone-900 ring-2 ring-stone-300 transition active:scale-95 active:bg-stone-100">{d > 0 ? "+" : "−"}5 min</button>)}
          </div>
        </section>

        <section>
          <label className="mb-2 block text-lg font-semibold text-stone-800" htmlFor="kiosk-fix-note">Note for your manager (optional)</label>
          <input id="kiosk-fix-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={`e.g. I forgot to ${type === "out" ? "clock out" : "clock in"} at ${formatTime(minutes)}`} className="kiosk-field h-16 w-full rounded-2xl bg-white px-5 text-xl text-stone-950 outline-none ring-2 ring-stone-300 placeholder:text-stone-600" data-testid="kiosk-fix-note" />
        </section>
      </div>

      <p className={`mt-3 min-h-7 text-center text-xl font-medium ${error || future || !online ? "text-red-700" : "text-transparent"}`} role="alert">
        {!online ? "No connection. Try again when the tablet is back online." : future ? "That time is in the future." : error || "·"}
      </p>
      <div className="mt-2 grid w-full max-w-4xl gap-3 sm:grid-cols-2 sm:gap-4">
        <BigSecondary onClick={onCancel}>Cancel</BigSecondary>
        <button type="button" disabled={busy || future || !online} onClick={() => onSubmit({ type, date, minutes, note: note.trim() })} className="kiosk-tap kiosk-primary order-first flex items-center justify-center gap-3 rounded-2xl px-4 text-xl font-bold transition sm:order-none active:scale-[0.98]" data-testid="kiosk-fix-send">
          <Send className="h-6 w-6" />{busy ? "Sending…" : "Send to manager"}
        </button>
      </div>
    </div>
  );
}

function StepButton({ children, label, onClick, wide }: { children: React.ReactNode; label: string; onClick: () => void; wide?: boolean }) {
  // "wide" steps (5 min) sit in the row only where there is room; phones get them in a row below.
  return (
    <button type="button" aria-label={label} onClick={onClick} className={`kiosk-tap ${wide ? "hidden lg:flex" : "flex"} h-16 min-w-16 shrink-0 items-center justify-center gap-0.5 rounded-2xl bg-white px-3 text-lg font-semibold text-stone-900 ring-2 ring-stone-300 transition active:scale-95 active:bg-stone-100`}>
      {children}
    </button>
  );
}

/** A short message that goes home by itself (e.g. "Request sent"). */
export function MessageScreen({ title, line, onDone }: { title: string; line: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 5000); return () => clearTimeout(t); }, [onDone]);
  return (
    <button type="button" className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center" onClick={onDone} data-testid="kiosk-message">
      <span className="kiosk-pop flex h-24 w-24 items-center justify-center rounded-full bg-stone-900 text-white"><Check className="h-14 w-14" strokeWidth={3} /></span>
      <h1 className="mt-8 text-5xl font-display font-normal tracking-[-0.01em] text-stone-950">{title}</h1>
      <p className="mt-3 max-w-xl text-2xl text-stone-700">{line}</p>
    </button>
  );
}
