/** A countdown or elapsed time for a HUD, as m:ss, rounding up so a clock reads 0:00 only once time is up. */
export function formatClock(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}
