// Employee self-service portal (/me): sign in with location, name and PIN,
// then Hours / Pay / Schedule / Time off in bottom tabs. Phone-first.
import { useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarOff, ChevronLeft, Clock, Loader2, LogOut, MapPin, Wallet } from "lucide-react";
import { safeStorage } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type Me, type PortalSite, PortalError, call, onSignedOut, useLoad } from "./api";
import { HoursTab, PayTab, ScheduleTab, TimeOffTab } from "./tabs";
import { firstName } from "./format";
import { BrandPanel } from "@/components/BrandPanel";
import { Mark } from "@/components/Logo";

const SITE_KEY = "portal.site";
const NAME_KEY = "portal.name";
const TAB_KEY = "portal.tab";

type Tab = "hours" | "pay" | "schedule" | "timeoff";
const TABS: { id: Tab; label: string; icon: typeof Clock }[] = [
  { id: "hours", label: "My hours", icon: Clock },
  { id: "pay", label: "My pay", icon: Wallet },
  { id: "schedule", label: "My schedule", icon: CalendarDays },
  { id: "timeoff", label: "My time off", icon: CalendarOff },
];

export function PortalApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const loadMe = async () => {
    try { setMe(await call<Me>("GET", "/api/portal/me")); } catch { setMe(null); } finally { setChecked(true); }
  };
  useEffect(() => { void loadMe(); }, []);
  useEffect(() => onSignedOut(() => setMe(null)), []);

  if (!checked) return <div className="flex min-h-screen items-center justify-center" aria-busy="true"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>;
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

  const fieldCls = "h-12 w-full rounded-[10px] border border-input bg-card px-[14px] text-[15px] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:shadow-[0_0_0_3px_hsl(var(--ring)/0.22)]";
  const labelCls = "mb-[7px] block text-[13px] font-semibold text-foreground";

  return (
    <div className="grid min-h-dvh grid-cols-1 grid-rows-[auto_1fr] bg-card dark:bg-background min-[861px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[861px]:grid-rows-1" data-testid="portal-signin">
      <BrandPanel />
      <main className="flex flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-7 min-[861px]:px-12 min-[861px]:py-8">
        <div className="mx-auto w-full max-w-[380px] min-[861px]:my-auto">
          <h1 className="font-display text-[30px] font-normal leading-[1.1] tracking-[-0.012em] min-[861px]:text-[36px]">Hi there</h1>
          <p className="mb-6 mt-2.5 text-[15px] leading-[22px] text-muted-foreground min-[861px]:mb-8">Sign in to see your shifts and pay.</p>

          {sites.loading && !sites.data ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-12 w-full rounded-[10px]" />
              <Skeleton className="h-12 w-full rounded-[10px]" />
            </div>
          ) : sites.error ? (
            <Notice text={sites.error} action={<Button type="button" variant="link" onClick={sites.reload} className="portal-tap text-[15px] font-semibold">Try again</Button>} />
          ) : !list.length ? (
            <Notice text="The employee portal isn't turned on yet. Ask your manager to turn it on." />
          ) : !site ? (
            <section className="portal-fade-up" data-testid="portal-pick-site">
              <h2 className="mb-3 text-[15px] font-semibold">Where do you work?</h2>
              <ul className="space-y-2.5">
                {list.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => setSiteId(s.id)} className="portal-tap flex min-h-12 w-full items-center gap-3 rounded-[10px] border border-input bg-card px-[14px] text-left text-[15px] font-semibold transition-colors hover:bg-accent active:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" data-testid={`portal-site-${s.id}`}>
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color }} /><span className="min-w-0 flex-1 break-words">{s.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <form onSubmit={submit} className="portal-fade-up space-y-[18px]" noValidate>
              {list.length > 1 && (
                <button type="button" onClick={() => { setSiteId(null); setError(null); }} className="portal-tap -ml-1 inline-flex min-h-10 max-w-full items-center gap-1 rounded-md text-[13.5px] font-semibold text-primary hover:underline underline-offset-4" data-testid="portal-change-site">
                  <ChevronLeft className="h-4 w-4 shrink-0" /><MapPin className="h-4 w-4 shrink-0" /><span className="truncate">{site.name}</span>
                </button>
              )}
              {list.length === 1 && <p className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground"><MapPin className="h-4 w-4 shrink-0" /><span className="truncate">{site.name}</span></p>}
              <label className="block">
                <span className={labelCls}>Your name</span>
                <input
                  value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={80} placeholder="e.g. Ana Ruiz"
                  className={`portal-input ${fieldCls}`} data-testid="portal-name"
                />
              </label>
              <label className="block">
                <span className={labelCls}>PIN</span>
                <input
                  ref={pinRef} key={shake} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="current-password" placeholder="Your time clock PIN"
                  aria-invalid={error ? true : undefined}
                  className={`portal-input tabular ${fieldCls} aria-[invalid=true]:border-danger ${shake ? "portal-shake" : ""}`} data-testid="portal-pin"
                />
                <p className="mt-[7px] text-[12.5px] leading-[18px] text-muted-foreground">Same PIN as the time clock. Forgot it? Ask your manager.</p>
              </label>
              {error && <p role="alert" className="rounded-[10px] bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium leading-[18px] text-danger" data-testid="portal-error">{error}</p>}
              <Button type="submit" size="lg" disabled={busy} className="portal-tap mt-1.5 h-12 w-full rounded-[10px] text-[15px] font-semibold [&_svg]:size-5" data-testid="portal-signin-button">
                {busy && <Loader2 className="animate-spin" />}{busy ? "Signing in" : "Sign in"}
              </Button>
            </form>
          )}

          <div className="mb-4 mt-7 flex items-center gap-3 text-[12.5px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">Or</div>
          <a href="/kiosk" className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-input bg-card text-[13.5px] font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" data-testid="portal-link-kiosk"><Clock className="h-4 w-4 text-muted-foreground" />Time clock</a>
        </div>
        <div className="mt-8 flex flex-col gap-1 text-xs text-muted-foreground min-[861px]:mt-0 min-[861px]:flex-row min-[861px]:justify-between">
          <span>Shijiri Group</span>
          <span>Your data stays on your own server.</span>
        </div>
      </main>
    </div>
  );
}

function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-card-border bg-card px-5 py-4 text-[16px] leading-relaxed shadow-card" data-testid="portal-notice">
      <p>{text}</p>
      {action && <div className="mt-1">{action}</div>}
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
    <div className="min-h-screen">
      <header className="pt-safe glass sticky top-0 z-20 border-b border-border/70">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Mark aria-hidden aria-label={undefined} role="presentation" className="h-6 w-auto shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate font-display text-[22px] font-normal leading-tight" data-testid="portal-greeting">Hi, {firstName(me.employee.name)}</p>
              <p className="truncate text-[13px] text-muted-foreground"><span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: me.site.color }} aria-hidden />{me.employee.name} · {me.site.name}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" onClick={signOut} disabled={leaving} className="portal-tap h-10 shrink-0 rounded-full px-3 text-[15px]" data-testid="portal-signout">
            {leaving ? <Loader2 className="animate-spin" /> : <LogOut />}Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-5 pb-32 pt-5">
        {tab === "hours" && <HoursTab me={me} />}
        {tab === "pay" && <PayTab me={me} />}
        {tab === "schedule" && <ScheduleTab me={me} />}
        {tab === "timeoff" && <TimeOffTab me={me} />}
      </main>

      <nav className="pb-safe glass fixed inset-x-0 bottom-0 z-20 border-t border-border/70" aria-label="Sections">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button" onClick={() => setTab(t.id)} aria-current={on ? "page" : undefined}
                  className={`portal-tap flex h-16 w-full flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-semibold transition-colors ${on ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
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
