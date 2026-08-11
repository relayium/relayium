// A runes module whose only job is to let a plain `.test.ts` observe real Svelte
// reactivity.
//
// Runes are a COMPILER feature: `$effect` only exists in a `.svelte` component
// or a `.svelte.ts` module, and a Vitest file named `*.test.ts` is neither. So a
// test that wants to assert "this effect re-runs when that store changes" cannot
// write the effect itself — and without one, a reactivity claim can only be
// checked by reading the source and believing it.
//
// That distinction is not academic here. `outbox.svelte.ts` keeps the file list
// and the per-entry upload state in two arrays, and a state transition rewrites
// only the second one. Whether a reader re-runs therefore depends entirely on
// WHICH of the two it touched — the difference between a released file and one
// stranded in neither transport (see stagedCount). This probe is what makes that
// difference an executed test instead of a comment.
//
// Test support: nothing in the product imports it.

/**
 * Run `read` inside a real effect and collect every value it produces.
 *
 * Returns the collected array (which grows as the effect re-runs) and a
 * `stop()`. Call `flushSync()` from "svelte" after mutating a store to settle
 * the effect before asserting.
 */
export function trackEffect<T>(read: () => T): { values: T[]; stop: () => void } {
  const values: T[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      values.push(read());
    });
  });
  return { values, stop };
}

/**
 * The same, but with a `$derived` between the store and the effect.
 *
 * A different question, and the only one that can answer "how OFTEN does this
 * fire". `$effect` re-runs whenever anything it touched changed; `$derived`
 * compares its new value with its old one and does not notify when they are
 * equal. So a derived over a fresh ARRAY re-fires on every unrelated transition
 * of the store it read, while a derived over a primitive settles — and the
 * reader downstream of it re-sends a whole key set every time it wakes.
 *
 * Only a real derived can show that difference, which is why it lives here and
 * not in the test file.
 */
export function trackDerived<T>(read: () => T): { values: T[]; stop: () => void } {
  const values: T[] = [];
  const stop = $effect.root(() => {
    const value = $derived(read());
    $effect(() => {
      values.push(value);
    });
  });
  return { values, stop };
}
