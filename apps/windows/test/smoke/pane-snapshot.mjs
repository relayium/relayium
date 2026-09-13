// What the link pane was showing when a watch gave up.
//
// The realtime lane's round-1 timeout used to report exactly this:
//
//   no inbound consent card within 120000ms
//   (the 120000ms watch budget elapsed)     peak: []   final: []
//
// Which observation was missing, and nothing about the state it was missing
// FROM. Diagnosing it meant reasoning from absence — twice: once on
// 2026-09-12, and again on 2026-09-13, where separating a flake from a
// regression took a re-run plus an argument about which code path was
// reachable. This lane drives a real server, a real browser and a real
// transport, so it is both the likeliest place for a genuine defect and the
// most expensive place to reproduce one.
//
// So the timeout describes itself. The rules it follows:
//
//  - It reports what is PRESENT and says nothing about what that means. A
//    snapshot that guessed a cause would be the same overclaim as the bare
//    timeout it replaces.
//  - A CLOSED list of markers, below. NEVER a dump of the DOM: the round moves
//    real files between real peers, and file names, peer names and paths are
//    precisely what must not reach a CI log.
//  - Timeout only. A round that worked prints what it always printed.

/**
 * The terminal receipts `LinkPane` can render, in the order the watch tests them.
 *
 * Exported so the snapshot can fold them in rather than restate them: a renamed
 * receipt cannot then drop out of the report while still being watched.
 */
export const RECEIPT_MARKERS = ["recv-saved", "recv-failed", "recv-partial", "recv-cancelled", "recv-failed-saved"];

/**
 * Every pane state worth naming in a timeout, and no others.
 *
 * Chosen to separate the ways a round gets stuck: no pane at all, a pane that
 * never got past the opening handshake, one waiting on a consent the peer never
 * gave, and one that reached a receipt the watch did not recognise.
 */
export const PANE_HOOKS = [
  "link-status", "link-end-reason", "link-lane-reason", "link-restart", "link-cancel",
  "sas", "sas-pending", "sas-confirm",
  "message", "send", "history", "text-incoming", "text-accept", "text-error",
  "recv-accept", "recv-decline", "drop-refused",
  ...RECEIPT_MARKERS,
];

/**
 * The page-side read, as one expression.
 *
 * ONE eval rather than one per marker: twenty-two sequential round trips
 * against a live page is not a snapshot. The round can advance between the
 * first read and the last, and the report would describe a state that never
 * existed.
 */
export const SNAPSHOT_EXPR = `(() => {
  const has = (n) => document.querySelector('[data-test="' + n + '"]') !== null;
  const present = ${JSON.stringify(PANE_HOOKS)}.filter(has);
  const status = document.querySelector('[data-test="link-status"]')?.textContent?.trim() ?? "";
  return { present, status };
})()`;

/**
 * The sentence a timeout stops on.
 *
 * An empty screen and a screen full of state are different failures — the first
 * says the round never got a pane, the second says it got one and stalled — and
 * the reader needs to tell them apart before deciding what to look at.
 */
export function stoppedBecauseFor(budgetMs, present) {
  return present.length === 0
    ? `the ${budgetMs}ms watch budget elapsed with NO pane state on screen at all`
    : `the ${budgetMs}ms watch budget elapsed while showing ${present.join(", ")}`;
}
