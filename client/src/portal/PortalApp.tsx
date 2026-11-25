// Employee self-service portal (/me): sign in with location, name and PIN,
// then Hours / Pay / Schedule / Time off in bottom tabs. Phone-first.
import { useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarOff, ChevronLeft, Clock, Loader2, LogOut, MapPin, Wallet } from "lucide-react";
import { safeStorage } from "@/lib/storage";
import { type Me, type PortalSite, PortalError, call, onSignedOut, useLoad } from "./api";
import { HoursTab, PayTab, ScheduleTab, TimeOffTab } from "./tabs";
import { firstName } from "./format";

const SITE_KEY = "portal.site";
const NAME_KEY = "portal.name";
const TAB_KEY = "portal.tab";

type Tab = "hours" | "pay" | "schedule" | "timeoff";
const TABS: { id: Tab; label: string; icon: typeof Clock }[] = [
  { id: "hours", label: "Hours", icon: Clock },
  { id: "pay", label: "Pay", icon: Wallet },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "timeoff", label: "Time off", icon: CalendarOff },
];

export function PortalApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const loadMe = async () => {
    try { setMe(await call<Me>("GET", "/api/portal/me")); } catch { setMe(null); } finally { setChecked(true); }
  };
  useEffect(() => { void loadMe(); }, []);
  useEffect(() => onSignedOut(() => setMe(null)), []);

  if (!checked) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-neutral-400" /></div>;
  if (!me) return <SignIn onSignedIn={loadMe} />;
  return <Home me={me} onSignOut={() => setMe(null)} />;
}

// ── Sign in ──────────────────────────────────────────────────────────────────
function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const sites = useLoad<PortalSite[]>("/api/portal/sites");
  const [siteId, setSiteId] = useState<string | null>(() => safeStorage.get(SITE_KEY));
  const [name, setName] = useState(() => safeStorage.get(NAME_KEY) ?? "");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const pinRef = useRef<HTMLInputElement>(null);

  const list = sites.data ?? [];
  const site = list.find((s) => s.id === siteId) ?? (list.length === 1 ? list[0] : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!site || busy) return;
    if (!name.trim()) { setError("Enter your name."); return; }
    if (!/^\d{4,6}$/.test(pin)) { setError("Your PIN is 4 to 6 digits."); setShake((n) => n + 1); return; }
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/api/portal/login", { siteId: site.id, name: name.trim(), pin });
      safeStorage.set(SITE_KEY, site.id);
      safeStorage.set(NAME_KEY, name.trim());
      setPin("");
      await onSignedIn();
    } catch (err) {
      setError(err instanceof PortalError ? err.message : "Couldn't sign in. Try again.");
      setPin("");
      setShake((n) => n + 1);
      pinRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="pt-safe mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10" data-testid="portal-signin">
      <div className="pt-14 pb-8">
        <p className="text-[15px] font-medium text-neutral-500">Employee</p>
        <h1 className="mt-1 text-[34px] font-bold leading-tight tracking-tight">My work</h1>
        <p className="mt-2 text-[17px] text-neutral-600">Your hours, pay, schedule and time off.</p>
      </div>

      {sites.loading && !sites.data ? (
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
      ) : sites.error ? (
        <Notice text={sites.error} action={<button type="button" onClick={sites.reload} className="portal-tap font-semibold text-sky-700">Try again</button>} />
      ) : !list.length ? (
        <Notice text="The employee portal isn't turned on yet. Ask your manager." />
      ) : !site ? (
        <section className="portal-fade-up" data-testid="portal-pick-site">
          <h2 className="mb-3 text-[20px] font-semibold">Where do you work?</h2>
          <ul className="space-y-3">
            {list.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setSiteId(s.id)} className="portal-tap flex min-h-16 w-full items-center gap-3 rounded-2xl bg-neutral-100 px-5 text-left text-[19px] font-semibold active:bg-neutral-200" data-testid={`portal-site-${s.id}`}>
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} />{s.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <form onSubmit={submit} className="portal-fade-up space-y-5" noValidate>
          {list.length > 1 && (
            <button type="button" onClick={() => { setSiteId(null); setError(null); }} className="portal-tap -ml-1 inline-flex items-center gap-1 text-[15px] font-medium text-sky-700" data-testid="portal-change-site">
              <ChevronLeft className="h-4 w-4" /><MapPin className="h-4 w-4" />{site.name}
            </button>
          )}
          {list.length === 1 && <p className="inline-flex items-center gap-1.5 text-[15px] text-neutral-500"><MapPin className="h-4 w-4" />{site.name}</p>}
          <label className="block">
            <span className="mb-2 block text-[15px] font-semibold text-neutral-700">Your name</span>
            <input
              value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={80} placeholder="e.g. Ana Ruiz"
              className="portal-input h-14 w-full rounded-2xl bg-neutral-100 px-4 text-[19px] outline-none placeholder:text-neutral-400" data-testid="portal-name"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-[15px] font-semibold text-neutral-700">PIN</span>
            <input
              ref={pinRef} key={shake} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="current-password" placeholder="Your time clock PIN"
              className={`portal-input tabular h-14 w-full rounded-2xl bg-neutral-100 px-4 text-[22px] tracking-[0.3em] outline-none placeholder:text-[17px] placeholder:tracking-normal placeholder:text-neutral-400 ${shake ? "portal-shake" : ""}`} data-testid="portal-pin"
            />
          </label>
          {error && <p role="alert" className="text-[16px] font-medium text-red-700" data-testid="portal-error">{error}</p>}
          <button type="submit" disabled={busy} className="portal-tap flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-neutral-900 text-[18px] font-semibold text-white active:bg-neutral-700 disabled:opacity-60" data-testid="portal-signin-button">
            {busy && <Loader2 className="h-5 w-5 animate-spin" />}Sign in
          </button>
          <p className="text-center text-[14px] text-neutral-500">Use the same PIN as the time clock. Forgot it? Ask your manager.</p>
        </form>
      )}
    </main>
  );
}

function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-neutral-100 px-5 py-4 text-[17px] text-neutral-700" data-testid="portal-notice">
      <p>{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── Signed in ────────────────────────────────────────────────────────────────
function Home({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [tab, setTabState] = useState<Tab>(() => {
    const t = safeStorage.get(TAB_KEY);
    return TABS.some((x) => x.id === t) ? (t as Tab) : "hours";
  });
  const setTab = (t: Tab) => { setTabState(t); safeStorage.set(TAB_KEY, t); window.scrollTo({ top: 0 }); };
  const [leaving, setLeaving] = useState(false);

  const signOut = async () => {
    setLeaving(true);
    try { await call("POST", "/api/portal/logout"); } catch { /* signed out here anyway */ }
    onSignOut();
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="pt-safe sticky top-0 z-20 border-b border-neutral-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-neutral-500"><span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: me.site.color }} />{me.site.name}</p>
            <p className="truncate text-[17px] font-semibold" data-testid="portal-greeting">Hi, {firstName(me.employee.name)}</p>
          </div>
          <button type="button" onClick={signOut} disabled={leaving} className="portal-tap inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[15px] font-medium text-neutral-700 active:bg-neutral-100" data-testid="portal-signout">
            {leaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-5 pb-32 pt-5">
        {tab === "hours" && <HoursTab me={me} />}
        {tab === "pay" && <PayTab me={me} />}
        {tab === "schedule" && <ScheduleTab me={me} />}
        {tab === "timeoff" && <TimeOffTab me={me} />}
      </main>

      <nav className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200/80 bg-white/95 backdrop-blur" aria-label="Sections">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button" onClick={() => setTab(t.id)} aria-current={on ? "page" : undefined}
                  className={`portal-tap flex h-16 w-full flex-col items-center justify-center gap-1 text-[12px] font-semibold ${on ? "text-sky-700" : "text-neutral-500"}`}
                  data-testid={`portal-tab-${t.id}`}
                >
                  <t.icon className="h-6 w-6" strokeWidth={on ? 2.3 : 1.8} />{t.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
