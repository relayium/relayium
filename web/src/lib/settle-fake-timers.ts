// Test support, not product code: imported only by `*.test.ts`.
//
// The stored-download suites run their reconnect backoff on a FAKE clock while
// the decryption under test is REAL WebCrypto, whose results come back as real
// event-loop tasks. A helper that advances the fake clock a fixed number of
// times and then awaits has a race built in: on a machine where decrypt is
// slower (hosted CI), the advances run out before the download reaches its
// backoff, the backoff timer is installed afterwards, nothing advances it, and
// the test hangs to its timeout. That failed hosted `web` on 59c4d152
// (stored-download) and again on 9fff9258 (stored-file), because the first fix
// lived in one test file and its twin kept the old loop. One helper, so the
// correction cannot be applied to half of its callers again.
import { vi } from "vitest";

/** The real timer, captured at import — before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;

/** Yield one real event-loop turn: real WebCrypto results and stream reads land here. */
export function realTurn(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

/**
 * Drive fake timers until `p` settles, and return its value or its rejection.
 *
 * Progress-driven, not count-driven: each round yields a real turn, then moves
 * the fake clock to the next pending fake timer only if one exists. There is no
 * iteration cap and no large clock jump; the bound is the calling test's own
 * timeout, so a genuine hang still fails — a slow machine no longer does.
 */
export async function settleWithFakeTimers<T>(p: Promise<T>): Promise<T | Error> {
  let settled = false;
  let result: T | Error = undefined as T;
  p.then(
    (v) => { result = v; settled = true; },
    (e: Error) => { result = e; settled = true; },
  );
  while (!settled) {
    await realTurn();
    if (!settled && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  return result;
}
