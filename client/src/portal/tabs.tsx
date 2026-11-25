// The four portal tabs. Every number here comes from the server already
// filtered to the signed-in employee.
import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Coffee, Download, Loader2, Timer } from "lucide-react";
import { addDays, todayISO } from "@shared/dates";
import type { PortalDay } from "@shared/portal";
import { prefsSchema, siteSchema } from "@shared/schema";
import { downloadBlob, safeFilename } from "@/lib/doc";
import { type HoursData, type Me, type ScheduleData, type StatementData, type StatementItem, type TimeOffItem, PortalError, call, useLoad } from "./api";
import { clock, dayLabel, hm, minutesClock, money, range, shortDate } from "./format";

// ── Building blocks ──────────────────────────────────────────────────────────
function Title({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-[30px] font-bold leading-tight tracking-tight">{children}</h1>
      {sub && <p className="mt-1 text-[16px] text-neutral-500">{sub}</p>}
    </div>
  );
}

function Loading() {
  return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-neutral-400" /></div>;
}

function ErrorBox({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className="rounded-2xl bg-red-50 px-5 py-4 text-[16px] text-red-800" role="alert">
      <p>{text}</p>
      <button type="button" onClick={retry} className="portal-tap mt-2 font-semibold">Try again</button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-2xl bg-neutral-50 px-5 py-8 text-center text-[17px] text-neutral-500">{text}</p>;
}

type Tone = "green" | "amber" | "blue" | "grey" | "red";
const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800",
  amber: "bg-amber-50 text-amber-800",
  blue: "bg-sky-50 text-sky-800",
  grey: "bg-neutral-100 text-neutral-600",
  red: "bg-red-50 text-red-800",
};
function Pill({ tone, children, testid }: { tone: Tone; children: React.ReactNode; testid?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold ${TONES[tone]}`} data-testid={testid}>{children}</span>;
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="mb-5 grid grid-flow-col gap-1 rounded-xl bg-neutral-100 p-1" role="tablist">
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)}
          className={`portal-tap h-10 rounded-lg text-[15px] font-semibold ${value === o.id ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"}`}>
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
  return (
    <section data-testid="portal-hours">
      <Title sub={d ? range(d.period.start, d.period.end) : " "}>My hours</Title>
      <Segmented value={offset} onChange={setOffset} options={[{ id: 0, label: "This pay period" }, { id: -1, label: "Last period" }]} />
      {!me.site.timeClock && <p className="mb-4 rounded-2xl bg-neutral-50 px-5 py-4 text-[15px] text-neutral-600">{me.site.name} doesn't use the time clock, so hours may not show here.</p>}
      {q.error && !d ? <ErrorBox text={q.error} retry={q.reload} /> : !d || (q.loading && d.offset !== offset) ? <Loading /> : (
        <>
          <div className="mb-6 rounded-3xl bg-neutral-50 px-5 py-5">
            <p className="text-[15px] font-medium text-neutral-500">Total so far</p>
            <p className="tabular mt-1 text-[44px] font-bold leading-none tracking-tight" data-testid="portal-hours-total">{hm(d.totalMinutes)}</p>
            {d.status !== "out" && d.since && offset === 0 && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[16px] font-medium text-sky-800">
                {d.status === "break" ? <Coffee className="h-4 w-4" /> : <Timer className="h-4 w-4" />}
                {d.status === "break" ? "On a break since" : "Clocked in since"} {clock(d.since, me)}
              </p>
            )}
          </div>
          {!d.days.length ? <Empty text="No hours yet this period." /> : (
            <ul className="divide-y divide-neutral-200/80 overflow-hidden rounded-3xl ring-1 ring-neutral-200/80">
              {d.days.map((day) => {
                const st = DAY_STATUS[day.status];
                return (
                  <li key={day.date} className="px-5 py-4" data-testid={`portal-day-${day.date}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[18px] font-semibold">{dayLabel(day.date)}</span>
                      <span className="tabular text-[20px] font-semibold">{hm(day.workedMinutes)}</span>
                    </div>
                    <div className="mt-1 space-y-0.5 text-[15px] text-neutral-600">
                      {day.shifts.map((s) => (
                        <p key={s.in} className="tabular">
                          {clock(s.in, me)} – {s.out ? clock(s.out, me) : "now"}
                          {s.breakMinutes > 0 && <span className="text-neutral-500"> · {hm(s.breakMinutes)} break</span>}
                        </p>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Pill tone={st.tone} testid={`portal-day-status-${day.date}`}>{day.status === "approved" && <CheckCircle2 className="h-3.5 w-3.5" />}{day.status === "flagged" && <AlertTriangle className="h-3.5 w-3.5" />}{st.label}</Pill>
                      {day.status === "flagged" && day.note && <span className="text-[14px] text-neutral-500">{day.note}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-4 px-1 text-[14px] text-neutral-500">Hours from the time clock, before breaks are paid or rounded. Your pay statement has the final numbers. Something wrong? Tell your manager.</p>
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
      {error && <p role="alert" className="mb-4 rounded-2xl bg-red-50 px-5 py-3 text-[15px] text-red-800">{error}</p>}
      {q.error && !q.data ? <ErrorBox text={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !q.data.length ? (
        <Empty text="No pay statements yet. They show here once a pay period is closed." />
      ) : (
        <ul className="divide-y divide-neutral-200/80 overflow-hidden rounded-3xl ring-1 ring-neutral-200/80">
          {q.data.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => download(s)} disabled={!!busy} className="portal-tap flex w-full items-center gap-4 px-5 py-4 text-left active:bg-neutral-50 disabled:opacity-70" data-testid={`portal-statement-${s.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[18px] font-semibold">{range(s.periodStart, s.periodEnd)}</span>
                  <span className="block truncate text-[14px] text-neutral-500">{s.label}</span>
                </span>
                <span className="text-right">
                  <span className="tabular block text-[19px] font-semibold">{money(s.totalPay, me)}</span>
                  <span className="block text-[13px] text-neutral-500">{s.isNetPay ? "Take-home" : "Before tax"}</span>
                </span>
                {busy === s.id ? <Loader2 className="h-5 w-5 animate-spin text-neutral-400" /> : <Download className="h-5 w-5 text-sky-700" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 px-1 text-[14px] text-neutral-500">Tap a period to download your pay statement (PDF).</p>
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
      {q.error && !d ? <ErrorBox text={q.error} retry={q.reload} /> : !d ? <Loading /> : (
        <>
          {d.unpublishedWeeks.length > 0 && (
            <p className="mb-4 rounded-2xl bg-neutral-50 px-5 py-3 text-[15px] text-neutral-600">
              {d.unpublishedWeeks.length === 1 ? `The week of ${shortDate(d.unpublishedWeeks[0])} isn't out yet.` : "Some weeks aren't out yet."} Check back later.
            </p>
          )}
          <ul className="divide-y divide-neutral-200/80 overflow-hidden rounded-3xl ring-1 ring-neutral-200/80">
            {days.map((date) => {
              const shifts = d.shifts.filter((s) => s.date === date);
              const off = d.timeOff.find((t) => date >= t.start && date <= t.end);
              const isToday = date === today;
              return (
                <li key={date} className={`flex items-start gap-4 px-5 py-3.5 ${isToday ? "bg-sky-50/50" : ""}`} data-testid={`portal-sched-${date}`}>
                  <span className={`w-28 shrink-0 pt-0.5 text-[16px] font-semibold ${isToday ? "text-sky-800" : ""}`}>{isToday ? "Today" : dayLabel(date)}</span>
                  <span className="min-w-0 flex-1 space-y-1">
                    {off && <Pill tone="grey">Time off{off.reason ? ` · ${off.reason}` : ""}</Pill>}
                    {shifts.map((s) => (
                      <span key={s.id} className="block">
                        <span className="tabular block text-[17px] font-semibold">{minutesClock(s.start, me)} – {minutesClock(s.end, me)}</span>
                        {(s.station || s.note) && <span className="block text-[14px] text-neutral-500">{[s.station, s.note].filter(Boolean).join(" · ")}</span>}
                      </span>
                    ))}
                    {!off && !shifts.length && <span className="block pt-0.5 text-[16px] text-neutral-400">Off</span>}
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

  const inputCls = "portal-input h-14 w-full rounded-2xl bg-neutral-100 px-4 text-[18px] outline-none";
  return (
    <section data-testid="portal-timeoff">
      <Title>Time off</Title>
      <form onSubmit={send} className="mb-8 space-y-4 rounded-3xl bg-neutral-50 p-5">
        <h2 className="text-[20px] font-semibold">Ask for time off</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[14px] font-semibold text-neutral-600">First day</span>
            <input type="date" value={start} min={today} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} className={`${inputCls} bg-white`} required data-testid="portal-to-start" />
          </label>
          <label className="block min-w-0">
            <span className="mb-1.5 block text-[14px] font-semibold text-neutral-600">Last day</span>
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} className={`${inputCls} bg-white`} required data-testid="portal-to-end" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-semibold text-neutral-600">Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Family wedding" className={`${inputCls} bg-white`} data-testid="portal-to-note" />
        </label>
        {msg && <p role="status" className={`text-[15px] font-medium ${msg.ok ? "text-emerald-800" : "text-red-700"}`} data-testid="portal-to-msg">{msg.text}</p>}
        <button type="submit" disabled={busy || !start} className="portal-tap flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-neutral-900 text-[18px] font-semibold text-white active:bg-neutral-700 disabled:opacity-60" data-testid="portal-to-send">
          {busy && <Loader2 className="h-5 w-5 animate-spin" />}Send request
        </button>
      </form>

      <h2 className="mb-3 text-[20px] font-semibold">My requests</h2>
      {q.error && !q.data ? <ErrorBox text={q.error} retry={q.reload} /> : !q.data ? <Loading /> : !q.data.length ? (
        <Empty text="No time off yet." />
      ) : (
        <ul className="divide-y divide-neutral-200/80 overflow-hidden rounded-3xl ring-1 ring-neutral-200/80">
          {q.data.map((t) => {
            const st = TO_STATUS[t.status];
            const canCancel = t.status === "pending" && t.requestedBy === "employee";
            return (
              <li key={t.id} className="px-5 py-4" data-testid={`portal-to-${t.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[18px] font-semibold">{t.start === t.end ? dayLabel(t.start) : `${dayLabel(t.start)} – ${dayLabel(t.end)}`}</span>
                    {t.reason && <span className="block text-[15px] text-neutral-500">{t.reason}</span>}
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </div>
                {canCancel && (
                  confirming === t.id ? (
                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-[15px] text-neutral-600">Cancel this request?</span>
                      <button type="button" onClick={() => cancel(t.id)} disabled={busy} className="portal-tap h-10 rounded-full bg-red-600 px-4 text-[15px] font-semibold text-white" data-testid={`portal-to-cancel-yes-${t.id}`}>Yes, cancel</button>
                      <button type="button" onClick={() => setConfirming(null)} className="portal-tap h-10 px-2 text-[15px] font-medium text-neutral-600">Keep</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirming(t.id)} className="portal-tap mt-2 inline-flex items-center text-[15px] font-semibold text-sky-700" data-testid={`portal-to-cancel-${t.id}`}>Cancel request<ChevronRight className="h-4 w-4" /></button>
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
