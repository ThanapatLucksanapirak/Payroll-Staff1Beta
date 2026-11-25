import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Coffee, Delete, LogIn, LogOut, Maximize, Minimize, Play, Search, Settings2, WifiOff, X } from "lucide-react";
import { type ClockStatus, type PunchType, PUNCH_LABELS, allowedActions, statusAfter } from "@shared/punches";
import {
  type Identified, type KioskState, type PunchResult, type RosterEmployee, KioskError, cache, clockOffset, flushQueue, queue, request,
  serverNow, token, uuid,
} from "./api";

// ── Formatting in the location's time zone ────────────────────────────────────
function fmt(tz: string, opts: Intl.DateTimeFormatOptions) {
  try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }); } catch { return new Intl.DateTimeFormat(undefined, opts); }
}
const timeOf = (at: string | number, tz: string) => fmt(tz, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
const hourIn = (tz: string) => Number(fmt(tz, { hour: "numeric", hourCycle: "h23" }).format(new Date(serverNow()))) % 24;
const duration = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };
const firstName = (n: string) => n.split(" ")[0] || n;
const initials = (n: string) => n.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function confirmation(type: PunchType, name: string, at: string, tz: string, todayMinutes: number) {
  const t = timeOf(at, tz);
  const first = firstName(name);
  const h = hourIn(tz);
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  switch (type) {
    case "in": return { title: `${greet}, ${first}`, line: `Clocked in at ${t}` };
    case "break_start": return { title: `Enjoy your break, ${first}`, line: `Break started at ${t}` };
    case "break_end": return { title: `Welcome back, ${first}`, line: `Break ended at ${t}` };
    default: return { title: `Thanks, ${first}`, line: `Clocked out at ${t}${todayMinutes ? ` · ${duration(todayMinutes)} today` : ""}` };
  }
}

const STATUS_TEXT: Record<ClockStatus, string> = { in: "Working", break: "On break", out: "Not clocked in" };
const STATUS_DOT: Record<ClockStatus, string> = { in: "bg-emerald-500", break: "bg-amber-400", out: "bg-neutral-300" };

const ACTION_STYLE: Record<PunchType, { cls: string; icon: typeof LogIn }> = {
  in: { cls: "bg-emerald-600 text-white active:bg-emerald-700", icon: LogIn },
  break_start: { cls: "bg-amber-400 text-neutral-900 active:bg-amber-500", icon: Coffee },
  break_end: { cls: "bg-sky-600 text-white active:bg-sky-700", icon: Play },
  out: { cls: "bg-neutral-900 text-white active:bg-neutral-700", icon: LogOut },
};

type Screen =
  | { k: "home" }
  | { k: "pin"; employee?: RosterEmployee; error?: string; shake?: number }
  | { k: "actions"; who: Identified; pin: string; offline: boolean; error?: string; busy?: boolean }
  | { k: "done"; title: string; line: string; note?: string; tone: "ok" | "queued" };

// ── App ───────────────────────────────────────────────────────────────────────
export function KioskApp() {
  const [paired, setPaired] = useState(() => !!token.get());
  const [state, setState] = useState<KioskState | null>(() => (token.get() ? cache.get() : null));
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(() => queue.all().length);
  const [notice, setNotice] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ k: "home" });
  const [showInfo, setShowInfo] = useState(false);

  // Pairing link: /kiosk#pair=<token>
  useEffect(() => {
    const m = /[#&]pair=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash);
    if (m) {
      token.set(m[1]);
      queue.save([]);
      history.replaceState(null, "", window.location.pathname);
      setPaired(true);
    }
  }, []);

  const unpair = useCallback((message?: string) => {
    token.clear();
    setPaired(false);
    setState(null);
    setScreen({ k: "home" });
    if (message) setNotice(message);
  }, []);

  const refresh = useCallback(async () => {
    if (!token.get()) return;
    try {
      const t0 = Date.now();
      const s = await request<KioskState>("GET", "/api/kiosk/state");
      clockOffset.set(Date.parse(s.serverTime) - (t0 + Date.now()) / 2);
      // Keep statuses changed by punches still waiting in the queue.
      const q = queue.all();
      if (q.length) s.employees = s.employees.map((e) => { const last = [...q].reverse().find((p) => p.employeeId === e.id); return last ? { ...e, status: statusAfter(last.type), since: last.at } : e; });
      cache.set(s);
      setState(s);
      setOnline(true);
    } catch (err) {
      const e = err as KioskError;
      if (e.code === "device") unpair("This time clock was removed from the admin app. Pair it again to continue.");
      else if (e.offline) setOnline(false);
    }
  }, [unpair]);

  const sync = useCallback(async () => {
    if (!queue.all().length) { setPending(0); return; }
    const r = await flushQueue();
    setPending(r.remaining);
    if (r.unpaired) return unpair("This time clock was removed from the admin app. Pair it again to continue.");
    if (r.sent) { setOnline(true); void refresh(); }
    if (r.rejected.length) {
      const first = r.rejected[0];
      setNotice(`${r.rejected.length === 1 ? "An offline punch" : `${r.rejected.length} offline punches`} couldn't be saved (${first.item.name}: ${first.message}) Please tell a manager.`);
    }
  }, [refresh, unpair]);

  useEffect(() => {
    if (!paired) return;
    void refresh().then(sync);
    const poll = setInterval(() => { void refresh(); void sync(); }, online ? 60_000 : 15_000);
    const back = () => { void refresh(); void sync(); };
    const gone = () => setOnline(false);
    window.addEventListener("online", back);
    window.addEventListener("offline", gone);
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(poll); window.removeEventListener("online", back); window.removeEventListener("offline", gone); document.removeEventListener("visibilitychange", back); };
  }, [paired, online, refresh, sync]);

  useWakeLock(paired);

  if (!paired) return <PairScreen notice={notice} onPaired={() => { setNotice(null); setPaired(true); }} />;
  if (!state) return <Splash online={online} onRetry={refresh} />;

  const tz = state.site.timezone;
  const loginMode = online ? state.site.loginMode : "name_pin"; // offline, a PIN alone can't be looked up
  const home = () => setScreen({ k: "home" });

  const identify = async (pin: string, employee?: RosterEmployee) => {
    try {
      const who = await request<Identified>("POST", "/api/kiosk/identify", { pin, employeeId: employee?.id });
      setOnline(true);
      setScreen({ k: "actions", who, pin, offline: false });
    } catch (err) {
      const e = err as KioskError;
      if (e.code === "device") return unpair("This time clock was removed from the admin app.");
      if (e.offline) {
        setOnline(false);
        if (!employee) { setScreen({ k: "home" }); setNotice("You're offline. Tap your name, then enter your PIN."); return; }
        const status = employee.status;
        setScreen({
          k: "actions", pin, offline: true,
          who: { employee: { id: employee.id, name: employee.name, role: employee.role }, status, since: employee.since, todayMinutes: 0, actions: allowedActions(status) },
        });
        return;
      }
      setScreen((s) => ({ k: "pin", employee: s.k === "pin" ? s.employee : employee, error: e.message, shake: Date.now() }));
    }
  };

  const queueIt = (type: PunchType, who: Identified, pin: string) => {
    const at = new Date(serverNow()).toISOString();
    queue.add({ id: uuid(), type, employeeId: who.employee.id, name: who.employee.name, pin, at, tries: 0 });
    setPending(queue.all().length);
    const next = statusAfter(type);
    const s = { ...state, employees: state.employees.map((e) => (e.id === who.employee.id ? { ...e, status: next, since: at } : e)) };
    cache.set(s);
    setState(s);
    const c = confirmation(type, who.employee.name, at, tz, 0);
    setScreen({ k: "done", ...c, tone: "queued", note: "Saved on this tablet. It will be sent when the connection is back." });
  };

  const punch = async (type: PunchType) => {
    if (screen.k !== "actions") return;
    const { who, pin, offline } = screen;
    if (offline) return queueIt(type, who, pin);
    setScreen({ ...screen, busy: true, error: undefined });
    const id = uuid();
    try {
      const r = await request<PunchResult>("POST", "/api/kiosk/punch", { id, type, ticket: who.ticket, pin, employeeId: who.employee.id });
      setOnline(true);
      const c = confirmation(type, r.employee.name, r.punch.at, tz, r.todayMinutes);
      setScreen({ k: "done", ...c, tone: "ok" });
      setState({ ...state, employees: state.employees.map((e) => (e.id === r.employee.id ? { ...e, status: r.status, since: r.since } : e)) });
      void refresh();
    } catch (err) {
      const e = err as KioskError;
      if (e.code === "device") return unpair("This time clock was removed from the admin app.");
      if (e.offline) { setOnline(false); return queueIt(type, who, pin); }
      setScreen({ ...screen, busy: false, error: e.message });
    }
  };

  return (
    <div className="flex h-full flex-col bg-white">
      <TopBar state={state} online={online} pending={pending} onInfo={() => setShowInfo(true)} />
      {notice && (
        <button className="mx-auto mt-2 flex max-w-xl items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2 text-left text-sm text-amber-900 ring-1 ring-amber-200" onClick={() => setNotice(null)}>
          <span className="flex-1">{notice}</span><X className="h-4 w-4 shrink-0" />
        </button>
      )}
      <main className="flex min-h-0 flex-1 flex-col">
        {!state.site.enabled ? (
          <Centered>
            <BigClock tz={tz} />
            <p className="mt-10 text-xl text-neutral-500">The time clock is turned off for this location.</p>
            <p className="mt-2 text-neutral-400">A manager can turn it on in Settings → Locations → Time clock.</p>
          </Centered>
        ) : screen.k === "home" ? (
          loginMode === "pin" ? (
            <PinScreen tz={tz} onSubmit={(pin) => identify(pin)} key="pin-home" />
          ) : (
            <NamesScreen tz={tz} employees={state.employees} onPick={(e) => setScreen({ k: "pin", employee: e })} />
          )
        ) : screen.k === "pin" ? (
          <PinScreen tz={tz} employee={screen.employee} error={screen.error} shake={screen.shake} onSubmit={(pin) => identify(pin, screen.employee)} onBack={home} />
        ) : screen.k === "actions" ? (
          <ActionsScreen tz={tz} {...screen} onPunch={punch} onCancel={home} />
        ) : (
          <DoneScreen {...screen} onDone={home} />
        )}
      </main>
      {showInfo && <InfoSheet state={state} pending={pending} online={online} onClose={() => setShowInfo(false)} onSync={sync} onUnpair={() => { setShowInfo(false); unpair(); }} />}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-1 flex-col items-center justify-center px-6 py-8 text-center">{children}</div>;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => { const t = setInterval(() => setNow(serverNow()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

function BigClock({ tz, compact }: { tz: string; compact?: boolean }) {
  const now = useNow();
  const parts = fmt(tz, { hour: "numeric", minute: "2-digit" }).formatToParts(new Date(now));
  const main = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
  const period = parts.find((p) => p.type === "dayPeriod")?.value;
  const date = fmt(tz, { weekday: "long", month: "long", day: "numeric" }).format(new Date(now));
  return (
    <div className="select-none" aria-live="off">
      <div className={`tabular font-extralight tracking-tight text-neutral-900 ${compact ? "text-6xl sm:text-7xl" : "text-7xl sm:text-8xl lg:text-9xl"}`} data-testid="kiosk-clock">
        {main}{period && <span className={`ml-2 font-light text-neutral-400 ${compact ? "text-2xl" : "text-3xl sm:text-4xl"}`}>{period}</span>}
      </div>
      <div className={`mt-2 font-normal text-neutral-500 ${compact ? "text-lg" : "text-xl sm:text-2xl"}`}>{date}</div>
    </div>
  );
}

function TopBar({ state, online, pending, onInfo }: { state: KioskState; online: boolean; pending: number; onInfo: () => void }) {
  const fs = useFullscreen();
  return (
    <header className="flex items-center gap-3 px-5 pt-4 sm:px-8 sm:pt-6">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: state.site.color }} aria-hidden />
      <span className="truncate text-base font-medium text-neutral-700 sm:text-lg" data-testid="kiosk-location">{state.site.name}</span>
      <div className="ml-auto flex items-center gap-2">
        {(!online || pending > 0) && (
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${online ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-800"}`} data-testid="kiosk-offline">
            {!online && <WifiOff className="h-4 w-4" />}
            {online ? `Sending ${pending}…` : pending ? `Offline · ${pending} saved` : "Offline"}
          </span>
        )}
        {fs.supported && (
          <button onClick={fs.toggle} className="rounded-full p-2.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700" aria-label={fs.active ? "Exit full screen" : "Full screen"} data-testid="kiosk-fullscreen">
            {fs.active ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
        )}
        <button onClick={onInfo} className="rounded-full p-2.5 text-neutral-300 transition hover:bg-neutral-100 hover:text-neutral-600" aria-label="Device settings">
          <Settings2 className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}

function useIdle(ms: number, onIdle: () => void, deps: unknown[] = []) {
  const ref = useRef(onIdle);
  ref.current = onIdle;
  useEffect(() => {
    let t = setTimeout(() => ref.current(), ms);
    const bump = () => { clearTimeout(t); t = setTimeout(() => ref.current(), ms); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => { clearTimeout(t); window.removeEventListener("pointerdown", bump); window.removeEventListener("keydown", bump); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

function PinScreen({ tz, employee, error, shake, onSubmit, onBack }: { tz: string; employee?: RosterEmployee; error?: string; shake?: number; onSubmit: (pin: string) => Promise<void> | void; onBack?: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (shake) setPin(""); }, [shake]);
  useIdle(30_000, () => { setPin(""); onBack?.(); }, [onBack]);

  const submit = useCallback(async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    try { await onSubmit(value); } finally { setBusy(false); setPin(""); }
  }, [busy, onSubmit]);
  const press = useCallback((d: string) => setPin((p) => (p.length >= 6 ? p : p + d)), []);
  const back = useCallback(() => setPin((p) => p.slice(0, -1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") back();
      else if (e.key === "Enter") void submit(pin);
      else if (e.key === "Escape") onBack?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin, press, back, submit, onBack]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-6 lg:flex-row lg:gap-24">
      <div className="text-center lg:text-left">
        {employee ? (
          <div className="kiosk-fade-up">
            <Avatar name={employee.name} big />
            <p className="mt-4 text-3xl font-semibold tracking-tight">Hi, {firstName(employee.name)}</p>
            <p className="mt-1 text-lg text-neutral-500">Enter your PIN</p>
          </div>
        ) : (
          <>
            <BigClock tz={tz} />
            <p className="mt-6 text-xl text-neutral-500 lg:mt-10">Enter your PIN to clock in or out</p>
          </>
        )}
      </div>
      <div className="flex flex-col items-center">
        <div key={shake} className={`flex h-10 items-center gap-4 ${shake ? "kiosk-shake" : ""}`} aria-label={`${pin.length} digits entered`} data-testid="kiosk-pin-dots">
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
            <span key={i} className={`h-4 w-4 rounded-full transition-all duration-150 ${i < pin.length ? "scale-110 bg-neutral-900" : "bg-neutral-200"}`} />
          ))}
        </div>
        <p className={`mt-2 h-6 text-base ${error ? "text-red-600" : "text-transparent"}`} role="alert">{error || "·"}</p>
        <div className="mt-3 grid grid-cols-3 gap-4 sm:gap-5">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <Key key={d} onPress={() => press(d)} label={d} />)}
          {onBack && employee ? <Key onPress={onBack} label={<ArrowLeft className="h-7 w-7" />} subtle aria="Back" /> : <Key onPress={back} label={<Delete className="h-7 w-7" />} subtle aria="Delete" />}
          <Key onPress={() => press("0")} label="0" />
          <Key onPress={() => void submit(pin)} label={busy ? <Spinner /> : <Check className="h-8 w-8" />} primary disabled={pin.length < 4 || busy} aria="OK" />
        </div>
        {onBack && employee && pin.length > 0 && <button className="mt-4 text-base text-neutral-500" onClick={back}>Delete last digit</button>}
      </div>
    </div>
  );
}

function Key({ label, onPress, primary, subtle, disabled, aria }: { label: React.ReactNode; onPress: () => void; primary?: boolean; subtle?: boolean; disabled?: boolean; aria?: string }) {
  return (
    <button
      type="button"
      aria-label={aria ?? String(label)}
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); if (!disabled) onPress(); }}
      onKeyDown={(e) => { if (e.key === " ") onPress(); }}
      className={`flex h-20 w-20 items-center justify-center rounded-full text-3xl font-light transition-all duration-100 active:scale-95 sm:h-24 sm:w-24 sm:text-4xl ${
        primary ? "bg-neutral-900 text-white disabled:bg-neutral-200 disabled:text-neutral-400" : subtle ? "text-neutral-500 active:bg-neutral-100" : "bg-neutral-100 text-neutral-900 active:bg-neutral-200"
      }`}
      data-testid={`kiosk-key-${aria ?? label}`}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
}

function Avatar({ name, big, status }: { name: string; big?: boolean; status?: ClockStatus }) {
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-100 font-medium text-neutral-700 ${big ? "h-24 w-24 text-3xl" : "h-14 w-14 text-lg"}`}>
      {initials(name)}
      {status && <span className={`absolute bottom-0.5 right-0.5 h-4 w-4 rounded-full ring-2 ring-white ${STATUS_DOT[status]}`} />}
    </span>
  );
}

function NamesScreen({ tz, employees, onPick }: { tz: string; employees: RosterEmployee[]; onPick: (e: RosterEmployee) => void }) {
  const [q, setQ] = useState("");
  useIdle(30_000, () => setQ(""));
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? employees.filter((e) => e.name.toLowerCase().includes(s)) : employees;
  }, [employees, q]);
  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4 py-4 sm:py-6">
        <BigClock tz={tz} compact />
        {employees.length > 12 && (
          <label className="flex w-full max-w-xs items-center gap-2 rounded-2xl bg-neutral-100 px-4 py-3 text-lg">
            <Search className="h-5 w-5 text-neutral-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find your name" className="w-full bg-transparent outline-none placeholder:text-neutral-400" />
          </label>
        )}
      </div>
      <p className="mb-3 text-lg text-neutral-500">Tap your name</p>
      {employees.length === 0 ? (
        <p className="mt-10 text-center text-lg text-neutral-400">No employees are set up yet. A manager can add them in the admin app under Employees.</p>
      ) : (
        <div className="-mx-1 grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto px-1 pb-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((e) => (
            <button key={e.id} onClick={() => onPick(e)} className="flex items-center gap-4 rounded-3xl bg-neutral-50 p-4 text-left ring-1 ring-neutral-100 transition active:scale-[0.98] active:bg-neutral-100" data-testid={`kiosk-name-${e.id}`}>
              <Avatar name={e.name} status={e.status} />
              <span className="min-w-0">
                <span className="block truncate text-lg font-medium">{e.name}</span>
                <span className="block truncate text-sm text-neutral-500">{e.status === "out" ? e.role || STATUS_TEXT.out : `${STATUS_TEXT[e.status]}${e.since ? ` since ${timeOf(e.since, tz)}` : ""}`}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionsScreen({ tz, who, offline, error, busy, onPunch, onCancel }: { tz: string; who: Identified; offline: boolean; error?: string; busy?: boolean; onPunch: (t: PunchType) => void; onCancel: () => void }) {
  useIdle(30_000, onCancel);
  const statusLine = who.status === "out" ? "You're not clocked in" : `${STATUS_TEXT[who.status]} since ${who.since ? timeOf(who.since, tz) : "—"}`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center kiosk-fade-up">
      <Avatar name={who.employee.name} big status={who.status} />
      <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl" data-testid="kiosk-employee-name">{who.employee.name}</h1>
      <p className="mt-2 text-xl text-neutral-500">
        {statusLine}{!offline && who.todayMinutes > 0 ? ` · ${duration(who.todayMinutes)} today` : ""}
      </p>
      {offline && <p className="mt-3 rounded-full bg-amber-50 px-4 py-1.5 text-base text-amber-800"><WifiOff className="mr-1.5 inline h-4 w-4" />Offline: your punch will be saved on this tablet</p>}
      <div className="mt-10 grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        {who.actions.map((a) => {
          const st = ACTION_STYLE[a];
          return (
            <button key={a} disabled={busy} onClick={() => onPunch(a)} className={`flex h-28 items-center justify-center gap-3 rounded-3xl text-2xl font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-60 sm:h-32 sm:text-3xl ${st.cls} ${who.actions.length === 1 ? "sm:col-span-2" : ""}`} data-testid={`kiosk-action-${a}`}>
              <st.icon className="h-8 w-8" />{PUNCH_LABELS[a]}
            </button>
          );
        })}
      </div>
      <p className={`mt-5 h-7 text-lg ${error ? "text-red-600" : "text-transparent"}`} role="alert">{error || "·"}</p>
      <button onClick={onCancel} className="mt-2 rounded-full px-6 py-3 text-lg text-neutral-500 active:bg-neutral-100">Cancel</button>
    </div>
  );
}

function DoneScreen({ title, line, note, tone, onDone }: { title: string; line: string; note?: string; tone: "ok" | "queued"; onDone: () => void }) {
  const ms = tone === "ok" ? 4000 : 6000;
  useEffect(() => { const t = setTimeout(onDone, ms); return () => clearTimeout(t); }, [onDone, ms]);
  return (
    <button className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center" onClick={onDone} data-testid="kiosk-done">
      <span className={`kiosk-pop flex h-28 w-28 items-center justify-center rounded-full ${tone === "ok" ? "bg-emerald-500" : "bg-amber-400"} text-white shadow-lg`}>
        <Check className="h-16 w-16" strokeWidth={2.5} />
      </span>
      <h1 className="kiosk-fade-up mt-8 text-4xl font-semibold tracking-tight sm:text-5xl" data-testid="kiosk-confirmation">{title}</h1>
      <p className="kiosk-fade-up mt-3 text-2xl text-neutral-600">{line}</p>
      {note && <p className="kiosk-fade-up mt-4 max-w-md text-lg text-amber-800">{note}</p>}
      <span className="mt-12 h-1 w-48 overflow-hidden rounded-full bg-neutral-100">
        <span className="kiosk-countdown block h-full bg-neutral-300" style={{ animationDuration: `${ms}ms` }} />
      </span>
    </button>
  );
}

function PairScreen({ notice, onPaired }: { notice: string | null; onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await request<{ token: string }>("POST", "/api/kiosk/pair", { code });
      token.set(r.token);
      queue.save([]);
      onPaired();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Centered>
      <div className="w-full max-w-md kiosk-fade-up">
        <h1 className="text-4xl font-semibold tracking-tight">Set up this time clock</h1>
        <p className="mt-3 text-lg text-neutral-500">In the admin app, open <b className="font-medium text-neutral-700">Settings → Locations → Time clock</b>, add a device, then open its pairing link here or type its code.</p>
        {notice && <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-amber-900">{notice}</p>}
        <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 8) void submit(); }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9))}
            placeholder="ABCD-1234"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-2xl bg-neutral-100 px-5 py-4 text-center font-mono text-3xl tracking-[0.2em] outline-none ring-neutral-300 focus:ring-2"
            data-testid="kiosk-pair-code"
          />
          {error && <p className="text-red-600" role="alert">{error}</p>}
          <button disabled={busy || code.replace(/-/g, "").length < 8} className="h-16 w-full rounded-2xl bg-neutral-900 text-xl font-semibold text-white transition active:scale-[0.99] disabled:bg-neutral-200 disabled:text-neutral-400" data-testid="kiosk-pair-submit">
            {busy ? "Pairing…" : "Pair device"}
          </button>
        </form>
      </div>
    </Centered>
  );
}

function Splash({ online, onRetry }: { online: boolean; onRetry: () => void }) {
  return (
    <Centered>
      {online ? <span className="h-10 w-10 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-500" /> : (
        <>
          <WifiOff className="h-10 w-10 text-neutral-400" />
          <p className="mt-4 text-xl text-neutral-600">Can't reach the server.</p>
          <button onClick={onRetry} className="mt-6 rounded-full bg-neutral-100 px-6 py-3 text-lg">Try again</button>
        </>
      )}
    </Centered>
  );
}

function InfoSheet({ state, pending, online, onClose, onSync, onUnpair }: { state: KioskState; pending: number; online: boolean; onClose: () => void; onSync: () => void; onUnpair: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl kiosk-fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{state.device.name}</h2>
            <p className="text-neutral-500">{state.site.name} · {state.site.timezone}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-neutral-400 hover:bg-neutral-100" aria-label="Close"><X className="h-6 w-6" /></button>
        </div>
        <dl className="mt-5 space-y-2 text-lg">
          <div className="flex justify-between"><dt className="text-neutral-500">Connection</dt><dd>{online ? "Online" : "Offline"}</dd></div>
          <div className="flex justify-between"><dt className="text-neutral-500">Punches waiting to send</dt><dd className="tabular">{pending}</dd></div>
          <div className="flex justify-between"><dt className="text-neutral-500">Sign-in</dt><dd>{state.site.loginMode === "pin" ? "PIN" : "Name, then PIN"}</dd></div>
        </dl>
        <div className="mt-6 grid gap-3">
          {pending > 0 && <button onClick={onSync} className="h-14 rounded-2xl bg-neutral-100 text-lg font-medium">Send now</button>}
          <button
            onClick={() => { if (window.confirm(pending ? `${pending} punches have not been sent yet and will be lost. Unpair anyway?` : "Unpair this device? You'll need a new pairing code from the admin app.")) { queue.save([]); onUnpair(); } }}
            className="h-14 rounded-2xl text-lg font-medium text-red-600 ring-1 ring-red-200"
          >
            Unpair this device
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Browser helpers ───────────────────────────────────────────────────────────
function useFullscreen() {
  const doc = document as any;
  const el = document.documentElement as any;
  const supported = !!(el.requestFullscreen || el.webkitRequestFullscreen);
  const [active, setActive] = useState(() => !!(doc.fullscreenElement || doc.webkitFullscreenElement));
  useEffect(() => {
    const fn = () => setActive(!!(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", fn);
    document.addEventListener("webkitfullscreenchange", fn);
    return () => { document.removeEventListener("fullscreenchange", fn); document.removeEventListener("webkitfullscreenchange", fn); };
  }, [doc]);
  const toggle = () => {
    try {
      if (active) (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
      else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } catch { /* not allowed */ }
  };
  return { supported, active, toggle };
}

/** Keep the screen on while the kiosk is open (where the browser supports it). */
function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: any = null;
    const get = async () => { try { if (document.visibilityState === "visible") lock = await (navigator as any).wakeLock.request("screen"); } catch { /* denied */ } };
    void get();
    document.addEventListener("visibilitychange", get);
    return () => { document.removeEventListener("visibilitychange", get); lock?.release?.().catch?.(() => undefined); };
  }, [enabled]);
}
