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

/**
 * The inbound file consent card — `App.svelte`'s `section.ui-card.request`
 * composing `ReceiveActions.svelte`.
 *
 * **The two action selectors are named for their PRESENTATION, not for what
 * they do, and that is deliberate.** `ReceiveActions` renders two different
 * action rows, and the meanings are opposite between them:
 *
 *   - the ordinary row — `primary` accepts, `ghost` declines;
 *   - the large-batch memory warning (`warning`) — `primary` **declines**, and
 *     the only way forward is an explicit "receive anyway" `ghost`. There is no
 *     plain accept button in that branch at all; that inversion is the whole
 *     safety property, since accepting is the user gesture that opens the save
 *     picker and starts spending ~2× the batch size in memory.
 *
 * An earlier version of this module called them `accept` and `decline`. That is
 * the one thing a shared identifier here must not do: under the warning,
 * `RECEIVE.accept` *is* the decline button, so the name would state the opposite
 * of the truth in every reader's editor, at the exact moment the reader is
 * deciding whether a click is safe. `primary`/`ghost` say only what is knowable
 * without the branch — which button is which — and force the caller to establish
 * the branch before claiming a meaning.
 *
 * So a runner that clicks `RECEIVE.primary` is asserting the ordinary branch and
 * must prove it: read `warning` first, and treat its presence as a failure
 * rather than as a reason to click the other one. Both branches are pinned
 * against real rendered markup by `src/lib/ReceiveActions.test.ts`.
 */
export const RECEIVE = {
  /** The whole consent card. Absent entirely when nothing awaits consent. */
  card: ".request",
  /** The card's heading — who is sending, how many files, how large. */
  head: ".req-head",
  /** The scrollable manifest of what is being consented to. */
  fileList: ".filelist",
  /** One file's name inside that manifest. Scope to `fileList`. */
  fileName: ".fname",
  /** The row's primary button. Accepts on the ordinary row; **declines** under
   *  `warning` — see above. Never click it without reading `warning` first. */
  primary: ".btn-primary",
  /** The row's ghost button. Declines on the ordinary row; is the explicit
   *  "receive anyway" under `warning`. Same rule. */
  ghost: ".btn-ghost",
  /** The large-batch memory warning. Present ⇒ the two above are swapped. */
  warning: ".memwarn",
  /** "What pressing the accepting button will do" — a picker, or the download
   *  directory. Which button that is depends on `warning`. */
  saveHint: ".savehint",
};

/**
 * One transfer card — `App.svelte`'s `section.ui-card.xfer`, one per direction.
 *
 * `progressBar` is the subject of stranded unique #6 (live `role="progressbar"`
 * accessibility during an in-flight transfer), and its **absence is load-bearing
 * in both directions**, which is why it is written here rather than inline:
 *
 *   - it renders only inside `{#if !xf.done}`, so `card && !progressBar` is how
 *     a runner proves a batch reached a terminal state;
 *   - and `card && progressBar` is how a runner proves a transfer is genuinely
 *     in flight — the only moment at which the live accessibility scan of it
 *     asserts anything at all.
 *
 * A progress bar that stopped being removed on completion, or stopped being
 * rendered during flight, breaks a different assertion in each case, and both
 * read as something else entirely. `workspace-orchestration.test.ts` pins the
 * branch it lives in against `App.svelte`'s actual markup.
 */
export const XFER = {
  /** One transfer card, one direction. */
  card: ".xfer",
  /** Completed successfully — `class:ok`. */
  ok: ".xfer.ok",
  /** Completed unsuccessfully — `class:bad`. */
  bad: ".xfer.bad",
  /** The status line. `aria-live="polite"`, so it is also what gets announced. */
  status: ".xfer .status",
  /**
   * The in-flight progress bar. `role="progressbar"`, named by the card's own
   * heading through `aria-labelledby`. Present ⇔ the transfer is not done.
   */
  progressBar: ".xfer .progress-bar",
  /**
   * The same node, relative to a `card` element rather than to the document.
   *
   * Both forms are needed and neither substitutes for the other: `progressBar`
   * answers "is any transfer in flight on this page", `bar` answers "is THIS
   * card's transfer in flight" — which is the only form that can pair a bar with
   * the heading that names it.
   */
  bar: ".progress-bar",
  /** The card's heading, and the progress bar's accessible name. Also valid
   *  relative to a `card` element, since `.xfer-head` is inside it. */
  label: ".xfer-head .label",
  /**
   * A per-card verification code. On a mixed link this must be **zero**: the
   * link owns one SAS and the workspace header shows it. Counted by `oneSas`.
   */
  laneCode: ".xfer .status code",
};
