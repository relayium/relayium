// A runes module whose only job is to let a plain `.test.ts` change a mounted
// component's props.
//
// Same reason effect-probe.svelte.ts exists: runes are a COMPILER feature, so a
// `*.test.ts` cannot write `$state` itself. `mount(C, { props })` reads a plain
// object once and never again, which makes "what happens when this prop changes
// while an async answer is in flight" untestable — and that is exactly the class
// of bug a stale-response guard exists to prevent, so it must not be the class
// of bug the suite cannot reach.
//
// Test support: nothing in the product imports it.

/**
 * Wrap `initial` in a `$state` proxy and hand it back, so `mount(C, { props })`
 * receives something a test can mutate afterwards.
 *
 * Assign to a field and call `flushSync()` from "svelte" to settle the render:
 *
 *   const props = reactiveProps({ roomCode: "" });
 *   mount(CodePairing, { target, props });
 *   props.roomCode = "483920";
 *   flushSync();
 */
export function reactiveProps<T extends object>(initial: T): T {
  const proxied = $state(initial);
  return proxied;
}
