// Settings → Locations → Time clock: per-device kiosk options, and the
// location's stations, break reminder and photo retention.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Coffee, Loader2, MapPin, Plus, X } from "lucide-react";
import type { Site } from "@shared/schema";
import { type DeviceLoginMode, type KioskDeviceOptions, type KioskSiteConfig, DEFAULT_DEVICE_OPTIONS, IDLE_MAX, IDLE_MIN, MAX_STATIONS, cleanStation } from "@shared/kiosk";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, ToggleRow } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { UnsavedDot, usePendingChange } from "./pendingChanges";

const LOGIN_LABELS: Record<DeviceLoginMode, string> = { site: "Same as location", pin: "PIN only", name_pin: "Name list, then PIN" };

/** The options of one kiosk device. Saved with the Locations page's Save changes button. */
export function DeviceOptionsPanel({ siteId, deviceId, deviceName, options, hasStations }: { siteId: string; deviceId: string; deviceName?: string; options?: KioskDeviceOptions; hasStations: boolean }) {
  const { toast } = useToast();
  const savedOpts = options ?? DEFAULT_DEVICE_OPTIONS;
  const [o, setO] = useState<KioskDeviceOptions>(savedOpts);
  const [idle, setIdle] = useState(String(o.idleSeconds));
  useEffect(() => { if (options) { setO(options); setIdle(String(options.idleSeconds)); } }, [options]);

  const idleNum = Math.round(Number(idle));
  const idleValid = Number.isFinite(idleNum) && idleNum >= IDLE_MIN && idleNum <= IDLE_MAX;
  const next: KioskDeviceOptions = { ...o, idleSeconds: idleValid ? idleNum : o.idleSeconds };
  const patch: Partial<KioskDeviceOptions> = {};
  for (const k of ["photo", "stations", "loginMode", "idleSeconds"] as const) if (next[k] !== savedOpts[k]) (patch as any)[k] = next[k];
  const dirty = Object.keys(patch).length > 0 || (!idleValid && idle !== String(savedOpts.idleSeconds));

  const save = async () => {
    if (!idleValid) throw new Error(`${deviceName ?? "Device"}: use ${IDLE_MIN} to ${IDLE_MAX} seconds before going back to the start screen.`);
    if (!Object.keys(patch).length) return;
    await api("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, patch);
    await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "kiosk-devices"] });
  };
  const discard = () => { setO(savedOpts); setIdle(String(savedOpts.idleSeconds)); };
  const inPage = usePendingChange(`device:${deviceId}`, dirty, { label: `Kiosk options${deviceName ? ` (${deviceName})` : ""}`, save, discard });
  const [busy, setBusy] = useState(false);
  const saveHere = async () => {
    setBusy(true);
    try { await save(); toast({ title: "Kiosk options saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const set = (p: Partial<KioskDeviceOptions>) => setO({ ...o, ...p });

  return (
    <div className="space-y-2 bg-foreground/[0.015] px-3 pb-3 pt-2" data-testid={`device-options-${deviceId}`}>
      <ToggleRow label="Photo with each punch" hint="A small front-camera snapshot of the person punching. If the camera is blocked or no face is seen, the punch is stopped and the screen says why." checked={o.photo} onChange={(v) => set({ photo: v })} testid={`switch-device-photo-${deviceId}`} />
      <ToggleRow
        label="Ask for a station at clock-in"
        hint={hasStations ? "Employees pick from the location's station list below." : "Add stations below to use this."}
        checked={o.stations} onChange={(v) => set({ stations: v })} testid={`switch-device-stations-${deviceId}`}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sign-in on this device">
          <Select value={o.loginMode} onValueChange={(v) => set({ loginMode: v as DeviceLoginMode })}>
            <SelectTrigger data-testid={`select-device-login-${deviceId}`}><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(LOGIN_LABELS) as DeviceLoginMode[]).map((k) => <SelectItem key={k} value={k}>{LOGIN_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Back to the start screen after" hint="Seconds without a touch on the PIN and action screens.">
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="numeric" min={IDLE_MIN} max={IDLE_MAX} value={idle} onChange={(e) => setIdle(e.target.value)} className={cn("w-24", !idleValid && "border-destructive")} aria-invalid={!idleValid} data-testid={`input-device-idle-${deviceId}`} />
            <span className="text-[13px] text-muted-foreground">seconds</span>
          </div>
          {!idleValid && <p className="mt-1 text-xs text-destructive">Use {IDLE_MIN} to {IDLE_MAX} seconds.</p>}
        </Field>
      </div>
      {dirty && (inPage ? (
        <p className="text-xs font-medium text-warning" data-testid={`text-device-unsaved-${deviceId}`}>Unsaved: press Save changes at the bottom to apply these to the tablet.</p>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={discard}>Cancel</Button>
          <Button size="sm" disabled={busy || !idleValid} onClick={saveHere}>{busy && <Loader2 className="animate-spin" />}Save</Button>
        </div>
      ))}
    </div>
  );
}

/** Stations, break reminder and photo retention for a location. Saved with the Locations page's Save changes button. */
export function KioskLocationExtras({ site }: { site: Site }) {
  const { toast } = useToast();
  const key = ["/api/sites", site.id, "kiosk-config"];
  const q = useQuery<KioskSiteConfig>({ queryKey: key });
  const cfg = q.data;
  const [station, setStation] = useState("");
  const [stations, setStations] = useState<string[]>([]);
  const [reminderOn, setReminderOn] = useState(false);
  const [hours, setHours] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const reset = (c: KioskSiteConfig) => {
    setStations(c.stations);
    setReminderOn(!!c.breakReminderHours);
    setHours(c.breakReminderHours ? String(c.breakReminderHours) : "5");
    setDays(String(c.photoRetentionDays));
    setStation("");
  };
  useEffect(() => { if (cfg) reset(cfg); }, [cfg]);

  const hoursNum = Number(hours);
  const hoursValid = !reminderOn || (Number.isFinite(hoursNum) && hoursNum >= 0.5 && hoursNum <= 16);
  const daysNum = Math.round(Number(days));
  const daysValid = Number.isFinite(daysNum) && daysNum >= 1 && daysNum <= 3650;
  const patch: Partial<KioskSiteConfig> = {};
  if (cfg) {
    if (JSON.stringify(stations) !== JSON.stringify(cfg.stations)) patch.stations = stations;
    const br = reminderOn ? (hoursValid ? hoursNum : cfg.breakReminderHours) : null;
    if (br !== cfg.breakReminderHours || (reminderOn && !hoursValid)) patch.breakReminderHours = br;
    if (daysNum !== cfg.photoRetentionDays || !daysValid) patch.photoRetentionDays = daysNum;
  }
  const dirty = !!cfg && Object.keys(patch).length > 0;

  const save = async () => {
    if (!hoursValid) throw new Error("Break reminder: use 0.5 to 16 hours.");
    if (!daysValid) throw new Error("Punch photos: keep them 1 to 3650 days.");
    if (!Object.keys(patch).length) return;
    const next = await api<KioskSiteConfig>("PUT", `/api/sites/${site.id}/kiosk-config`, patch);
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ queryKey: ["/api/sites", site.id, "timeclock"] });
  };
  const discard = () => { if (cfg) reset(cfg); };
  const inPage = usePendingChange(`kiosk-config:${site.id}`, dirty, { label: "Stations, break reminder and photos", save, discard });
  const saveHere = async () => {
    setBusy(true);
    try { await save(); toast({ title: "Saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  if (q.isLoading || !cfg) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const addStation = () => {
    const s = cleanStation(station);
    if (!s) return;
    if (!stations.some((x) => x.toLowerCase() === s.toLowerCase()) && stations.length < MAX_STATIONS) setStations([...stations, s]);
    setStation("");
  };
  const stationsDirty = "stations" in patch;
  const reminderDirty = "breakReminderHours" in patch;
  const daysDirty = "photoRetentionDays" in patch;

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold"><MapPin className="h-4 w-4 text-muted-foreground" />Stations <UnsavedDot show={stationsDirty} /></p>
        <p className="text-xs text-muted-foreground">At clock-in, employees tap where they're working (for example Sushi bar, Kitchen, Front). It shows on Live. Leave empty to skip the question.</p>
        {stations.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" data-testid="list-stations">
            {stations.map((s) => (
              <li key={s} className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] py-1 pl-3 pr-1 text-[13px] font-medium">
                {s}
                <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-destructive" aria-label={`Remove ${s}`} onClick={() => setStations(stations.filter((x) => x !== s))}><X className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
        {stations.length < MAX_STATIONS && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addStation(); }}>
            <Input value={station} maxLength={40} onChange={(e) => setStation(e.target.value)} placeholder="e.g. Sushi bar" className="max-w-xs" data-testid="input-station" />
            <Button type="submit" variant="outline" disabled={!station.trim()} data-testid="button-add-station"><Plus /> Add</Button>
          </form>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-[13px] font-semibold"><Coffee className="h-4 w-4 text-muted-foreground" />Break reminder <UnsavedDot show={reminderDirty} /></p>
            <p className="mt-0.5 text-xs text-muted-foreground">Nudge employees on the kiosk, and show “Break due” on Live, after this long without a break.</p>
          </div>
          <Switch checked={reminderOn} onCheckedChange={setReminderOn} aria-label="Break reminder" data-testid="switch-break-reminder" />
        </div>
        {reminderOn && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            Remind after
            <Input type="number" inputMode="decimal" min={0.5} max={16} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} className={cn("w-20", !hoursValid && "border-destructive")} aria-invalid={!hoursValid} data-testid="input-break-hours" />
            hours without a break
            {!hoursValid && <span className="w-full text-xs text-destructive">Use 0.5 to 16 hours.</span>}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold"><Camera className="h-4 w-4 text-muted-foreground" />Punch photos <UnsavedDot show={daysDirty} /></p>
        <p className="text-xs text-muted-foreground">Turn photos on per device above. Photos are kept on the server (not in backups) and deleted automatically after:</p>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Input type="number" inputMode="numeric" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className={cn("w-24", !daysValid && "border-destructive")} aria-invalid={!daysValid} data-testid="input-photo-days" />
          days
          {!daysValid && <span className="w-full text-xs text-destructive">Use 1 to 3650 days.</span>}
        </div>
      </div>
      {dirty && !inPage && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={discard}>Cancel</Button>
          <Button size="sm" disabled={busy} onClick={saveHere}>{busy && <Loader2 className="animate-spin" />}Save</Button>
        </div>
      )}
    </div>
  );
}
