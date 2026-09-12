// Inbox SEND, as a feature of this process.
//
// `src/main/inbox/send-*.ts` is the accepted sender: it owns the durable plan,
// the idempotency key, the device_task session, the convergence of an ambiguous
// attempt, and the fences that make an account change safe. It does NOT own the
// set of jobs a running app has, which document asked for one, or when a quit
// may refuse a new one — the same division `features/inbox.ts` draws for
// receive, and `features/stored-send.ts` for stored.
//
// ## The lifecycle vocabulary is the COORDINATOR's, and is adopted verbatim
//
// This is deliberately not the shape the other two features use, because the
// coordinator already states its own and re-inventing it would be a second
// answer to a question that has one:
//
//   * `fence()` closes admissions ONLY, before quit consent; nothing running
//     stops. `resumeAdmissions()` is Stay. `quiesce()` drains. `dispose()` is
//     terminal.
//   * `invalidateAccount` returning `quiet: false` means **RETAIN and JOIN** —
//     it is not a successful disposal, and treating it as one would drop a job
//     that is still live.
//   * `invalidateDocument` returns quiet/remembered; an overflow permanently
//     closes the coordinator, and there are NO evictions.
//
// ## What the outcome union already forces on the UI
//
// Three of its four members are not success, and two of them are routinely
// mishandled:
//
//   * `delivered` carries `created`, but **`task.State` is the truth**;
//     `created` is a creation flag, not a delivery state.
//   * `unknown` means a delivery MAY be live. Nothing was released; the plan,
//     its idempotency key and its object are retained so a LATER ATTEMPT
//     CONVERGES. The page must offer convergence — never a fresh send, which
//     would be a second delivery of the same thing.
//   * `refused.orphanedObject` is explicitly NOT a client obligation: central's
//     collector reclaims it, and `DELETE /api/files/{id}` refuses a task-purpose
//     object by design. It is reported, never presented as owed work.
//
// ## What crosses to the renderer
//
// The same split as stored send: the renderer holds the user's `File` objects
// and runs the production shared `encryptFiles`, main receives ciphertext
// frames, and the bearer never leaves this process. One content key belongs to
// ONE immutable selection — `manifestDigest` is frozen at `begin` and every
// later step is checked against it, so a re-pick is a NEW job with a NEW key
// rather than a re-run against changed plaintext.

import type { TaskState } from "../../shared/ipc-contract.js";
import type { AccountContext } from "../inbox/account.js";
import type { AuthorityInput } from "../stored/upload/authority.js";
import type { SendOutcome } from "../inbox/send-coordinator.js";
import type { SenderTask } from "../inbox/send-wire.js";
import type { EligibleTarget } from "../inbox/send-target.js";

// ---------------------------------------------------------------------------
// Account and target-list lifetime — the invariants, before any composition
// ---------------------------------------------------------------------------
//
// ## The list of devices you can send to is MAIN's, and it is account-scoped
//
// `EligibleTarget` carries the target's CURRENT public key, its capability set
// and its inbox policy. All three are answers about one account's devices at
// one moment, so the list:
//
//   1. is captured under an account EPOCH and is never read across one. A list
//      fetched before a sign-out describes devices the new user does not have,
//      and sealing a content key to one of them would hand this account's file
//      to the previous account's device.
//   2. is invalidated by the same authority change that invalidates everything
//      else — `invalidateAccount` on the coordinator, and dropped here — rather
//      than expiring on a timer nobody chose.
//   3. is REFRESHED before a seal, not merely reused. `keyChanged(sealedTo,
//      current)` exists because a target can rotate its key between the list
//      being shown and a send being started; sealing to a stale key produces a
//      delivery the target can never open.
//   4. never outlives the document that asked, for the choosing UI. The list is
//      main's; the SELECTION belongs to a page, and a reload chooses again.
//
// ## What may reach a diagnostic, and what may not
//
// Nothing in this feature logs or emits:
//
//   * a private key — none exists on this side of a send; the content key is
//     sealed to the target and the sealing happens in the coordinator;
//   * a target's PUBLIC key or key id. It is key material, it identifies a
//     device, and a diagnostic is not a place for either;
//   * a device NAME. The renderer needs names to let a person choose a target,
//     so they cross the IPC boundary as display data — but they are the user's
//     own device names, and they do not go into logs, failure text or
//     telemetry. Diagnostics name a device by its central id at most.
//
// A refusal reaching the page is a closed token from `TargetIneligible` or the
// coordinator, never a server string and never a name.

/** A target as the CHOOSING UI may see it. Display data, deliberately narrow. */
export interface InboxSendTargetView {
  /** Central's device id. The only identifier a diagnostic may carry. */
  readonly deviceID: string;
  /** The user's own name for the device. Display only — never logged. */
  readonly name: string;
  /** Whether this build can send to it at all, per the target's capabilities. */
  readonly eligible: boolean;
  /** A closed refusal token when it is not. Never a server string. */
  readonly refusal: string | null;
}

/**
 * Narrow a target for the page.
 *
 * The key, the key id, the generation and the algorithm all stay in main: the
 * page chooses a DEVICE, and everything cryptographic about that choice is the
 * coordinator's. A renderer that held a target's key could seal to it, which is
 * the whole thing this boundary prevents.
 */
export function describeTarget(
  target: EligibleTarget,
  name: string,
  refusal: string | null,
): InboxSendTargetView {
  return describeDevice(target.deviceID, name, refusal);
}

/**
 * The same narrowing, from a device ROW that has no key read behind it.
 *
 * The picker lists every device on the account, and `assertEligible` needs the
 * target's KEYS — one request per row, every time the list is shown. So the
 * list is built from the row alone and the key read stays where it belongs: in
 * the coordinator, immediately before the seal, which is also the only place
 * that can catch a rotation between listing and sending.
 *
 * Taking ids and a refusal rather than a synthetic `EligibleTarget` is
 * deliberate: a stand-in with an empty key would put a value shaped like key
 * material into a path whose whole purpose is that none exists.
 */
export function describeDevice(deviceID: string, name: string, refusal: string | null): InboxSendTargetView {
  return {
    deviceID,
    name,
    eligible: refusal === null,
    refusal,
  };
}

/** What one send looks like to a page. Closed codes and counts only. */
export type InboxSendView =
  /**
   * Central holds a task.
   *
   * `state` is the server's own, which is the truth about the delivery.
   * `created` says only whether THIS attempt was the one that created it — a
   * converged retry reports `false` and is just as delivered.
   */
  | { readonly kind: "delivered"; readonly created: boolean; readonly state: TaskState }
  | { readonly kind: "cancelled"; readonly state: string | null }
  /**
   * The outcome could not be established and a delivery may be live.
   *
   * The page offers CONVERGENCE — the same attempt again, against the retained
   * plan and idempotency key — and never a fresh send, which would risk
   * delivering the same thing twice.
   */
  | { readonly kind: "unknown"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly retryable: boolean;
      /** Reported so a host can say so. NOT work the user owes. */
      readonly orphanedObject: boolean;
    };

/** The authority a send is admitted under. Captured; never looked up later. */
export interface InboxSendAuthority {
  readonly context: AccountContext;
  readonly input: AuthorityInput;
  readonly epoch: number;
  /** The document that asked. One document, one job. */
  readonly document: number;
}

/**
 * The coordinator's outcome, as a page may see it.
 *
 * `task.State` is carried through and `created` is kept beside it rather than
 * collapsed into it, because they answer different questions and a UI that
 * showed `created` as the delivery state would report a converged retry as
 * though nothing had been delivered.
 */
export function describeSendOutcome(outcome: SendOutcome): InboxSendView {
  switch (outcome.kind) {
    case "delivered":
      return {
        kind: "delivered",
        created: outcome.created,
        state: taskState(outcome.task),
      };
    case "cancelled":
      return { kind: "cancelled", state: outcome.task === null ? null : taskState(outcome.task) };
    case "unknown":
      // Carried through unchanged. Collapsing it into `refused` would assert
      // nothing was delivered, which is the one thing this outcome means the
      // process cannot establish.
      return { kind: "unknown", reason: outcome.reason };
    default:
      return {
        kind: "refused",
        reason: outcome.reason,
        retryable: outcome.retryable,
        orphanedObject: outcome.orphanedObject,
      };
  }
}

/** The server's own state token, defensively read. */
/**
 * The task's state, as the type already says it is.
 *
 * This used to cast through `unknown` back to `string` and answer `"unknown"`
 * for anything else — inventing an eleventh value that is not a `TaskState`,
 * and throwing away a guarantee that already held. `WireTask.State` is typed
 * `TaskState`, and `SendTransport.parseTask` refuses a response whose `State`
 * is not in `TASK_STATES`, so a task that exists has a state from the set.
 *
 * The laundering is what let `InboxSendView.delivered.state` be `string` all
 * the way to a screen that then matched two values out of ten.
 */
function taskState(task: SenderTask): TaskState {
  return task.State;
}

/**
 * Whether an outcome may be retried by sending AGAIN, or must converge.
 *
 * The distinction the whole union exists for. `unknown` retains its plan and
 * its idempotency key precisely so the same attempt can be replayed; issuing a
 * NEW send for it would create a second task for one user action.
 */
export function retryShape(view: InboxSendView): "converge" | "fresh" | "none" {
  if (view.kind === "unknown") return "converge";
  if (view.kind === "refused" && view.retryable) return "fresh";
  return "none";
}
