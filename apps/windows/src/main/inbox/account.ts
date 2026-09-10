// The account context every Inbox operation is scoped to.
//
// ## Why this is a value, not a lookup
//
// An account change must not be observable mid-operation. If any code path
// asked "which account is current?" after an await, a sign-out that landed in
// that window would let work started under one account finish under another —
// writing one account's message into another's vault, or sealing to the wrong
// device.
//
// So the context is captured ONCE, frozen, and passed down. Nothing in
// `src/main/inbox/**` reads a global current account, and the epoch travels with
// the context so a stale one is detectable by comparison rather than by trust.
import { createHash } from "node:crypto";

/** How many hex characters of the account digest name the directory. */
const ACCOUNT_KEY_HEX = 32;

export interface AccountContext {
  /**
   * A stable, opaque directory name for this account.
   *
   * A DIGEST, not the account id. An account identifier is usually an email or
   * a uuid; either would become a directory name on the user's disk, visible to
   * anything that can list the profile folder. The digest is stable across runs,
   * which is all the layout needs.
   */
  readonly accountKey: string;
  /** Central's device id for this installation under this account. */
  readonly deviceID: string;
  /** The AppService account epoch this context was captured at. */
  readonly epoch: number;
  /** Account-scoped directory: `<inboxRoot>/<accountKey>`. */
  readonly directory: string;
}

export function accountKeyOf(accountID: string): string {
  return createHash("sha256").update(accountID, "utf8").digest("hex").slice(0, ACCOUNT_KEY_HEX);
}

/**
 * Capture a context. Frozen, so a holder cannot mutate another holder's view.
 */
export function captureAccount(args: {
  readonly accountID: string;
  readonly deviceID: string;
  readonly epoch: number;
  readonly inboxRoot: string;
}): AccountContext {
  if (args.accountID.length === 0) throw new Error("inbox: account id is required");
  if (args.deviceID.length === 0) throw new Error("inbox: device id is required");
  const accountKey = accountKeyOf(args.accountID);
  return Object.freeze({
    accountKey,
    deviceID: args.deviceID,
    epoch: args.epoch,
    // Joined here rather than by callers, so no caller can compose a path.
    directory: `${args.inboxRoot}/${accountKey}`,
  });
}

/** Two contexts denote the same account+device+epoch. */
export function sameAccount(a: AccountContext, b: AccountContext): boolean {
  return a.accountKey === b.accountKey && a.deviceID === b.deviceID && a.epoch === b.epoch;
}

export class AccountChangedError extends Error {
  /**
   * The stable code, which `receipts.ts` already maps.
   *
   * Without it `asFailure` fell through to `internal`, so an account change —
   * the one failure this whole context exists to make visible — was reported as
   * an unclassified internal error. The mapping table anticipated this code; the
   * error just never carried it.
   */
  readonly code = "account-changed";

  constructor() {
    super("inbox: account changed");
    this.name = "AccountChangedError";
  }
}

/**
 * A job whose lifetime is bound to one account context.
 *
 * Adoption of a new context must ABORT AND JOIN the old jobs before anything
 * new starts. Aborting without joining leaves the old work running against the
 * old account's files while the new context is already writing — the exact
 * overlap the epoch exists to prevent.
 */
export class AccountJobs {
  private readonly running = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  private closed = false;

  constructor(readonly context: AccountContext) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Run `body` under this context, or refuse if the context is already gone. */
  run<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || this.controller.signal.aborted) {
      return Promise.reject(new AccountChangedError());
    }
    const job = body(this.controller.signal);
    this.running.add(job);
    // Tracked whatever the outcome: a rejected job still has to be joined
    // before adoption, or its `finally` can run after the new context started.
    const settled = job.then(
      () => undefined,
      () => undefined,
    );
    this.running.add(settled);
    void settled.finally(() => {
      this.running.delete(settled);
      this.running.delete(job);
    });
    return job;
  }

  /** Abort, then JOIN. Awaited by adoption; never fired and forgotten. */
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    // Re-read each pass: a job settling during the await can register nothing
    // new (run() refuses once closed), but the set is mutated as jobs drain.
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  /** Diagnostic: how many jobs are still outstanding. */
  get outstanding(): number {
    return this.running.size;
  }
}
