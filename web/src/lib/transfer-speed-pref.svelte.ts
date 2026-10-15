// UI mirror of the upload speed preference. The preference itself (validation,
// persistence, what uploads read) lives in the pure transfer-control.ts so that
// stored-file.ts never imports a runes module; this file only makes it reactive
// for components.
import { currentSpeedPref, saveSpeedPref, type SpeedPref } from "./transfer-control";

export { parseSpeedPref } from "./transfer-control";

/** Offered limits, bytes per second (shown as Mbit/s of request payload). */
export const CAP_CHOICES: readonly number[] = [
  32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1 << 20, 2 << 20, 5 << 20, 10 << 20,
];

let pref = $state(currentSpeedPref());

export function speedPref(): SpeedPref {
  return pref;
}

export function setSpeedPref(next: SpeedPref): void {
  pref = saveSpeedPref(next);
}

/** Re-read after another tab changed it (storage event) or in tests. */
export function reloadSpeedPref(): void {
  pref = currentSpeedPref();
}
