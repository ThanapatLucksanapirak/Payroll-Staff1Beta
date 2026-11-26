// Helpers that keep time-based tests independent of the time of day.
/**
 * A fixed-offset time zone where it is around midday right now, so tests that
 * put punches a few hours in the past still land on "today" on the Live page,
 * whatever time of day the suite runs.
 */
let picked: string | null = null;
export function middayZone(): string {
  if (picked) return picked; // the same zone for the whole run
  const now = Date.now();
  const off = 12 - new Date(now).getUTCHours(); // local = UTC + off, between -11 and +12
  picked = off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
  return picked;
}
