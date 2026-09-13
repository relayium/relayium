// A journal phase to the catalogue key that says it.
//
// Its own module so a test can hold it against the journal's runtime `PHASES`
// list. Those are two independent declarations of the same fact — a type the
// page maps over, and an array the journal validates against — and nothing
// forces them to agree.
//
// Total over `TaskPhase`, so a seventh phase is a compile error here. The
// function this replaced took a `string` and fell through to
// `inboxReceiptBlocked`, which does not blank the row: it tells the user their
// delivery is blocked. For an unrecognised phase that would be a claim about
// somebody's files that nobody had checked.
import type { TaskPhase } from "../../shared/ipc-contract.js";

export const PHASE_KEY = {
  acked: "inboxReceiptSaved",
  published: "inboxReceiptAckPending",
  partial: "inboxReceiptPartial",
  failed: "inboxReceiptFailed",
  claimed: "inboxReceiptWorking",
  publishing: "inboxReceiptWorking",
} as const satisfies Record<TaskPhase, string>;
