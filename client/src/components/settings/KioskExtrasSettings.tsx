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

const LOGIN_LABELS: Record<DeviceLoginMode, string> = { site: "Same as location", pin: "PIN only", name_pin: "Name list, then PIN" };

/** The options of one kiosk device, saved as soon as they change. */
export function DeviceOptionsPanel({ siteId, deviceId, options, hasStations }: { siteId: string; deviceId: string; options?: KioskDeviceOptions; hasStations: boolean }) {
  const { toast } = useToast();
  const [o, setO] = useState<KioskDeviceOptions>(options ?? DEFAULT_DEVICE_OPTIONS);
  const [idle, setIdle] = useState(String(o.idleSeconds));
  useEffect(() => { if (options) { setO(options); setIdle(String(options.idleSeconds)); } }, [options]);

  const save = async (patch: Partial<KioskDeviceOptions>) => {
    const prev = o;
    setO({ ...o, ...patch });
    try {
      await api("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, patch);
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "kiosk-devices"] });
    } catch (e) {
      setO(prev);
      toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" });
    }
  };
  const commitIdle = () => {
    const n = Math.round(Number(idle));
    if (!Number.isFinite(n) || n < IDLE_MIN || n > IDLE_MAX) { setIdle(String(o.idleSeconds)); toast({ title: `Use ${IDLE_MIN} to ${IDLE_MAX} seconds`, variant: "destructive" }); return; }
    if (n !== o.idleSeconds) void save({ idleSeconds: n });
  };

  return (
    <div className="space-y-2 bg-foreground/[0.015] px-3 pb-3 pt-2" data-testid={`device-options-${deviceId}`}>
      <ToggleRow label="Photo with each punch" hint="A small front-camera snapshot. If the camera is blocked, the punch still goes through." checked={o.photo} onChange={(v) => save({ photo: v })} testid={`switch-device-photo-${deviceId}`} />
      <ToggleRow
        label="Ask for a station at clock-in"
        hint={hasStations ? "Employees pick from the location's station list below." : "Add stations below to use this."}
        checked={o.stations} onChange={(v) => save({ stations: v })} testid={`switch-device-stations-${deviceId}`}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sign-in on this device">
          <Select value={o.loginMode} onValueChange={(v) => save({ loginMode: v as DeviceLoginMode })}>
            <SelectTrigger data-testid={`select-device-login-${deviceId}`}><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(LOGIN_LABELS) as DeviceLoginMode[]).map((k) => <SelectItem key={k} value={k}>{LOGIN_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Back to the start screen after" hint="Seconds without a touch on the PIN and action screens.">
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="numeric" min={IDLE_MIN} max={IDLE_MAX} value={idle} onChange={(e) => setIdle(e.target.value)} onBlur={commitIdle} onKeyDown={(e) => { if (e.key === "Enter") commitIdle(); }} className="w-24" data-testid={`input-device-idle-${deviceId}`} />
            <span className="text-[13px] text-muted-foreground">seconds</span>
          </div>
        </Field>
      </div>
    </div>
  );
}

/** Stations, break reminder and photo retention for a location (saved right away). */
export function KioskLocationExtras({ site }: { site: Site }) {
  const { toast } = useToast();
  const key = ["/api/sites", site.id, "kiosk-config"];
  const q = useQuery<KioskSiteConfig>({ queryKey: key });
  const [station, setStation] = useState("");
  const [hours, setHours] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const cfg = q.data;
  useEffect(() => {
    if (!cfg) return;
    setHours(cfg.breakReminderHours ? String(cfg.breakReminderHours) : "5");
    setDays(String(cfg.photoRetentionDays));
  }, [cfg]);

  const save = async (patch: Partial<KioskSiteConfig>, done?: string) => {
    setBusy(true);
    try {
      const next = await api<KioskSiteConfig>("PUT", `/api/sites/${site.id}/kiosk-config`, patch);
      queryClient.setQueryData(key, next);
      void queryClient.invalidateQueries({ queryKey: ["/api/sites", site.id, "timeclock"] });
      if (done) toast({ title: done });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  if (q.isLoading || !cfg) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  const addStation = () => {
    const s = cleanStation(station);
    if (!s) return;
    if (cfg.stations.some((x) => x.toLowerCase() === s.toLowerCase())) { setStation(""); return; }
    void save({ stations: [...cfg.stations, s] }).then(() => setStation(""));
  };
  const hoursNum = Number(hours);
  const reminderOn = !!cfg.breakReminderHours;

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold"><MapPin className="h-4 w-4 text-muted-foreground" />Stations</p>
        <p className="text-xs text-muted-foreground">At clock-in, employees tap where they're working (for example Sushi bar, Kitchen, Front). It shows on Live. Leave empty to skip the question.</p>
        {cfg.stations.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" data-testid="list-stations">
            {cfg.stations.map((s) => (
              <li key={s} className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] py-1 pl-3 pr-1 text-[13px] font-medium">
                {s}
                <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-destructive" aria-label={`Remove ${s}`} disabled={busy} onClick={() => save({ stations: cfg.stations.filter((x) => x !== s) })}><X className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
        {cfg.stations.length < MAX_STATIONS && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addStation(); }}>
            <Input value={station} maxLength={40} onChange={(e) => setStation(e.target.value)} placeholder="e.g. Sushi bar" className="max-w-xs" data-testid="input-station" />
            <Button type="submit" variant="outline" disabled={busy || !station.trim()} data-testid="button-add-station"><Plus /> Add</Button>
          </form>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-[13px] font-semibold"><Coffee className="h-4 w-4 text-muted-foreground" />Break reminder</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Nudge employees on the kiosk, and show “Break due” on Live, after this long without a break.</p>
          </div>
          <Switch checked={reminderOn} disabled={busy} onCheckedChange={(v) => save({ breakReminderHours: v ? (hoursNum > 0 ? hoursNum : 5) : null }, v ? "Break reminder on" : "Break reminder off")} data-testid="switch-break-reminder" />
        </div>
        {reminderOn && (
          <div className="flex items-center gap-2 text-[13px]">
            Remind after
            <Input type="number" inputMode="decimal" min={0.5} max={16} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} className="w-20"
              onBlur={() => { if (hoursNum > 0 && hoursNum <= 16 && hoursNum !== cfg.breakReminderHours) void save({ breakReminderHours: hoursNum }); else setHours(String(cfg.breakReminderHours)); }}
              data-testid="input-break-hours" />
            hours without a break
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-border/80 p-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold"><Camera className="h-4 w-4 text-muted-foreground" />Punch photos</p>
        <p className="text-xs text-muted-foreground">Turn photos on per device above. Photos are kept on the server (not in backups) and deleted automatically after:</p>
        <div className="flex items-center gap-2 text-[13px]">
          <Input type="number" inputMode="numeric" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="w-24"
            onBlur={() => { const n = Math.round(Number(days)); if (n >= 1 && n <= 3650 && n !== cfg.photoRetentionDays) void save({ photoRetentionDays: n }, "Saved"); else setDays(String(cfg.photoRetentionDays)); }}
            data-testid="input-photo-days" />
          days
        </div>
      </div>
    </div>
  );
}
