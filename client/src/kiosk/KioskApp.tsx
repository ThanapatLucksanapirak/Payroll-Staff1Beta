import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, CameraOff, Check, Delete, Maximize, Minimize, Search, Settings2, Wrench, WifiOff, X } from "lucide-react";
import { type ClockStatus, type PunchType, PUNCH_LABELS, allowedActions, statusAfter } from "@shared/punches";
import { checkAction } from "@shared/kiosk";
import {
  type Identified, type KioskNote, type KioskOptions, type KioskState, type PunchResult, type RosterEmployee, KioskError, cache, clockOffset,
  flushQueue, queue, request, serverNow, token, uuid,
} from "./api";
import { type CameraStatus, useCamera } from "./camera";
import { ACTION_STYLE, BigSecondary, duration, firstName, fmt, initials, timeOf, useIdle } from "./ui";
import { Mark } from "@/components/Logo";
import { AndroidAppButton, useAndroidAppDownload } from "./appDownload";
import { type Confirm, type FixInput, BreakNudge, ConfirmScreen, FixRequestScreen, GuardScreen, MessageScreen, NoteScreen, StationScreen } from "./screens";

const STATUS_TEXT: Record<ClockStatus, string> = { in: "Working", break: "On break", out: "Not clocked in" };
const STATUS_DOT: Record<ClockStatus, string> = { in: "bg-emerald-600", break: "bg-amber-400", out: "bg-stone-400" };
const DEFAULT_OPTIONS: KioskOptions = { photo: false, idleSeconds: 10, stations: [], breakReminderHours: null };

/** Who is at the kiosk right now, and how they signed in. */
interface Session { who: Identified; pin: string; offline: boolean }
/** Just the session fields of a screen (so spreading it can't carry the old screen's kind). */
const only = (s: Session): Session => ({ who: s.who, pin: s.pin, offline: s.offline });

type Screen =
  | { k: "home" }
  | { k: "pin"; employee?: RosterEmployee; error?: string; shake?: number }
  | ({ k: "actions"; error?: string } & Session)
  | ({ k: "station"; type: PunchType; photo: string | null | undefined } & Session)
  | ({ k: "guard"; message: string; question: string | null; suggest: PunchType | null; error?: string } & Session)
  | ({ k: "fix"; error?: string } & Session)
  | { k: "notes"; notes: KioskNote[]; i: number; auth: { ticket?: string; pin: string; employeeId: string }; confirm: Confirm }
  | { k: "done"; c: Confirm }
  | { k: "message"; title: string; line: string }
  | { k: "manager"; next: "settings" | "exit"; error?: string; shake?: number };

// ── App ───────────────────────────────────────────────────────────────────────
export function KioskApp() {
  const [paired, setPaired] = useState(() => !!token.get());
  const [state, setState] = useState<KioskState | null>(() => (token.get() ? cache.get() : null));
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(() => queue.all().length);
  const [notice, setNotice] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ k: "home" });
  const [busy, setBusy] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  /** The manager PIN entered to open settings (needed to unpair); cleared when settings close. */
  const [managerPin, setManagerPin] = useState<string | null>(null);
  const exitFullscreen = useRef<(() => void) | null>(null);

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

  const options = state?.options ?? DEFAULT_OPTIONS;
  // The camera runs only while someone is choosing an action, so a snapshot is ready when they tap.
  const cameraOn = !!state?.site.enabled && options.photo && (screen.k === "actions" || screen.k === "guard");
  const camera = useCamera(cameraOn);

  const home = useCallback(() => { setBusy(false); setScreen({ k: "home" }); }, []);

  if (!paired) return <PairScreen notice={notice} onPaired={() => { setNotice(null); setPaired(true); }} />;
  if (!state) return <Splash online={online} onRetry={refresh} />;

  const tz = state.site.timezone;
  const idleMs = Math.max(5, options.idleSeconds || 10) * 1000;
  const loginMode = online ? state.site.loginMode : "name_pin"; // offline, a PIN alone can't be looked up

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

  const setRoster = (employeeId: string, status: ClockStatus, since: string | null) => {
    setState((s) => {
      if (!s) return s;
      const next = { ...s, employees: s.employees.map((e) => (e.id === employeeId ? { ...e, status, since } : e)) };
      cache.set(next);
      return next;
    });
  };

  const queueIt = (type: PunchType, sess: Session, photo: string | null | undefined, station: string | null) => {
    const at = new Date(serverNow()).toISOString();
    queue.add({ id: uuid(), type, employeeId: sess.who.employee.id, name: sess.who.employee.name, pin: sess.pin, at, tries: 0, station, ...(photo !== undefined ? { photo } : {}) });
    setPending(queue.all().length);
    setRoster(sess.who.employee.id, statusAfter(type), at);
    setBusy(false);
    setScreen({ k: "done", c: { type, name: sess.who.employee.name, at, tone: "queued", station, note: "Saved on this tablet. It will be sent when the connection is back." } });
  };

  /** Send a punch (or queue it offline) and show what happened. */
  const send = async (type: PunchType, sess: Session, photo: string | null | undefined, station: string | null) => {
    if (sess.offline) return queueIt(type, sess, photo, station);
    setBusy(true);
    try {
      const r = await request<PunchResult>("POST", "/api/kiosk/punch", {
        id: uuid(), type, ticket: sess.who.ticket, pin: sess.pin, employeeId: sess.who.employee.id,
        ...(station ? { station } : {}), ...(photo !== undefined ? { photo } : {}),
      }, photo ? 15_000 : 8000);
      setOnline(true);
      setBusy(false);
      setRoster(r.employee.id, r.status, r.since);
      const c: Confirm = { type, name: r.employee.name, at: r.punch.at, tone: "ok", day: r, station: r.punch.station ?? r.station ?? null };
      if (r.notes?.length) setScreen({ k: "notes", notes: r.notes, i: 0, auth: { ticket: r.ticket, pin: sess.pin, employeeId: r.employee.id }, confirm: c });
      else setScreen({ k: "done", c });
      void refresh();
    } catch (err) {
      setBusy(false);
      const e = err as KioskError;
      if (e.code === "device") return unpair("This time clock was removed from the admin app.");
      if (e.offline) { setOnline(false); return queueIt(type, sess, photo, station); }
      if (e.code === "state" && e.body) {
        // Wrong action for the current state: explain and offer the one that makes sense.
        const status: ClockStatus = e.body.status ?? sess.who.status;
        const who: Identified = { ...sess.who, status, actions: e.body.actions ?? allowedActions(status), ticket: e.body.ticket ?? sess.who.ticket };
        setRoster(who.employee.id, status, who.since);
        return setScreen({ k: "guard", who, pin: sess.pin, offline: false, message: e.message, question: e.body.question ?? null, suggest: e.body.suggest ?? null });
      }
      if (e.code === "photo") void refresh(); // the device's photo setting may have just changed
      setScreen({ ...only(sess), k: "actions", error: e.message });
    }
  };

  /** An action button was tapped (on the action screen or the guard's suggestion). */
  const choose = (type: PunchType, sess: Session) => {
    if (busy) return;
    const check = checkAction(sess.who.status, type);
    if (!check.ok) {
      return setScreen({ ...only(sess), k: "guard", message: check.message!, question: check.question ?? null, suggest: check.suggest ?? null });
    }
    if (!options.photo) {
      if (type === "in" && options.stations.length) return setScreen({ ...only(sess), k: "station", type, photo: undefined });
      return void send(type, sess, undefined, null);
    }
    // Photo at the moment of the tap. It must show a face: a blocked or covered
    // camera, or nobody in view, stops the punch with a message saying why.
    setBusy(true);
    void camera.capture().then((shot) => {
      setBusy(false);
      if (!shot.ok) return setScreen({ ...only(sess), k: "actions", error: shot.message });
      if (type === "in" && options.stations.length) return setScreen({ ...only(sess), k: "station", type, photo: shot.photo });
      void send(type, sess, shot.photo, null);
    });
  };

  const sendFix = async (sess: Session, v: FixInput) => {
    setBusy(true);
    try {
      await request("POST", "/api/kiosk/fix-requests", { ticket: sess.who.ticket, pin: sess.pin, employeeId: sess.who.employee.id, ...v });
      setBusy(false);
      setScreen({ k: "message", title: "Request sent", line: `Thanks, ${firstName(sess.who.employee.name)}. A manager will check it.` });
    } catch (err) {
      setBusy(false);
      const e = err as KioskError;
      if (e.code === "device") return unpair("This time clock was removed from the admin app.");
      if (e.offline) setOnline(false);
      setScreen({ ...only(sess), k: "fix", error: e.offline ? "No connection. Try again when the tablet is back online." : e.message });
    }
  };

  const ackNote = (s: Extract<Screen, { k: "notes" }>) => {
    const note = s.notes[s.i];
    void request("POST", `/api/kiosk/notes/${encodeURIComponent(note.id)}/ack`, s.auth).catch(() => undefined);
    if (s.i + 1 < s.notes.length) setScreen({ ...s, i: s.i + 1 });
    else setScreen({ k: "done", c: s.confirm });
  };

  const guarded = !!state.site.managerPinSet;
  // Device settings: behind the manager PIN when one is set (it needs a connection to check).
  const openSettings = () => {
    if (guarded && online) setScreen({ k: "manager", next: "settings" });
    else { setManagerPin(null); setShowInfo(true); }
  };
  const requestExitFullscreen = (exit: () => void) => {
    if (!guarded) return exit();
    exitFullscreen.current = exit;
    setScreen({ k: "manager", next: "exit" });
  };
  const submitManager = async (pin: string) => {
    if (screen.k !== "manager") return;
    try {
      await request("POST", "/api/kiosk/manager-unlock", { pin });
      if (screen.next === "settings") { setManagerPin(pin); setShowInfo(true); }
      else { exitFullscreen.current?.(); exitFullscreen.current = null; }
      home();
    } catch (err) {
      const e = err as KioskError;
      if (e.code === "device") return unpair("This time clock was removed from the admin app.");
      setScreen({ ...screen, error: e.offline ? "No connection. The manager PIN can't be checked right now." : e.message, shake: Date.now() });
    }
  };
  const closeInfo = () => { setShowInfo(false); setManagerPin(null); };
  const fullBleed = screen.k === "done";

  return (
    <div className="flex h-full flex-col bg-white">
      {!fullBleed && <TopBar state={state} online={online} pending={pending} onInfo={openSettings} onExitFullscreen={requestExitFullscreen} />}
      {notice && !fullBleed && (
        <button className="mx-auto mt-2 flex max-w-xl items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-left text-base text-amber-950 ring-2 ring-amber-300" onClick={() => setNotice(null)}>
          <span className="flex-1">{notice}</span><X className="h-5 w-5 shrink-0" />
        </button>
      )}
      <main className="kiosk-scroll flex min-h-0 flex-1 flex-col">
        {screen.k === "manager" ? (
          <PinScreen tz={tz} key={`manager-${screen.next}`} heading={{ title: "Manager PIN", sub: screen.next === "settings" ? "Enter the manager PIN to open device settings" : "Enter the manager PIN to leave full screen" }} maxLength={8} error={screen.error} shake={screen.shake} idleMs={Math.max(idleMs, 30_000)} onSubmit={submitManager} onBack={home} />
        ) : !state.site.enabled ? (
          <Centered>
            <BigClock tz={tz} />
            <p className="mt-10 text-2xl font-medium text-stone-800">The time clock is turned off for this location.</p>
            <p className="mt-2 max-w-xl text-lg text-stone-700">A manager can turn it on in Settings → Locations → Time clock.</p>
          </Centered>
        ) : screen.k === "home" ? (
          loginMode === "pin" ? (
            <PinScreen tz={tz} idleMs={idleMs} onSubmit={(pin) => identify(pin)} key="pin-home" />
          ) : (
            <NamesScreen tz={tz} employees={state.employees} onPick={(e) => setScreen({ k: "pin", employee: e })} />
          )
        ) : screen.k === "pin" ? (
          <PinScreen tz={tz} employee={screen.employee} error={screen.error} shake={screen.shake} idleMs={idleMs} onSubmit={(pin) => identify(pin, screen.employee)} onBack={home} />
        ) : screen.k === "actions" ? (
          <ActionsScreen
            tz={tz} who={screen.who} offline={screen.offline} error={screen.error} busy={busy} idleMs={idleMs}
            onPunch={(t) => choose(t, screen)} onCancel={home} onFix={screen.offline ? undefined : () => setScreen({ k: "fix", who: screen.who, pin: screen.pin, offline: screen.offline })}
          />
        ) : screen.k === "station" ? (
          <StationScreen name={screen.who.employee.name} stations={options.stations} idleMs={idleMs} onPick={(s) => { if (!busy) void send(screen.type, screen, screen.photo, s); }} onCancel={home} />
        ) : screen.k === "guard" ? (
          <GuardScreen name={screen.who.employee.name} message={screen.message} question={screen.question} suggest={screen.suggest} busy={busy} error={screen.error} idleMs={idleMs} onSuggest={(t) => choose(t, screen)} onCancel={home} />
        ) : screen.k === "fix" ? (
          <FixRequestScreen tz={tz} name={screen.who.employee.name} online={online} busy={busy} error={screen.error} idleMs={idleMs} onSubmit={(v) => void sendFix(screen, v)} onCancel={home} />
        ) : screen.k === "notes" ? (
          <NoteScreen key={screen.notes[screen.i].id} note={screen.notes[screen.i]} index={screen.i} total={screen.notes.length} tz={tz} idleMs={Math.max(idleMs, 30_000)} onOk={() => ackNote(screen)} onIdle={home} />
        ) : screen.k === "message" ? (
          <MessageScreen title={screen.title} line={screen.line} onDone={home} />
        ) : (
          <ConfirmScreen c={screen.c} tz={tz} onDone={home} />
        )}
      </main>
      {cameraOn && <CameraPreview attach={camera.attach} status={camera.status} faceSeen={camera.faceSeen} />}
      {showInfo && (
        <InfoSheet
          state={state} options={options} pending={pending} online={online} canUnpair={guarded && !!managerPin} guarded={guarded}
          idleMs={Math.max(idleMs, 20_000)}
          onClose={closeInfo} onSync={sync}
          onUnpair={async () => {
            // Revoke on the server first; only forget the pairing here once the server confirms.
            await request("POST", "/api/kiosk/unpair", { pin: managerPin }).catch((err: KioskError) => {
              if (err.code !== "device") throw err; // already removed on the server: fine
            });
            queue.save([]);
            closeInfo();
            unpair();
          }}
          onForget={() => {
            queue.save([]);
            closeInfo();
            unpair("This tablet forgot its pairing, but the device may still be listed in the admin app. Remove it in Settings → Locations → Time clock.");
          }}
        />
      )}
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
      <div className={`tabular font-light tracking-tight text-stone-950 ${compact ? "text-6xl sm:text-7xl" : "kiosk-clock-big text-7xl sm:text-8xl lg:text-9xl"}`} data-testid="kiosk-clock">
        {main}{period && <span className={`ml-2 font-normal text-stone-700 ${compact ? "text-2xl" : "text-3xl sm:text-4xl"}`}>{period}</span>}
      </div>
      <div className={`kiosk-date mt-2 font-medium text-stone-800 ${compact ? "text-lg" : "text-xl sm:text-2xl"}`}>{date}</div>
    </div>
  );
}

function TopBar({ state, online, pending, onInfo, onExitFullscreen }: { state: KioskState; online: boolean; pending: number; onInfo: () => void; onExitFullscreen: (exit: () => void) => void }) {
  const fs = useFullscreen();
  // Hidden in full screen, so staff using the clock don't leave it by accident.
  const apk = useAndroidAppDownload();
  return (
    <header className="flex items-center gap-3 px-5 pt-2 sm:px-8 sm:pt-4">
      <Mark className="h-[22px] w-auto shrink-0 text-[#7a295e]" aria-hidden />
      <span className="text-lg text-stone-600" aria-hidden>·</span>
      <span className="truncate text-lg font-semibold text-stone-800" data-testid="kiosk-location">{state.site.name}</span>
      <div className="-mr-4 ml-auto flex items-center gap-1">
        {apk && !fs.active && <AndroidAppButton url={apk} className="mr-1" />}
        {(!online || pending > 0) && (
          <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-base font-semibold ${online ? "bg-stone-100 text-stone-700" : "bg-amber-100 text-amber-950"}`} data-testid="kiosk-offline">
            {!online && <WifiOff className="h-4 w-4" />}
            {online ? `Sending ${pending}…` : pending ? `Offline · ${pending} saved` : "Offline"}
          </span>
        )}
        {fs.supported && (
          <button onClick={() => (fs.active ? onExitFullscreen(fs.toggle) : fs.toggle())} className="kiosk-tap flex w-16 items-center justify-center rounded-full text-stone-800 transition active:scale-95 active:bg-stone-200 [@media(hover:hover)]:hover:bg-stone-100" aria-label={fs.active ? "Exit full screen" : "Full screen"} data-testid="kiosk-fullscreen">
            {fs.active ? <Minimize className="h-6 w-6" /> : <Maximize className="h-6 w-6" />}
          </button>
        )}
        <button onClick={onInfo} className="kiosk-tap flex w-16 items-center justify-center rounded-full text-stone-800 transition active:scale-95 active:bg-stone-200 [@media(hover:hover)]:hover:bg-stone-100" aria-label="Device settings">
          <Settings2 className="h-6 w-6" />
        </button>
      </div>
    </header>
  );
}

/** Small live preview so people know a photo is taken with each punch, and whether their face is in view. */
function CameraPreview({ attach, status, faceSeen }: { attach: (el: HTMLVideoElement | null) => void; status: CameraStatus; faceSeen: boolean | null }) {
  const broken = status === "blocked" || status === "unavailable";
  const warn = broken || faceSeen === false;
  return (
    <div className={`pointer-events-none fixed bottom-4 left-4 z-40 flex items-center gap-3 rounded-2xl p-2 pr-4 shadow-lg ring-1 ${warn ? "bg-red-50 ring-red-300" : "bg-white/95 ring-stone-200"}`} data-testid="kiosk-camera" data-status={status} data-face={faceSeen === null ? "" : faceSeen ? "yes" : "no"}>
      {broken ? (
        <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-red-100 text-red-700"><CameraOff className="h-7 w-7" /></span>
      ) : (
        <video ref={attach} className={`h-16 w-16 -scale-x-100 rounded-xl bg-stone-200 object-cover ${faceSeen === false ? "ring-2 ring-red-400" : faceSeen ? "ring-2 ring-emerald-400" : ""}`} muted playsInline autoPlay />
      )}
      <span className={`text-sm font-medium ${warn ? "text-red-900" : "text-stone-700"}`}>
        {status === "blocked" ? <>Camera blocked<br /><span className="font-normal">Punching needs the camera</span></>
          : status === "unavailable" ? <>Camera not available<br /><span className="font-normal">Punching needs the camera</span></>
          : faceSeen === false ? <>Face not detected<br /><span className="font-normal">Look at the camera</span></>
          : <><Camera className="mr-1 inline h-4 w-4" />Photo taken<br />with your punch</>}
      </span>
    </div>
  );
}

function PinScreen({ tz, employee, heading, error, shake, maxLength = 6, idleMs, onSubmit, onBack }: { tz: string; employee?: RosterEmployee; heading?: { title: string; sub: string }; error?: string; shake?: number; maxLength?: number; idleMs: number; onSubmit: (pin: string) => Promise<void> | void; onBack?: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (shake) setPin(""); }, [shake]);
  useIdle(idleMs, () => { setPin(""); onBack?.(); }, [onBack]);

  const submit = useCallback(async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    try { await onSubmit(value); } finally { setBusy(false); setPin(""); }
  }, [busy, onSubmit]);
  const press = useCallback((d: string) => setPin((p) => (p.length >= maxLength ? p : p + d)), [maxLength]);
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
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-6 sm:gap-6 lg:flex-row lg:gap-24">
      <div className="text-center lg:text-left">
        {heading ? (
          <div className="kiosk-fade-up">
            <p className="text-4xl font-display font-normal tracking-[-0.01em] text-stone-950">{heading.title}</p>
            <p className="mt-1 text-xl text-stone-700">{heading.sub}</p>
          </div>
        ) : employee ? (
          <div className="kiosk-fade-up">
            <Avatar name={employee.name} big />
            <p className="mt-4 text-4xl font-display font-normal tracking-[-0.01em] text-stone-950">Hi, {firstName(employee.name)}</p>
            <p className="mt-1 text-xl text-stone-700">Enter your PIN, then tap <Check className="inline h-5 w-5 align-[-0.15em]" strokeWidth={2.75} aria-label="the check mark" /></p>
          </div>
        ) : (
          <>
            <BigClock tz={tz} />
            <p className="kiosk-prompt mt-4 text-xl font-medium text-stone-700 [text-wrap:balance] sm:mt-6 sm:text-2xl lg:mt-10">Enter your PIN, then tap <Check className="inline h-6 w-6 align-[-0.15em]" strokeWidth={2.75} aria-label="the check mark" /> to clock in or out</p>
          </>
        )}
      </div>
      <div className="flex flex-col items-center">
        <div key={shake} className={`flex h-10 items-center gap-4 ${shake ? "kiosk-shake" : ""}`} aria-label={`${pin.length} digits entered`} data-testid="kiosk-pin-dots">
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
            <span key={i} className={`h-5 w-5 rounded-full transition-all duration-150 ${i < pin.length ? "scale-110 bg-[#7a295e]" : "bg-stone-300"}`} />
          ))}
        </div>
        {/* Once a PIN could be complete, say what to do next: PINs are 4 to 6 digits, so it can't send itself. */}
        <p className={`mt-2 min-h-7 text-lg font-medium ${error ? "text-red-700" : pin.length >= 4 && !busy ? "text-stone-700" : "text-transparent"}`} role={error ? "alert" : undefined} aria-live="polite" data-testid="kiosk-pin-hint">{error || (pin.length >= 4 && !busy ? "Tap the check mark to continue" : "·")}</p>
        <div className="mt-3 grid grid-cols-3 gap-3 sm:gap-5">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <Key key={d} onPress={() => press(d)} label={d} />)}
          {onBack && employee ? <Key onPress={onBack} label={<ArrowLeft className="h-8 w-8" />} subtle aria="Back" /> : <Key onPress={back} label={<Delete className="h-8 w-8" />} subtle aria="Delete" />}
          <Key onPress={() => press("0")} label="0" />
          <Key onPress={() => void submit(pin)} label={busy ? <Spinner /> : <Check className="h-9 w-9" strokeWidth={2.5} />} primary disabled={pin.length < 4 || busy} aria="OK" />
        </div>
        {onBack && employee && pin.length > 0 && <button className="kiosk-tap mt-3 rounded-2xl px-6 text-lg font-medium text-stone-800 active:bg-stone-100" onClick={back}>Delete last digit</button>}
        {onBack && !employee && <BigSecondary className="mt-4" onClick={onBack}>Cancel</BigSecondary>}
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
      className={`kiosk-tap kiosk-key flex h-20 w-20 items-center justify-center rounded-full text-4xl font-normal transition-all duration-100 active:scale-95 sm:h-28 sm:w-28 sm:text-5xl ${
        primary ? "kiosk-primary kiosk-go shadow-sm disabled:shadow-none" : subtle ? "text-stone-800 active:bg-stone-200" : "bg-stone-100 text-stone-950 ring-2 ring-stone-200 active:bg-stone-300 active:ring-stone-300"
      }`}
      data-testid={`kiosk-key-${aria ?? label}`}
    >
      {label}
    </button>
  );
}

function Spinner() {
  return <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />;
}

function Avatar({ name, big, status }: { name: string; big?: boolean; status?: ClockStatus }) {
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full bg-stone-200 font-semibold text-stone-800 ${big ? "h-24 w-24 text-3xl" : "h-14 w-14 text-lg"}`}>
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
          <label className="flex w-full max-w-xs items-center gap-2 rounded-2xl bg-stone-100 px-4 py-4 text-xl ring-2 ring-stone-200">
            <Search className="h-6 w-6 text-stone-600" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find your name" className="w-full bg-transparent outline-none placeholder:text-stone-600" />
          </label>
        )}
      </div>
      <p className="mb-3 text-xl font-medium text-stone-700">Tap your name</p>
      {employees.length === 0 ? (
        <p className="mt-10 text-center text-xl text-stone-600">No employees are set up yet. A manager can add them in the admin app under Employees.</p>
      ) : (
        <div className="-mx-1 -mt-1 grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto px-1 pb-4 pt-1 min-[440px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((e) => (
            <button key={e.id} onClick={() => onPick(e)} className="kiosk-tap flex min-h-24 min-w-0 items-center gap-3 rounded-3xl bg-stone-50 p-3 text-left ring-2 ring-stone-200 transition active:scale-[0.98] active:bg-stone-200 sm:gap-4 sm:p-4" data-testid={`kiosk-name-${e.id}`}>
              <Avatar name={e.name} status={e.status} />
              {/* Names wrap (never cut off): people must recognise their own name. */}
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-semibold leading-tight text-stone-950 [overflow-wrap:anywhere] sm:text-xl">{e.name}</span>
                <span className="mt-0.5 block text-sm leading-snug text-stone-700 [overflow-wrap:anywhere] sm:text-base">{e.status === "out" ? e.role || STATUS_TEXT.out : `${STATUS_TEXT[e.status]}${e.since ? ` since ${timeOf(e.since, tz)}` : ""}`}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionsScreen({ tz, who, offline, error, busy, idleMs, onPunch, onCancel, onFix }: { tz: string; who: Identified; offline: boolean; error?: string; busy?: boolean; idleMs: number; onPunch: (t: PunchType) => void; onCancel: () => void; onFix?: () => void }) {
  useIdle(idleMs, onCancel);
  const statusLine = who.status === "out" ? "You're not clocked in" : `${STATUS_TEXT[who.status]} since ${who.since ? timeOf(who.since, tz) : "—"}`;
  const breakDue = !offline && who.status === "in" && !!who.breakDue;
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10 text-center kiosk-fade-up">
      <Avatar name={who.employee.name} big status={who.status} />
      <h1 className="mt-5 max-w-full text-4xl font-display font-normal tracking-[-0.01em] text-stone-950 [overflow-wrap:anywhere] sm:text-5xl" data-testid="kiosk-employee-name">{who.employee.name}</h1>
      <p className="mt-2 text-2xl text-stone-700">
        {statusLine}{!offline && who.todayMinutes > 0 ? ` · ${duration(who.todayMinutes)} today` : ""}{!offline && who.station && who.status !== "out" ? ` · ${who.station}` : ""}
      </p>
      {offline && <p className="mt-3 rounded-full bg-amber-100 px-5 py-2 text-lg font-medium text-amber-950"><WifiOff className="mr-1.5 inline h-5 w-5" />Offline: your punch will be saved on this tablet</p>}
      {breakDue && <div className="mt-4"><BreakNudge minutes={who.minutesWithoutBreak ?? 0} /></div>}
      <div className="mt-8 grid w-full max-w-3xl gap-4 sm:grid-cols-2">
        {who.actions.map((a) => {
          const st = ACTION_STYLE[a];
          return (
            <button key={a} disabled={busy} onClick={() => onPunch(a)} className={`kiosk-tap flex h-32 items-center justify-center gap-4 rounded-3xl text-3xl font-bold shadow-md transition active:scale-[0.98] disabled:opacity-60 sm:h-40 sm:text-4xl ${st.cls} ${who.actions.length === 1 ? "sm:col-span-2" : ""} ${breakDue && a === "break_start" ? "kiosk-pulse ring-4 ring-amber-500" : ""}`} data-testid={`kiosk-action-${a}`}>
              {busy ? <Spinner /> : <st.icon className="h-10 w-10" />}{PUNCH_LABELS[a]}
            </button>
          );
        })}
      </div>
      <p className={`mt-5 min-h-7 text-xl font-medium ${error ? "text-red-700" : "text-transparent"}`} role="alert">{error || "·"}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        {onFix && <BigSecondary onClick={onFix} testid="kiosk-fix-open"><Wrench className="mr-2 inline h-5 w-5" />Fix a missed punch</BigSecondary>}
        <BigSecondary onClick={onCancel}>Cancel</BigSecondary>
      </div>
    </div>
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
  const apk = useAndroidAppDownload();
  return (
    <Centered>
      {apk && <div className="fixed right-4 top-3 z-10"><AndroidAppButton url={apk} /></div>}
      <div className="w-full max-w-md kiosk-fade-up">
        <h1 className="text-4xl font-display font-normal tracking-[-0.01em] text-stone-950">Set up this time clock</h1>
        <p className="mt-3 text-lg text-stone-700">In the admin app, open <b className="font-semibold text-stone-900">Settings → Locations → Time clock</b>, add a device, then open its pairing link here or type its code.</p>
        {notice && <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-amber-950 ring-2 ring-amber-200">{notice}</p>}
        <form className="mt-8 space-y-4" onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 8) void submit(); }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9))}
            placeholder="ABCD-1234"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-2xl bg-stone-100 px-5 py-4 kiosk-field text-center font-mono text-3xl tracking-[0.2em] text-stone-950 outline-none ring-2 ring-stone-300 placeholder:text-stone-600"
            data-testid="kiosk-pair-code"
          />
          {error && <p className="text-lg font-medium text-red-700" role="alert">{error}</p>}
          <button disabled={busy || code.replace(/-/g, "").length < 8} className="kiosk-tap kiosk-primary h-16 w-full rounded-2xl text-xl font-bold transition active:scale-[0.99]" data-testid="kiosk-pair-submit">
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
      {online ? <span className="h-10 w-10 animate-spin rounded-full border-2 border-stone-200 border-t-[#7a295e]" /> : (
        <>
          <WifiOff className="h-10 w-10 text-stone-600" />
          <p className="mt-4 text-xl text-stone-700">Can't reach the server.</p>
          <BigSecondary className="mt-6" onClick={onRetry}>Try again</BigSecondary>
        </>
      )}
    </Centered>
  );
}

function InfoSheet({ state, options, pending, online, canUnpair, guarded, idleMs, onClose, onSync, onUnpair, onForget }: {
  state: KioskState; options: KioskOptions; pending: number; online: boolean; canUnpair: boolean; guarded: boolean; idleMs: number;
  onClose: () => void; onSync: () => void; onUnpair: () => Promise<void>; onForget: () => void;
}) {
  // An unlocked sheet must not stay open for the next person who walks up.
  useIdle(idleMs, onClose);
  const [busy, setBusy] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  const unpairNow = async () => {
    if (!window.confirm(pending ? `${pending} punches have not been sent yet and will be lost. Unpair anyway?` : "Unpair this device? You'll need a new pairing code from the admin app.")) return;
    setBusy(true); setUnpairError(null);
    try { await onUnpair(); } catch (err) {
      const e = err as KioskError;
      setUnpairError(e.offline ? "No connection, so the server still has this device." : `The server didn't remove this device: ${e.message}`);
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl kiosk-fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-stone-950">{state.device.name}</h2>
            <p className="text-stone-700">{state.site.name} · {state.site.timezone}</p>
          </div>
          <button onClick={onClose} className="kiosk-tap -mr-2 -mt-2 flex w-16 items-center justify-center rounded-full text-stone-700 hover:bg-stone-100 active:bg-stone-200" aria-label="Close"><X className="h-6 w-6" /></button>
        </div>
        <dl className="mt-5 space-y-2 text-lg">
          <div className="flex justify-between"><dt className="text-stone-600">Connection</dt><dd>{online ? "Online" : "Offline"}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-600">Punches waiting to send</dt><dd className="tabular">{pending}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-600">Sign-in</dt><dd>{state.site.loginMode === "pin" ? "PIN" : "Name, then PIN"}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-600">Photo with each punch</dt><dd>{options.photo ? "On" : "Off"}</dd></div>
          <div className="flex justify-between"><dt className="text-stone-600">Back to start after</dt><dd>{options.idleSeconds} seconds</dd></div>
          {options.stations.length > 0 && <div className="flex justify-between gap-4"><dt className="text-stone-600">Stations</dt><dd className="truncate">{options.stations.join(", ")}</dd></div>}
        </dl>
        <p className="mt-3 text-base text-stone-600">These options are changed in the admin app: Settings → Locations → Time clock.</p>
        <div className="mt-6 grid gap-3">
          {pending > 0 && <button onClick={onSync} className="kiosk-tap kiosk-primary rounded-2xl text-lg font-semibold transition active:scale-[0.99]">Send now</button>}
          {!guarded && (
            <p className="rounded-2xl bg-amber-50 px-4 py-3 text-base font-medium text-amber-950 ring-2 ring-amber-300" role="status" data-testid="kiosk-no-manager-pin">
              No manager PIN is set, so anyone can open this screen and leave full screen. Unpairing is only possible from the admin app until a PIN is set: Settings → Locations → Time clock.
            </p>
          )}
          {guarded && !canUnpair && (
            <p className="rounded-2xl bg-stone-50 px-4 py-3 text-base text-stone-700">Unpairing needs the manager PIN, which needs a connection. Try again when online.</p>
          )}
          {canUnpair && <button onClick={() => void unpairNow()} disabled={busy} className="kiosk-tap rounded-2xl text-lg font-semibold text-red-700 ring-2 ring-red-300 transition active:bg-red-50 disabled:opacity-60">
            {busy ? "Unpairing…" : "Unpair this device"}
          </button>}
          {unpairError && (
            <div className="space-y-2 rounded-2xl bg-red-50 px-4 py-3 text-base text-red-900 ring-2 ring-red-200" role="alert">
              <p className="font-medium">{unpairError}</p>
              <p>This tablet is still paired. You can try again, or forget the pairing on this tablet only; then remove the device in the admin app (Settings → Locations → Time clock) so its old pairing stops working.</p>
              <button onClick={() => { if (window.confirm("Forget the pairing on this tablet only? Punches not yet sent will be lost.")) onForget(); }} className="kiosk-tap h-12 w-full rounded-xl bg-white font-semibold text-red-700 ring-2 ring-red-200" data-testid="kiosk-forget-anyway">
                Forget on this device anyway
              </button>
            </div>
          )}
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
