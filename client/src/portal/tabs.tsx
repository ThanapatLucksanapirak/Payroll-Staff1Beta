// The four portal tabs. Every number here comes from the server already
// filtered to the signed-in employee.
import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Coffee, Download, Loader2, Timer } from "lucide-react";
import { addDays, todayISO } from "@shared/dates";
import type { PortalDay } from "@shared/portal";
import { prefsSchema, siteSchema } from "@shared/schema";
import { downloadBlob, safeFilename } from "@/lib/doc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type HoursData, type Me, type ScheduleData, type StatementData, type StatementItem, type TimeOffItem, PortalError, call, useLoad } from "./api";
import { clock, dayLabel, hm, minutesClock, money, range, shortDate } from "./format";

// ── Building blocks ──────────────────────────────────────────────────────────
function Title({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.022em]">{children}</h1>
      {sub && <p className="tabular mt-1 text-[16px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** A list card shared by every tab. */
const LIST = "divide-y divide-border overflow-hidden rounded-2xl border border-card-border bg-card shadow-card";
/** A quiet information note (not a warning). */
const NOTE = "rounded-xl bg-secondary px-5 py-3.5 text-[15px] leading-relaxed text-secondary-foreground";

/** Placeholder rows shaped like a list card while it loads. */
function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className={LIST} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-5 py-4">
          <span className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3.5 w-24" /></span>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

function ErrorBox({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className="rounded-xl bg-danger-soft px-5 py-4 text-[16px] text-danger" role="alert">
      <p>{text}</p>
      <button type="button" onClick={retry} className="portal-tap mt-1 min-h-10 rounded-md font-semibold underline-offset-4 hover:underline">Try again</button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-[16px] leading-relaxed text-muted-foreground">{text}</p>;
}

type Tone = "green" | "amber" | "blue" | "grey" | "red";
const TONES: Record<Tone, string> = {
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  blue: "bg-info-soft text-info",
  grey: "bg-neutral-soft text-neutral",
  red: "bg-danger-soft text-danger",
};
function Pill({ tone, children, testid }: { tone: Tone; children: React.ReactNode; testid?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold ${TONES[tone]}`} data-testid={testid}>{children}</span>;
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="mb-5 grid auto-cols-fr grid-flow-col gap-0.5 rounded-xl bg-foreground/[0.06] p-[3px]" role="tablist">
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={`portal-tap h-10 rounded-[9px] text-[15px] font-semibold transition-colors ${value === o.id ? "bg-segment text-foreground shadow-segment" : "text-muted-foreground hover:text-foreground"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Hours ────────────────────────────────────────────────────────────────────
const DAY_STATUS: Record<PortalDay["status"], { tone: Tone; label: string }> = {
  working: { tone: "blue", label: "Working now" },
  break: { tone: "amber", label: "On break now" },
  flagged: { tone: "amber", label: "Being checked" },
  approved: { tone: "green", label: "Approved" },
  worked: { tone: "grey", label: "Worked" },
};

export function HoursTab({ me }: { me: Me }) {
  const [offset, setOffset] = useState(0);
  const q = useLoad<HoursData>(`/api/portal/hours?offset=${offset}`);
  const d = q.data;
  // No time-clock days, but a finalized timesheet covers this period (hours from Square or a
  // spreadsheet): show those hours, so the page doesn't say zero next to a paid statement.
  const sheets = d?.timesheets ?? [];
  const fromSheets = !!d && !d.days.length && sheets.length > 0;
  const sheetMinutes = sheets.reduce((a, t) => a + t.minutes, 0);
  return (
    <section data-testid="portal-hours">
      <Title sub={d ? range(d.period.start, d.period.end) : " "}>My hours</Title>
      <Segmented value={offset} onChange={setOffset} options={[{ id: 0, label: "This pay period" }, { id: -1, label: "Last period" }]} />
      {!me.site.timeClock && <p className={`mb-4 ${NOTE}`}>{me.site.name} doesn't use the time clock, so hours may not show here.</p>}
      {q.error && !d ? <ErrorBox text={q.error} retry={q.reload} /> : !d || (q.loading && d.offset !== offset) ? <Loading /> : (
        <>
          <div className="mb-6 rounded-2xl border border-card-border bg-card px-5 py-5 shadow-card">
            <p className="text-[15px] font-medium text-muted-foreground">{fromSheets ? "Total on your pay statement" : offset === 0 ? "Total so far" : "Total"}</p>
            <p className="tabular mt-1.5 text-[40px] font-bold leading-none tracking-[-0.022em]" data-testid="portal-hours-total">{hm(fromSheets ? sheetMinutes : d.totalMinutes)}</p>
            {d.status !== "out" && d.since && offset === 0 && (
              <p className="tabular mt-3 inline-flex items-center gap-1.5 text-[16px] font-medium text-primary">
                {d.status === "break" ? <Coffee className="h-4 w-4" /> : <Timer className="h-4 w-4" />}
                {d.status === "break" ? "On a break since" : "Clocked in since"} {clock(d.since, me)}
              </p>
            )}
          </div>
          {fromSheets ? (
            <ul className={LIST} data-testid="portal-hours-timesheets">
              {sheets.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-3 px-5 py-4">
                  <span className="min-w-0">
                    <span className="block text-[18px] font-semibold">{range(t.periodStart, t.periodEnd)}</span>
                    <span className="block text-[14px] text-muted-foreground">{t.partial ? "From your pay statement, days in this period only" : "From your pay statement"}</span>
                  </span>
                  <span className="tabular shrink-0 text-[20px] font-semibold">{hm(t.minutes)}</span>
                </li>
              ))}
            </ul>
          ) : !d.days.length ? <Empty text={offset === 0 ? "No time clock hours yet this period. Clock in at the time clock and your days show up here." : "No time clock hours in this period. If your hours were sent in another way, they're on your pay statement under My pay."} /> : (
            <ul className={LIST}>
              {d.days.map((day) => {
                const st = DAY_STATUS[day.status];
                return (
                  <li key={day.date} className="px-5 py-4" data-testid={`portal-day-${day.date}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[18px] font-semibold">{dayLabel(day.date)}</span>
                      <span className="tabular text-[20px] font-semibold">{hm(day.workedMinutes)}</span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-[15px] text-muted-foreground">
                      {day.shifts.map((s) => (
                        <p key={s.in} className="tabular">
                          {clock(s.in, me)} – {s.out ? clock(s.out, me) : "now"}
                          {s.breakMinutes > 0 && <span> · {hm(s.breakMinutes)} break</span>}
                        </p>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Pill tone={st.tone} testid={`portal-day-status-${day.date}`}>{day.status === "approved" && <CheckCircle2 className="h-3.5 w-3.5" />}{day.status === "flagged" && <AlertTriangle className="h-3.5 w-3.5" />}{st.label}</Pill>
                      {day.status === "flagged" && day.note && <span className="text-[14px] text-muted-foreground">{day.note}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-4 px-1 text-[14px] leading-relaxed text-muted-foreground">{fromSheets ? "These hours come from your finalized pay statement. Day-by-day times show here only for shifts on the time clock." : "Hours from the time clock. Your pay statement has the final numbers."} Something wrong? Tell your manager.</p>
        </>
      )}
    </section>
  );
}

// ── Pay ──────────────────────────────────────────────────────────────────────
export function PayTab({ me }: { me: Me }) {
  const q = useLoad<StatementItem[]>("/api/portal/statements");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (s: StatementItem) => {
    setBusy(s.id);
    setError(null);
    try {
      const data = await call<StatementData>("GET", `/api/portal/statements/${encodeURIComponent(s.id)}`);
      const { buildPayStatementsPdf } = await import("@/lib/pdf/statements");
      const prefs = prefsSchema.parse({ ...data.prefs, pdfOrientation: "portrait" });
      const site = siteSchema.parse({ id: data.site.id, name: data.site.name, address: data.site.address ?? "" });
      const pdf = buildPayStatementsPdf({ result: data.result, prefs, site, title: data.title || "Pay statement", ytd: data.ytd, ytdYear: data.ytdYear ?? undefined });
      downloadBlob(pdf.output("arraybuffer"), `${safeFilename(`${me.employee.name} pay statement ${s.periodStart}`)}.pdf`, "application/pdf");
    } catch (e) {
      setError(e instanceof PortalError ? e.message : "Couldn't make the PDF. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="portal-pay">
      <Title sub="Closed pay periods">My pay</Title>
      {error && <p role="alert" className="mb-4 rounded-xl bg-danger-soft px-5 py-3.5 text-[15px] text-danger">{error}</p>}
      {q.error && !q.data ? <ErrorBox text={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !q.data.length ? (
        <Empty text="No pay statements yet. They show up here once a pay period is closed." />
      ) : (
        <ul className={LIST}>
          {q.data.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => download(s)} disabled={!!busy} className="portal-tap flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/60 active:bg-accent disabled:opacity-60 disabled:hover:bg-transparent" data-testid={`portal-statement-${s.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[18px] font-semibold">{range(s.periodStart, s.periodEnd)}</span>
                  {s.label && s.label !== range(s.periodStart, s.periodEnd) && <span className="block truncate text-[14px] text-muted-foreground">{s.label}</span>}
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block text-[18px] font-semibold">{money(s.totalPay, me)}</span>
                  <span className="block text-[13px] text-muted-foreground">{s.minutes ? `${hm(s.minutes)} · ` : ""}{s.isNetPay ? "Take-home" : "Before tax"}</span>
                </span>
                {busy === s.id ? <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" aria-label="Making PDF" /> : <Download className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!q.data?.length && <p className="mt-4 px-1 text-[14px] leading-relaxed text-muted-foreground">Tap a period to download your pay statement (PDF).</p>}
    </section>
  );
}

// ── Schedule ─────────────────────────────────────────────────────────────────
export function ScheduleTab({ me }: { me: Me }) {
  const q = useLoad<ScheduleData>("/api/portal/schedule");
  const d = q.data;
  const days = d ? Array.from({ length: 14 }, (_, i) => addDays(d.from, i)) : [];
  const today = todayISO(me.site.timezone);
  return (
    <section data-testid="portal-schedule">
      <Title sub="Next 2 weeks">My schedule</Title>
      {q.error && !d ? <ErrorBox text={q.error} retry={q.reload} /> : !d ? <Loading rows={7} /> : (
        <>
          {d.unpublishedWeeks.length > 0 && (
            <p className={`mb-4 ${NOTE}`}>
              {d.unpublishedWeeks.length === 1 ? `The week of ${shortDate(d.unpublishedWeeks[0])} isn't out yet.` : "Some weeks aren't out yet."} Check back later.
            </p>
          )}
          <ul className={LIST}>
            {days.map((date) => {
              const shifts = d.shifts.filter((s) => s.date === date);
              const off = d.timeOff.find((t) => date >= t.start && date <= t.end);
              const isToday = date === today;
              return (
                <li key={date} className={`flex items-start gap-4 px-5 py-3.5 ${isToday ? "bg-primary/[0.05]" : ""}`} data-testid={`portal-sched-${date}`}>
                  <span className={`w-28 shrink-0 pt-0.5 text-[16px] font-semibold ${isToday ? "text-primary" : ""}`}>{isToday ? "Today" : dayLabel(date)}</span>
                  <span className="min-w-0 flex-1 space-y-1">
                    {off && <Pill tone="grey">Time off{off.reason ? ` · ${off.reason}` : ""}</Pill>}
                    {shifts.map((s) => (
                      <span key={s.id} className="block">
                        <span className="tabular block text-[17px] font-semibold">{minutesClock(s.start, me)} – {minutesClock(s.end, me)}</span>
                        {(s.station || s.note) && <span className="block text-[14px] text-muted-foreground">{[s.station, s.note].filter(Boolean).join(" · ")}</span>}
                      </span>
                    ))}
                    {!off && !shifts.length && <span className="block pt-0.5 text-[16px] text-muted-foreground">Off</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ── Time off ─────────────────────────────────────────────────────────────────
const TO_STATUS: Record<TimeOffItem["status"], { tone: Tone; label: string }> = {
  pending: { tone: "amber", label: "Waiting" },
  approved: { tone: "green", label: "Approved" },
  declined: { tone: "red", label: "Declined" },
};

export function TimeOffTab({ me }: { me: Me }) {
  const q = useLoad<TimeOffItem[]>("/api/portal/time-off");
  const today = todayISO(me.site.timezone);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await call("POST", "/api/portal/time-off", { start, end: end < start ? start : end, note: note.trim() });
      setMsg({ ok: true, text: "Request sent. Your manager will answer here." });
      setNote("");
      q.reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof PortalError ? err.message : "Couldn't send. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try {
      await call("DELETE", `/api/portal/time-off/${encodeURIComponent(id)}`);
      setConfirming(null);
      q.reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof PortalError ? err.message : "Couldn't cancel. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "portal-input h-14 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-[16px] outline-none transition-colors placeholder:text-muted-foreground focus:border-primary";
  const labelCls = "mb-1.5 block text-[14px] font-semibold";
  return (
    <section data-testid="portal-timeoff">
      <Title>My time off</Title>
      <form onSubmit={send} className="mb-8 space-y-4 rounded-2xl border border-card-border bg-card p-5 shadow-card">
        <h2 className="text-[19px] font-semibold">Ask for time off</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="block min-w-0">
            <span className={labelCls}>First day</span>
            <input type="date" value={start} min={today} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} className={inputCls} required data-testid="portal-to-start" />
          </label>
          <label className="block min-w-0">
            <span className={labelCls}>Last day</span>
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className={inputCls} required data-testid="portal-to-end" />
          </label>
        </div>
        <label className="block">
          <span className={labelCls}>Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Family wedding" className={inputCls} data-testid="portal-to-note" />
        </label>
        {msg && <p role="status" className={`text-[15px] font-medium ${msg.ok ? "text-success" : "text-danger"}`} data-testid="portal-to-msg">{msg.text}</p>}
        <Button type="submit" size="lg" disabled={busy || !start} className="portal-tap h-14 w-full rounded-xl text-[17px] font-semibold [&_svg]:size-5" data-testid="portal-to-send">
          {busy && <Loader2 className="animate-spin" />}Send request
        </Button>
      </form>

      <h2 className="mb-3 text-[19px] font-semibold">My requests</h2>
      {q.error && !q.data ? <ErrorBox text={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !q.data.length ? (
        <Empty text="No requests yet. Ones you send show up here with your manager's answer." />
      ) : (
        <ul className={LIST}>
          {q.data.map((t) => {
            const st = TO_STATUS[t.status];
            const canCancel = t.status === "pending" && t.requestedBy === "employee";
            return (
              <li key={t.id} className="px-5 py-4" data-testid={`portal-to-${t.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[18px] font-semibold">{t.start === t.end ? dayLabel(t.start) : `${dayLabel(t.start)} – ${dayLabel(t.end)}`}</span>
                    {t.reason && <span className="block break-words text-[15px] text-muted-foreground">{t.reason}</span>}
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </div>
                {canCancel && (
                  confirming === t.id ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-[15px] text-muted-foreground">Cancel this request?</span>
                      <span className="flex items-center gap-2">
                        <Button type="button" variant="destructive" onClick={() => cancel(t.id)} disabled={busy} className="portal-tap h-10 rounded-full px-4 text-[15px] font-semibold" data-testid={`portal-to-cancel-yes-${t.id}`}>{busy && <Loader2 className="animate-spin" />}Yes, cancel</Button>
                        <Button type="button" variant="ghost" onClick={() => setConfirming(null)} className="portal-tap h-10 rounded-full px-4 text-[15px]">Keep it</Button>
                      </span>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirming(t.id)} className="portal-tap -ml-0.5 mt-1 inline-flex min-h-10 items-center rounded-md text-[15px] font-semibold text-primary underline-offset-4 hover:underline" data-testid={`portal-to-cancel-${t.id}`}>Cancel request<ChevronRight className="h-4 w-4" /></button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
