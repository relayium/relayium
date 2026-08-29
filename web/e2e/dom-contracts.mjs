/**
 * Selectors that a real-browser runner and a jsdom unit test must agree on.
 *
 * Why this file exists, concretely. `mixed-link.mjs` used to carry its own
 * literal `.fname` and a bare `li` count for the outbound queue. When
 * `QueuedBatches.svelte` was recomposed on top of `PendingFiles.svelte` the
 * markup became one outer `.batch` wrapping N inner file rows, and the name
 * moved to `.file-name`. Nothing failed at the moment of the change: the unit
 * test asserted the new shape with its own private literals, and the browser
 * suite — which is not a CI gate — only went red the next time somebody ran it
 * by hand, weeks later, reporting `rows: 3` and an empty `names` array that
 * then threw `undefined.includes` instead of naming the drift.
 *
 * A selector is a contract between two files. Written twice it is not a
 * contract, it is two copies that drift silently and are discovered late. Here
 * it is written once, consumed by the browser runner (which cannot run on every
 * push without a Go server and a real Chrome) and asserted against the actual
 * rendered component by an ordinary Vitest file (which runs on every push). The
 * cheap lane is what fails first when the DOM moves.
 *
 * Plain string constants and nothing else: this module is imported both by
 * Node runners and, through `web/src/lib/QueuedBatches.test.ts`, by the
 * typechecked Web program. It must stay free of imports and side effects.
 */

/**
 * The outbound file queue on a mixed link — `QueuedBatches.svelte` composing
 * `PendingFiles.svelte`.
 *
 * The nesting is the part that matters and the part that broke: `batch` is one
 * queued *selection*, `fileRow` is one file inside it, and a runner that counts
 * `li` without saying which of the two it means gets a number that is neither.
 * Query `fileRow` and `fileName` scoped to a `batch` element, never to the card.
 */
export const QUEUED = {
  /** The whole queue card. Absent entirely when nothing is queued. */
  card: ".queued",
  /** One queued batch = one selection the user made while a transfer was live. */
  batch: ".batch-list > .batch",
  /** Per-batch cancel. One per batch, routed by batch id. */
  cancel: ".queued-cancel",
  /** One file inside a batch. Scope this to a `batch` element. */
  fileRow: ".file-list li",
  /** The file's display name inside a row (a `<bdi>`, not a `<span>`). */
  fileName: ".file-name",
};
