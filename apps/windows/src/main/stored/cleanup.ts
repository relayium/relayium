// Destinations whose teardown did not settle, kept so it can be tried again.
//
// ## Why a failed cancel is not the end of the handle
//
// `NativeHelperClient.cancel()` is explicitly retryable, and its own source
// says why: an earlier version memoised the rejection forever, so a caller
// acting on `cleanup-uncertain` got the identical rejection back with no second
// kill attempted — "the retained child reference this client's own contract
// promised was retryable never was". `runCancel` retains the child reference
// precisely so a later attempt can kill it again. Dropping the handle here
// would reintroduce exactly that bug one level up: the report would say bytes
// may remain on the user's disk while this process discarded the only thing
// that could still remove them, AND a live child process would be leaked.
//
// So a failed teardown is RETAINED, under a ticket the report carries, and the
// retry is a call the host can make later — after the volume comes back, before
// quit, or from a "clean up" affordance. There is no lifetime cap on retries: a
// retained handle is owned until its teardown is CONFIRMED, not until this
// process gets bored of asking.
//
// ## Admission is reserved BEFORE a destination exists
//
// The first version of this file checked capacity in `retain()` — that is,
// after a destination had already been created and its teardown had already
// failed. At the cap it returned null, which meant dropping ownership of a
// possibly-live child: the one outcome this module exists to prevent. Root
// caught it.
//
// So capacity is taken as a RESERVATION before the destination is opened, and
// `size` counts reservations plus retained entries. A transfer that cannot
// reserve is refused before it starts a helper, which is the only honest option:
// this process will not create a child it cannot promise to own. Claiming a
// reservation afterwards can never fail, so no code path can be left holding a
// handle with nowhere to put it.
//
// ## What is deliberately NOT retained
//
// Nothing. Every publish or teardown error carries an owned handle — including
// the post-publication case, where the earlier version of this comment was
// simply wrong: `settleAfterPublish` throws `cleanup-uncertain` with
// `residue: true` and the validated receipt WHEN THE CHILD DID NOT CLOSE AFTER
// A KILL (native-helper-client.ts:778-797). The helper has not exited there, so
// a retry has something real to do, and the published prefix must survive
// alongside the ticket rather than being replaced by a failure.

import { NativeHelperError, type NativeReceiveDestination } from "../io/native-helper-client.js";

/** How many stuck destinations this process will hold at once. */
export const MAX_RETAINED_CLEANUPS = 8;

export type CleanupRetryOutcome =
  /** The ticket is not (or no longer) held. Includes an already-clean retry. */
  | { readonly outcome: "unknown" }
  /** Teardown confirmed. The ticket is released and its slot freed. */
  | { readonly outcome: "clean" }
  /** Still unconfirmed. The ticket stays valid and may be retried again,
   *  without limit: ownership ends on confirmation, not on an attempt count. */
  | { readonly outcome: "uncertain"; readonly residue: boolean };

/**
 * A reservation used against its own contract.
 *
 * Not a runtime condition: every path that raises this is a caller bug, and
 * the alternatives are worse than an exception. Minting a second ticket from
 * one reservation would put two retained entries behind one slot and take the
 * registry past its bound; silently returning the first ticket for a DIFFERENT
 * destination would drop ownership of the second, which is the exact class of
 * bug this module exists to prevent.
 */
export class CleanupOwnershipError extends Error {
  constructor(reason: string) {
    super(`cleanup reservation misuse: ${reason}`);
    this.name = "CleanupOwnershipError";
  }
}

/**
 * A slot taken before a destination is created.
 *
 * Exactly one of `claim` and `release` is meant to be called, once. Both are
 * idempotent for the call that was actually made — a repeated `claim` of the
 * SAME destination returns the same ticket and mutates nothing, a repeated
 * `release` does nothing, and `release` after a successful `claim` is a no-op
 * because the retained entry owns the slot from then on.
 *
 * Anything else refuses. The receive path calls exactly one of these exactly
 * once, so no product path can raise it today; the refusals exist because this
 * registry is a published contract about to be wired to a host surface that
 * will hold reservations across more code than `discard` does.
 */
export interface CleanupReservation {
  /**
   * Hand over a destination whose teardown failed, and get its ticket.
   *
   * Cannot fail for the documented single call. Throws
   * `CleanupOwnershipError` for a second, different destination, or after
   * `release`.
   */
  claim(destination: NativeReceiveDestination): string;
  /** Give the slot back, for a transfer that ended owing no cleanup. */
  release(): void;
}

/**
 * The retained set.
 *
 * Process-local and not persisted: a handle is a live child process, so it
 * cannot outlive this process, and a ticket that survived a restart would name
 * something that no longer exists. Bytes left behind by a killed helper are
 * documented bounded residue under the user's chosen root, not this registry's
 * business to remember.
 */
export class CleanupRegistry {
  private readonly held = new Map<string, NativeReceiveDestination>();
  private reserved = 0;
  private next = 1;

  constructor(private readonly limit: number = MAX_RETAINED_CLEANUPS) {}

  /** Retained entries plus outstanding reservations — what the cap applies to. */
  get size(): number {
    return this.held.size + this.reserved;
  }

  /** The open tickets. Codes and counters only — no path, no filename. */
  get tickets(): readonly string[] {
    return [...this.held.keys()];
  }

  /**
   * Take a slot, or null when the cap is reached.
   *
   * Synchronous and single-statement against `size`, so two receives starting
   * concurrently cannot both take the last slot: JavaScript gives this function
   * exclusive execution, and there is no `await` inside it for a second caller
   * to interleave on.
   */
  reserve(): CleanupReservation | null {
    if (this.size >= this.limit) return null;
    this.reserved += 1;
    // The reservation remembers WHAT it claimed, not merely THAT it settled.
    // An earlier version kept only a boolean, so a second `claim` minted a
    // second ticket while the slot count moved once — two retained entries
    // behind one slot, and the bound exceeded; and a `claim` after `release`
    // created an entry with no slot behind it at all. Root caught both as
    // published-contract defects before any host wiring could reach them.
    let ticket: string | null = null;
    let owned: NativeReceiveDestination | null = null;
    let released = false;
    return {
      claim: (destination: NativeReceiveDestination): string => {
        if (ticket !== null) {
          if (owned !== destination) {
            throw new CleanupOwnershipError("one reservation holds one destination");
          }
          return ticket;
        }
        // Checked BEFORE any mutation: a refusal must leave the registry
        // exactly as it was.
        if (released) {
          throw new CleanupOwnershipError("this reservation was already released");
        }
        ticket = `stored-cleanup-${String(this.next)}`;
        this.next += 1;
        owned = destination;
        this.held.set(ticket, destination);
        // The slot moves from the reservation to the retained entry rather than
        // being freed: the same one slot, still occupied.
        this.reserved -= 1;
        return ticket;
      },
      release: (): void => {
        // After a claim the retained entry owns the slot, so this is a no-op
        // rather than a double decrement.
        if (ticket !== null || released) return;
        released = true;
        this.reserved -= 1;
      },
    };
  }

  /**
   * Reserve and claim in one step, for a destination this process already owns
   * and did not create for a transfer in flight — adopting an orphan, or a
   * probe filling the registry.
   *
   * Returns null at the cap. A receive path must NOT use this: it reserves
   * first, so it never creates a child it cannot promise to own.
   */
  retain(destination: NativeReceiveDestination): string | null {
    const reservation = this.reserve();
    return reservation === null ? null : reservation.claim(destination);
  }

  /**
   * Ask a retained destination to tear down again.
   *
   * A failure keeps the ticket: the point of retaining it is that the next
   * attempt may be the one that works, and releasing it on failure would be the
   * silent drop this class exists to prevent.
   */
  async retry(ticket: string): Promise<CleanupRetryOutcome> {
    const destination = this.held.get(ticket);
    if (destination === undefined) return { outcome: "unknown" };
    try {
      await destination.cancel();
    } catch (error) {
      return {
        outcome: "uncertain",
        residue: error instanceof NativeHelperError ? error.residue : true,
      };
    }
    this.held.delete(ticket);
    return { outcome: "clean" };
  }
}

/** The process-wide registry the receive path admits into by default. */
export const storedCleanups = new CleanupRegistry();
