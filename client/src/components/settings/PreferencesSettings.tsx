import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { DATE_FORMATS, type Prefs } from "@shared/schema";
import { formatDate, formatTime } from "@shared/dates";
import { useApp, applyTheme } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Section, ToggleRow } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

export function PreferencesSettings() {
  const app = useApp();
  const { toast } = useToast();
  const [p, setP] = useState<Prefs>(app.prefs);
  const [saving, setSaving] = useState(false);
  useEffect(() => setP(app.prefs), [app.prefs]);
  const dirty = JSON.stringify(p) !== JSON.stringify(app.prefs);
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setP({ ...p, [k]: v });

  const save = async () => {
    if (!p.appName.trim()) { toast({ title: "App name can't be empty", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await api("PUT", "/api/prefs", { ...p, appName: p.appName.trim() });
      await app.refresh();
      toast({ title: "Preferences saved" });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <Section title="Branding">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="App name"><Input value={p.appName} maxLength={60} onChange={(e) => set("appName", e.target.value)} data-testid="input-pref-appname" /></Field>
          <Field label="Business name" hint="Shown at the top of PDF reports (falls back to the location name)"><Input value={p.businessName} maxLength={80} onChange={(e) => set("businessName", e.target.value)} data-testid="input-pref-business" /></Field>
        </div>
      </Section>
      <Section title="Display">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Date format">
            <Select value={p.dateFormat} onValueChange={(v) => set("dateFormat", v as any)}>
              <SelectTrigger data-testid="select-pref-date"><SelectValue /></SelectTrigger>
              <SelectContent>{DATE_FORMATS.map((f) => <SelectItem key={f} value={f}>{formatDate("2026-03-07", f)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Time format">
            <Select value={p.timeFormat} onValueChange={(v) => set("timeFormat", v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="12h">{formatTime(1050, "12h")}</SelectItem><SelectItem value="24h">{formatTime(1050, "24h")}</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Currency symbol"><Input value={p.currencySymbol} maxLength={4} onChange={(e) => set("currencySymbol", e.target.value)} className="w-24" /></Field>
          <Field label="Theme">
            <Select value={p.theme} onValueChange={(v) => { set("theme", v as any); applyTheme(v as any); }}>
              <SelectTrigger data-testid="select-pref-theme"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="system">Match device</SelectItem><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Default location">
            <Select value={p.defaultSiteId || app.sites[0]?.id} onValueChange={(v) => set("defaultSiteId", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{app.activeSites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      </Section>
      <Section title="Editing">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle label="Autosave" hint="Save changes about a second after you stop typing" checked={p.autosave} onChange={(v) => set("autosave", v)} />
          <Toggle label="Apply saved rates to new timesheets" hint="Uses the location's saved rates for matching names" checked={p.autoApplySavedRates} onChange={(v) => set("autoApplySavedRates", v)} />
        </div>
      </Section>
      <Section title="PDF reports">
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle label="Show clock-in and clock-out times" checked={p.pdfShowShiftTimes} onChange={(v) => set("pdfShowShiftTimes", v)} />
          <Toggle label="Start each employee on a new page" checked={p.pdfPagePerEmployee} onChange={(v) => set("pdfPagePerEmployee", v)} />
          <Field label="Footer text"><Input value={p.pdfFooter} maxLength={120} onChange={(e) => set("pdfFooter", e.target.value)} /></Field>
        </div>
      </Section>
      <div className={cn("z-10 -mx-1 flex items-center justify-end gap-2 rounded-xl border px-3 py-2.5 transition-shadow duration-200", dirty ? "glass sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] border-border/70 shadow-float md:bottom-4" : "border-transparent")} data-testid="bar-save">
        <span className="mr-auto text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "All changes saved"}</span>
        <Button variant="outline" disabled={!dirty || saving} onClick={() => { setP(app.prefs); applyTheme(app.prefs.theme); }}>Discard</Button>
        <Button disabled={!dirty || saving} onClick={save} data-testid="button-save-prefs">{saving && <Loader2 className="animate-spin" />}Save preferences</Button>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <ToggleRow label={label} hint={hint} checked={checked} onChange={onChange} />;
}
