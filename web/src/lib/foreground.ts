/**
 * Stall detection that survives a phone putting the tab to sleep.
 *
 * A transfer's stall watchdog compares wall-clock time against the last byte
 * that arrived. That is right while the page is running, and wrong the moment
 * it is not: Android suspends a backgrounded tab, so a user who switches apps
 * for a minute — or takes a call — comes back to a watchdog that sees a minute
 * of silence and fails a transfer that was never actually stalled. The screen
 * wake lock covers the screen locking; it does not cover app switching.
 *
 * So the watchdog measures against the later of "last byte" and "last time this
 * page was in the foreground". Coming back from the background grants one fresh
 * window rather than an instant failure, and a connection that really is dead
 * still fails one window later.
 */

let lastVisibleAt = Date.now();

if (typeof document !== "undefined") {
  // One listener for the whole page: sessions come and go, this does not.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") lastVisibleAt = Date.now();
  });
}

/** When this page was last in the foreground. */
export function lastForegroundAt(): number {
  return lastVisibleAt;
}

/**
 * Has this transfer been quiet for `stallMs` of time it could have progressed
 * in? Pure, so the interesting cases are unit-testable without a real document.
 */
export function stalled(now: number, lastActivity: number, foregroundAt: number, stallMs: number): boolean {
  return now - Math.max(lastActivity, foregroundAt) > stallMs;
}
