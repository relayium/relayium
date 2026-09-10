// Which device central holds for this installation, resolved once per account.
//
// ## Why two features need the same answer
//
// The Device Inbox is addressed by this id — every endpoint it uses is
// `/api/devices/{deviceID}/inbox/...` — and stored SEND needs it for a
// different reason: `UploadJournal` scopes a user's send history by account, so
// that scoping value has to be STABLE across restarts or the history vanishes
// on relaunch.
//
// `AppService.accountEmail` cannot serve either of them. It is held in memory
// only, so a restart with a perfectly valid bearer reports it empty, and every
// account on the machine would then share one scope.
//
// Central's device row can. It is issued per (account, installation), it is
// already the Inbox's addressing value, and reading it costs one authenticated
// request. Resolving it in ONE place means the two features scope to the same
// account rather than to two values that merely usually agree.
//
// ## Memoised per EPOCH, not for the process
//
// The cache key is the account epoch, so signing out and in as somebody else
// resolves again — the answer is a different account's device list. A cached
// value that outlived its epoch would scope one account's history and one
// account's inbox directory to another's identity, which is the failure this
// whole module exists to prevent.

import { resolveCurrentDevice, type CurrentDevice } from "./inbox-device.js";

export interface AccountIdentityDeps {
  readonly origin: string;
  /** Test seam. Production is the bounded authenticated read. */
  resolve?(bearer: string, signal: AbortSignal): Promise<CurrentDevice>;
}

export class AccountIdentity {
  /** The epoch the held answer belongs to, and the answer itself. */
  #epoch: number | null = null;
  #device: CurrentDevice | null = null;
  /** One in-flight lookup per epoch, so two features do not both ask. */
  #pending: { epoch: number; run: Promise<CurrentDevice> } | null = null;

  constructor(private readonly deps: AccountIdentityDeps) {}

  /**
   * This installation's device row under the account at `epoch`.
   *
   * Concurrent callers for the same epoch share one request. A caller for a
   * DIFFERENT epoch never joins it: the answer would be another account's.
   */
  resolve(bearer: string, epoch: number, signal: AbortSignal): Promise<CurrentDevice> {
    if (this.#epoch === epoch && this.#device !== null) return Promise.resolve(this.#device);
    const pending = this.#pending;
    if (pending !== null && pending.epoch === epoch) return pending.run;

    const run = (
      this.deps.resolve?.(bearer, signal) ??
      resolveCurrentDevice({ origin: this.deps.origin, bearer, signal })
    ).then((device) => {
      // Held only if it is still the epoch that asked. An answer that arrived
      // after an account change describes an account that has gone away.
      if (this.#pending?.epoch === epoch) {
        this.#epoch = epoch;
        this.#device = device;
      }
      return device;
    });
    this.#pending = { epoch, run };
    run.catch(() => {
      // Cleared on failure so a transient network problem is retryable rather
      // than cached as an answer. The scheduler's backoff is what paces it.
      if (this.#pending?.run === run) this.#pending = null;
    });
    return run;
  }

  /** Forget everything. Called when the account authority moves. */
  invalidate(): void {
    this.#epoch = null;
    this.#device = null;
    this.#pending = null;
  }

  /** The held answer, without asking. `null` when nothing is known. */
  known(epoch: number): CurrentDevice | null {
    return this.#epoch === epoch ? this.#device : null;
  }
}
