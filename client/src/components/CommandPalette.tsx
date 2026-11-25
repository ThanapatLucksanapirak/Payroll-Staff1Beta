import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CalendarRange, CornerDownLeft, FileSpreadsheet, FileText, LogOut, Plus, Search, Table2, Tablet, Wrench } from "lucide-react";
import type { TimesheetSummary } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { signOut } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import { timeAgo } from "@/lib/doc";
import { overlayClass } from "@/components/ui/dialog";
import { useNewTimesheet } from "@/components/NewTimesheet";
import { visibleNav } from "@/components/nav";
import { visibleSettingsSections } from "@/pages/settings-sections";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  group: "Actions" | "Go to" | "Timesheets" | "Settings";
  label: string;
  hint?: string;
  icon: ComponentType<{ className?: string }>;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER: Item["group"][] = ["Actions", "Go to", "Timesheets", "Settings"];

/** True when the platform uses ⌘ rather than Ctrl. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const app = useApp();
  const [, navigate] = useLocation();
  const newTimesheet = useNewTimesheet();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"], enabled: open });

  // Global ⌘K / Ctrl-K
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onOpenChange]);

  useEffect(() => { if (open) { setQ(""); setActive(0); } }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => navigate(href);
    const timeSource = app.site.timeSource ?? "square";
    // Viewers are read only: no import / create actions.
    const actions: Item[] = canEdit(app.user) ? [
      { id: "new", group: "Actions", label: "New timesheet", hint: app.site.name, icon: Plus, keywords: "create import add", run: () => newTimesheet() },
      ...(timeSource !== "square" ? [{ id: "kiosk", group: "Actions" as const, label: "Import from the time clock", hint: app.site.name, icon: Tablet, keywords: "import kiosk punches clock", run: () => newTimesheet("kiosk") }] : []),
      ...(timeSource !== "kiosk" ? [{ id: "square", group: "Actions" as const, label: "Pull from Square", hint: app.site.name, icon: CalendarRange, keywords: "import timecards fetch", run: () => newTimesheet("square") }] : []),
      { id: "csv", group: "Actions", label: "Upload CSV", icon: FileSpreadsheet, keywords: "import file", run: () => newTimesheet("csv") },
      { id: "pdf", group: "Actions", label: "Import Toast / Sling PDF", icon: FileText, keywords: "import schedule", run: () => newTimesheet("pdf") },
    ] : [];
    const out: Item[] = [
      ...actions,
      ...visibleNav(app.user).map((n) => ({ id: `nav-${n.href}`, group: "Go to" as const, label: n.label, icon: n.icon, keywords: n.keywords, run: go(n.href) })),
      ...(timeSource !== "square" ? [{ id: "nav-fix-punches", group: "Go to" as const, label: "Fix punches", hint: "Missed clock-outs, approvals", icon: Wrench, keywords: "punch missed clock out forgot approve review auto closed", run: go("/live/fix") }] : []),
      ...visibleSettingsSections(app.user).map((s) => ({ id: `set-${s.id}`, group: "Settings" as const, label: s.label, hint: s.description, icon: s.icon, keywords: `settings ${s.keywords ?? ""}`, run: go(`/settings/${s.id}`) })),
      { id: "signout", group: "Actions", label: "Sign out", icon: LogOut, keywords: "logout lock", run: () => void signOut() },
    ];
    const sites = new Map(app.sites.map((s) => [s.id, s.name]));
    const ts = [...(list.data ?? [])].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    for (const t of ts) {
      out.push({
        id: `ts-${t.id}`,
        group: "Timesheets",
        label: t.customLabel || t.filename || "Untitled",
        hint: [sites.get(t.siteId ?? "") ?? "", t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "", `edited ${timeAgo(t.updatedAt ?? t.createdAt)}`].filter(Boolean).join(" · "),
        icon: Table2,
        keywords: `${t.filename} ${t.periodStart ?? ""} ${t.periodEnd ?? ""}`,
        run: go(`/timesheet/${t.id}`),
      });
    }
    return out;
  }, [app, list.data, navigate, newTimesheet]);

  const filtered = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let r: Item[];
    if (!terms.length) {
      // Empty query: actions, pages, five recent timesheets, settings
      let recent = 0;
      r = items.filter((i) => i.group !== "Timesheets" || recent++ < 5);
    } else {
      r = items
        .map((i) => {
          const hay = `${i.label} ${i.hint ?? ""} ${i.keywords ?? ""}`.toLowerCase();
          if (!terms.every((t) => hay.includes(t))) return null;
          const l = i.label.toLowerCase();
          const q0 = terms.join(" ");
          const score = l === q0 ? 0 : l.startsWith(q0) ? 1 : l.includes(q0) ? 2 : l.split(/\s+/).some((w) => w.startsWith(terms[0])) ? 3 : 4;
          return { i, score };
        })
        .filter((x): x is { i: Item; score: number } => !!x)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.i);
      const perGroup: Record<string, number> = {};
      r = r.filter((i) => (perGroup[i.group] = (perGroup[i.group] ?? 0) + 1) <= 8);
      // Groups whose best match is strongest come first; items keep their score order.
      const order = [...new Set(r.map((i) => i.group))];
      return order.flatMap((g) => r.filter((i) => i.group === g));
    }
    return GROUP_ORDER.flatMap((g) => r.filter((i) => i.group === g));
  }, [items, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    onOpenChange(false);
    // Let the dialog close (and return focus) before navigating / opening another dialog.
    setTimeout(i.run, 10);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = filtered.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (n ? (a + 1) % n : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (n ? (a - 1 + n) % n : 0)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(Math.max(0, n - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered[active]); }
  };

  let lastGroup = "";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClass} />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[min(34rem,76vh)] w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-popover-border/70 bg-popover/95 text-popover-foreground shadow-pop backdrop-blur-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:zoom-out-[0.98]"
          data-testid="dialog-command"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-border/70 px-4">
            <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search pages, settings, timesheets…"
              className="h-14 w-full bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/80"
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-activedescendant={filtered[active] ? `cmd-${filtered[active].id}` : undefined}
              aria-autocomplete="list"
              data-testid="input-command"
            />
            <kbd className="hidden shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:block">esc</kbd>
          </div>
          <div ref={listRef} id="command-list" role="listbox" aria-label="Results" className="flex-1 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">No results for “{q}”</p>
            ) : filtered.map((i, idx) => {
              const header = i.group !== lastGroup ? i.group : null;
              lastGroup = i.group;
              return (
                <div key={i.id}>
                  {header && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground first:pt-1" role="presentation">{header}</div>}
                  <div
                    id={`cmd-${i.id}`}
                    role="option"
                    aria-selected={idx === active}
                    data-index={idx}
                    onMouseMove={() => idx !== active && setActive(idx)}
                    onClick={() => run(i)}
                    className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px]", idx === active ? "bg-primary text-primary-foreground" : "text-foreground")}
                    data-testid={`command-${i.id}`}
                  >
                    <i.icon className={cn("h-4 w-4 shrink-0", idx === active ? "text-primary-foreground" : "text-muted-foreground")} />
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    {i.hint && <span className={cn("hidden max-w-[50%] truncate text-xs sm:block", idx === active ? "text-primary-foreground/80" : "text-muted-foreground")}>{i.hint}</span>}
                    {idx === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
            <span><kbd className="font-sans">↑↓</kbd> to move</span>
            <span><kbd className="font-sans">↵</kbd> to open</span>
            <span className="ml-auto">{isMac ? "⌘" : "Ctrl"} K anywhere</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
