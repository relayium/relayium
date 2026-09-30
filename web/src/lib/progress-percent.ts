/**
 * Percentage for a progress bar that must not claim completion early.
 *
 * Every byte having left (or arrived) is not the same as the operation being
 * done: a stored upload still has to be finalized by the server, and a realtime
 * transfer still has to be verified and acknowledged. Until the caller says the
 * result is confirmed, the figure is held at 99 so "100 %" only ever appears
 * for something that actually finished (audit W3, 2026-09-28).
 */
export function progressPercent(done: number, total: number, confirmed: boolean): number {
  if (!(total > 0)) return confirmed ? 100 : 0;
  const p = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  return confirmed ? p : Math.min(99, p);
}
