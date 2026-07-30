/**
 * A token bucket, shaped after the server's own signalling limiter
 * (`server/internal/signal/connlimit.go`: burst 50, refill 10/s) so the two ends
 * of the system throttle abuse the same way.
 *
 * Pure and clock-injected: the flood guard is worth testing, and a guard that can
 * only be tested by waiting in real time does not get tested.
 */
export function createRateBucket(burst: number, perSec: number, now: () => number) {
  let tokens = burst;
  let last = now();
  return {
    /** Spend one token. False when the caller is over its rate. */
    take(): boolean {
      const t = now();
      // A clock that went backwards must not mint tokens. Date.now() does jump
      // — NTP corrections, a laptop waking — and the fix is to ignore the jump,
      // not to trust it.
      if (t > last) {
        tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
        last = t;
      }
      // Whole tokens only: a fractional allowance would let a peer sustain
      // slightly above the configured rate forever.
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
