// Whether a finished publication earns the user an "open the folder" button.
//
// ## Why this is a module and not four lines in the handler
//
// It is a POLICY, and it is the kind that is wrong quietly. "Issue a receipt"
// reads as bookkeeping; what it actually does is decide when this app offers to
// walk somebody to a folder and say "here are your files". Getting that wrong
// does not throw, does not fail a build and does not show up in a log — it
// shows up as a person opening a folder that does not contain what they were
// told it contains.
//
// So it lives where it can be exercised directly. The host wires the registry,
// the emitter and the document; this decides, and the test that checks the
// decision calls THIS, not a copy of it written to match.

import type { PublishReport } from "../../shared/ipc-contract.js";
import type { ReceiveReceipt } from "../../shared/receive-receipt.js";
import type { ReceiptOwner } from "../io/receipt-registry.js";

/** Where a receive wrote, and on whose authority. Main's, never a renderer's. */
export interface ReceiveTarget {
  readonly directory: string;
  readonly owner: ReceiptOwner;
}

export interface ReceiptIssueDeps {
  /** The real registry's `register`. Answers `null` when it will not mint one. */
  readonly register: (directory: string, owner: ReceiptOwner, fileCount: number) => ReceiveReceipt | null;
  /** Push to ONE document — the one that asked for this receive. */
  readonly emit: (document: number, receipt: ReceiveReceipt) => void;
}

/**
 * Issue a receipt for a publication, if the publication earned one.
 *
 * ## Only `complete`
 *
 * `complete` is the one status meaning every declared item reached its final
 * name. The other two are deliberately not issued one, including the cases
 * where files genuinely exist on disk:
 *
 *   - `partial` stopped at a conflict. The screen says some files did not
 *     arrive, and a button beside that reading "open the folder" invites
 *     someone to go and confirm a batch that is not there.
 *   - `failed` can carry `published` — publication succeeded and only the
 *     teardown after it failed — but what the user is shown is a failure, and
 *     a reveal offered next to it contradicts the app's own account of events.
 *
 * Neither refusal claims nothing was written. `residue` and `published` already
 * say that, truthfully and separately. This declines to attach "here it is" to
 * an outcome the app has just called incomplete.
 *
 * Returns what it issued, for the caller's own accounting. Never a path.
 */
export function issueReceipt(
  report: PublishReport,
  target: ReceiveTarget | null,
  deps: ReceiptIssueDeps,
): ReceiveReceipt | null {
  if (report.status !== "complete") return null;
  // A publication whose lease could not be identified has no owner and no
  // folder this process is willing to name. There is nothing honest to mint.
  if (target === null) return null;
  const receipt = deps.register(target.directory, target.owner, report.publishedCount);
  if (receipt === null) return null;
  // The ORIGINATING document, not the current one. This is authority to reveal
  // one folder, granted to the page that asked for that receive — a replacement
  // page must not inherit a button for a transfer it did not make.
  deps.emit(target.owner.document, receipt);
  return receipt;
}
