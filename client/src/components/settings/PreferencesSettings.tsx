import { type ReactNode, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { DATE_FORMATS, PDF_LOGO_MAX_BYTES, type Prefs } from "@shared/schema";
import { formatDate, formatTime } from "@shared/dates";
import { useApp, applyTheme } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Section } from "@/components/workspace/fields";
import { InsetRow } from "@/components/ui/grouped";
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
      <Section title="Branding" bodyClassName={ROWS_BODY}>
        <Rows>
          <InsetRow className={TEXT_ROW} label="App name" htmlFor="pref-appname" control={<Input id="pref-appname" className={TEXT_W} value={p.appName} maxLength={60} onChange={(e) => set("appName", e.target.value)} data-testid="input-pref-appname" />} />
          <InsetRow className={TEXT_ROW} label="Business name" hint="Shown at the top of PDF reports. Falls back to the location name." htmlFor="pref-business" control={<Input id="pref-business" className={TEXT_W} value={p.businessName} maxLength={80} onChange={(e) => set("businessName", e.target.value)} data-testid="input-pref-business" />} />
        </Rows>
      </Section>
      <Section title="Display" bodyClassName={ROWS_BODY}>
        <Rows>
          <InsetRow className={ROW} label="Theme" control={
            <Select value={p.theme} onValueChange={(v) => { set("theme", v as any); applyTheme(v as any); }}>
              <SelectTrigger className={SELECT_W} aria-label="Theme" data-testid="select-pref-theme"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="system">Match device</SelectItem><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem></SelectContent>
            </Select>
          } />
          <InsetRow className={ROW} label="Date format" control={
            <Select value={p.dateFormat} onValueChange={(v) => set("dateFormat", v as any)}>
              <SelectTrigger className={SELECT_W} aria-label="Date format" data-testid="select-pref-date"><SelectValue /></SelectTrigger>
              <SelectContent>{DATE_FORMATS.map((f) => <SelectItem key={f} value={f}>{formatDate("2026-03-07", f)}</SelectItem>)}</SelectContent>
            </Select>
          } />
          <InsetRow className={ROW} label="Time format" control={
            <Select value={p.timeFormat} onValueChange={(v) => set("timeFormat", v as any)}>
              <SelectTrigger className={SELECT_W} aria-label="Time format"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="12h">{formatTime(1050, "12h")}</SelectItem><SelectItem value="24h">{formatTime(1050, "24h")}</SelectItem></SelectContent>
            </Select>
          } />
          <InsetRow className={ROW} label="Currency symbol" htmlFor="pref-currency" control={<Input id="pref-currency" value={p.currencySymbol} maxLength={4} onChange={(e) => set("currencySymbol", e.target.value)} className="w-20 text-center" />} />
          <InsetRow className={ROW} label="Default location" control={
            <Select value={p.defaultSiteId || app.sites[0]?.id} onValueChange={(v) => set("defaultSiteId", v)}>
              <SelectTrigger className={SELECT_W} aria-label="Default location"><SelectValue /></SelectTrigger>
              <SelectContent>{app.activeSites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          } />
        </Rows>
      </Section>
      <Section title="Editing" bodyClassName={ROWS_BODY}>
        <Rows>
          <Toggle id="pref-autosave" label="Autosave" hint="Save changes about a second after you stop typing" checked={p.autosave} onChange={(v) => set("autosave", v)} />
          <Toggle id="pref-apply-rates" label="Apply saved rates to new timesheets" hint="Uses the location's saved rates for matching names" checked={p.autoApplySavedRates} onChange={(v) => set("autoApplySavedRates", v)} />
        </Rows>
      </Section>
      <Section title="PDF reports" bodyClassName={ROWS_BODY}>
        <Rows>
          <Toggle id="pref-pdf-times" label="Show clock-in and clock-out times" checked={p.pdfShowShiftTimes} onChange={(v) => set("pdfShowShiftTimes", v)} />
          <Toggle id="pref-pdf-page" label="Start each employee on a new page" checked={p.pdfPagePerEmployee} onChange={(v) => set("pdfPagePerEmployee", v)} />
          <Toggle id="pref-pdf-signature" label="Signature line on pay statements" hint="Adds “Received by” and date lines" checked={p.pdfSignatureLine} onChange={(v) => set("pdfSignatureLine", v)} />
          <InsetRow className={ROW} label="Orientation" hint="Pay statements are always portrait" control={
            <Select value={p.pdfOrientation} onValueChange={(v) => set("pdfOrientation", v as Prefs["pdfOrientation"])}>
              <SelectTrigger className={SELECT_W} aria-label="Orientation" data-testid="select-pref-pdf-orientation"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="landscape">Landscape</SelectItem><SelectItem value="portrait">Portrait</SelectItem></SelectContent>
            </Select>
          } />
          <InsetRow className={ROW} label="Paper size" control={
            <Select value={p.pdfPageSize} onValueChange={(v) => set("pdfPageSize", v as Prefs["pdfPageSize"])}>
              <SelectTrigger className={SELECT_W} aria-label="Paper size" data-testid="select-pref-pdf-size"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="letter">US Letter</SelectItem><SelectItem value="a4">A4</SelectItem></SelectContent>
            </Select>
          } />
          <InsetRow className={TEXT_ROW} label="Footer text" htmlFor="pref-footer" control={<Input id="pref-footer" className={TEXT_W} value={p.pdfFooter} maxLength={120} onChange={(e) => set("pdfFooter", e.target.value)} />} />
          <LogoField value={p.pdfLogoDataUrl} onChange={(v) => set("pdfLogoDataUrl", v)} />
        </Rows>
      </Section>
      <div className={cn("z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-xl border px-3 py-2.5 transition-shadow duration-200", dirty ? "glass sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] border-border/70 shadow-float md:bottom-4" : "border-transparent")} data-testid="bar-save">
        <span className="mr-auto text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "All changes saved"}</span>
        <Button variant="outline" disabled={!dirty || saving} onClick={() => { setP(app.prefs); applyTheme(app.prefs.theme); }}>Discard</Button>
        <Button disabled={!dirty || saving} onClick={save} data-testid="button-save-prefs">{saving && <Loader2 className="animate-spin" />}Save preferences</Button>
      </div>
    </div>
  );
}

/** Section body that holds flush, hairline-divided rows (System Settings style). */
const ROWS_BODY = "px-0 pb-1 pt-2";
const ROW = "px-5";
const SELECT_W = "w-40 sm:w-56";
const TEXT_W = "w-full sm:w-64";
/** On phones a text field drops under its label at full width instead of squeezing it. */
const TEXT_ROW = "px-5 max-sm:[&>div>*:first-child]:basis-full max-sm:[&>div>*:last-child]:w-full";
function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/70 border-t border-border/70">{children}</div>;
}

/** PNG/JPEG logo stored as a data URL in prefs (≤ 300 KB). */
function LogoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { toast } = useToast();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast({ title: "Use a PNG or JPEG image", variant: "destructive" }); return; }
    if (file.size > PDF_LOGO_MAX_BYTES) { toast({ title: "Logo is too large", description: "Keep it under 300 KB.", variant: "destructive" }); return; }
    const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
    const ok = await new Promise<boolean>((res) => { const img = new Image(); img.onload = () => res(img.width > 0 && img.height > 0); img.onerror = () => res(false); img.src = url; });
    if (!ok || !/^data:image\/(png|jpe?g);base64,/.test(url)) { toast({ title: "Couldn't read that image", variant: "destructive" }); return; }
    onChange(url.replace("data:image/jpg;", "data:image/jpeg;"));
  };
  return (
    <InsetRow className={ROW} label="Logo" hint="PNG or JPEG, up to 300 KB. Shown top-left on PDFs." control={
      <>
        <div className={cn("flex h-10 w-20 items-center justify-center rounded-md border border-border", value ? "bg-white" : "bg-muted/60")}>
          {value ? <img src={value} alt="Logo preview" className="max-h-8 max-w-[4.5rem] object-contain" data-testid="img-pref-logo" /> : <span className="text-xs text-muted-foreground">None</span>}
        </div>
        {value && <Button variant="ghost" size="sm" onClick={() => onChange("")} data-testid="button-pref-logo-remove">Remove</Button>}
        <Button variant="outline" size="sm" asChild>
          <label className="cursor-pointer" data-testid="button-pref-logo-upload">
            {value ? "Replace" : "Upload"}
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        </Button>
      </>
    } />
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <InsetRow className={ROW} label={label} hint={hint} htmlFor={id} control={<Switch id={id} checked={checked} onCheckedChange={onChange} />} />;
}
