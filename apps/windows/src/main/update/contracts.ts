// The seams the update core is built against, declared as types only.
//
// Every one is a Windows-specific capability the core must NOT implement to be
// reviewable: the Authenticode check is a Win32 call, installing runs an
// executable, revealing opens Explorer, and quiescing the app belongs to the
// resident lane. So they are structural interfaces with no production
// implementation here, and the defaults FAIL CLOSED.

/**
 * What Windows thinks of an executable's signature.
 *
 * This is a question about PUBLISHER IDENTITY and nothing else. It does not
 * predict what SmartScreen or Smart App Control will do with the file:
 * Microsoft's guidance is that reputation is not conferred by certificate type,
 * so a signed artifact can still be warned about and an unsigned one can be
 * blocked outright rather than merely warned about. Do not derive a promise
 * about the platform's behaviour from any of these four values.
 *
 *   * `signed-by-expected-publisher` — identity matches the pinned expectation.
 *   * `signed-by-other-publisher` — a HARD reject, and a STRONGER signal than
 *     unsigned: something signed this and it was not us.
 *   * `unsigned` — no signature. The app may reveal the file; it must never
 *     execute it.
 *   * `unavailable` — the question could not be answered. **Not `unsigned`, and
 *     not ready.** Treating an unanswered question as a negative answer is how a
 *     verifier that stops working becomes a verifier that approves.
 */
export type PublisherVerdict =
  | "signed-by-expected-publisher"
  | "signed-by-other-publisher"
  | "unsigned"
  | "unavailable";

/**
 * A PREVIEW of the publisher verdict, for deciding what to show the user.
 *
 * ## This is not the install authority, and it cannot be
 *
 * `verify(path)` answers about a path at a moment. Between its answer and a
 * `CreateProcess` on the same path, the file can be replaced — by another
 * process, by the user, by anything with write access to the staging
 * directory. Re-hashing immediately before the call does not close that
 * window; it only makes it shorter. So this interface exists to populate
 * `ready` versus `ready-unsigned` in the UI, and `PlatformInstaller` below is
 * the only thing allowed to decide that something runs.
 */
/**
 * What the preview verifier is asked about.
 *
 * The same shape as an install expectation, minus the pin, and deliberately NOT
 * a path: a preview that took a path would be a second way to name a file, and
 * an implementation backed by the custody helper could not honour it — the
 * helper has no operation that accepts one. So the preview verifies the same
 * OBJECT the download created, through the same held scope.
 */
export interface PublisherPreview {
  readonly directory: string;
  readonly name: string;
  /** Identity of the staged object; a preview of a different object is not a
   *  preview of this candidate. */
  readonly receipt: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256, from the SIGNED manifest. */
  readonly sha256: string;
}

export interface PublisherVerifier {
  verify(subject: PublisherPreview, signal?: AbortSignal): Promise<PublisherVerdict>;
}

/**
 * The preview verifier a build has when no adapter is wired.
 *
 * Answers `unavailable`, which cannot be mistaken for `unsigned` and cannot
 * reach `ready`. A build with no verifier therefore offers no install and no
 * reveal, which is correct for a build that cannot tell what it downloaded.
 */
export const unavailableVerifier: PublisherVerifier = {
  verify: async () => "unavailable",
};

/**
 * What the platform installer is told, immutably.
 *
 * All four facts travel together because the installer has to check all four
 * against the file it is about to run — not against a file that was at that
 * path earlier.
 */
export interface InstallExpectation {
  /**
   * The staging directory this app owns, and the single inert name inside it.
   *
   * Split deliberately: a conforming Windows adapter opens `directory` as its
   * root, refuses a reparse point on that handle, and reaches `name`
   * handle-relative — it does NOT re-resolve a composed path string, which is
   * the replacement window this contract exists to close.
   */
  readonly directory: string;
  readonly name: string;
  /**
   * Identity of the object the download created.
   *
   * Carried all the way here so the final effect is bound to the same object as
   * every step before it: an implementation compares this to what the file it
   * holds actually is, and refuses `identity-changed` rather than launching
   * something that merely has the right name and length.
   */
  readonly receipt: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256, from the SIGNED manifest. */
  readonly sha256: string;
  /**
   * The publisher identity the signature must carry. Null when no certificate
   * is provisioned, and then no install is possible at all — which is honest
   * rather than degraded.
   */
  readonly publisher: string | null;
}

export type InstallRefusal =
  /** The file at that path is no longer the expected size or hash. */
  | "identity-changed"
  /** Authenticode said something other than the expected publisher. */
  | "publisher"
  /** The file could not be opened with write and delete denied, so its
   *  identity could not be held still. */
  | "not-lockable"
  /** No publisher identity is pinned, so nothing may be run. */
  | "no-expected-publisher"
  | "cancelled"
  | "platform-error";

export type InstallOutcome =
  | { readonly outcome: "launched" }
  | { readonly outcome: "refused"; readonly refusal: InstallRefusal; readonly verdict?: PublisherVerdict };

/**
 * Verify and launch as ONE operation, under a lock the caller cannot break.
 *
 * ## Why there is no `launch(path)`
 *
 * A naked launch is a time-of-check-to-time-of-use hole with a friendly name:
 * whatever verified the path did so before this call, and the file can change
 * in between. So an implementation of this interface MUST, in this order and
 * without releasing its handle:
 *
 *   1. reach `expectation.name` beneath a handle it holds on
 *      `expectation.directory`, refusing a reparse point at either, and open it
 *      with write and delete DENIED — an unlockable file is `not-lockable`,
 *      never "probably fine";
 *   2. verify the size and the SHA-256 **through that handle**, so the bytes
 *      checked are the bytes held;
 *   3. verify Authenticode on the same held file and require
 *      `expectation.publisher`;
 *   4. create the process from that same file without reopening an unchecked
 *      path.
 *
 * A `launched` outcome therefore means "the thing that ran is the thing that
 * was verified". Any implementation that cannot promise that must return
 * `refused` — this contract has no third answer.
 */
export interface PlatformInstaller {
  installVerified(expectation: InstallExpectation, signal?: AbortSignal): Promise<InstallOutcome>;
}

/**
 * The installer a build has when no adapter is wired: it refuses.
 *
 * FAIL CLOSED, deliberately. A default that launched anything would make the
 * absence of a platform adapter indistinguishable from the presence of a
 * working one, and this is the call that runs an executable.
 */
export const failClosedInstaller: PlatformInstaller = {
  installVerified: async () => ({ outcome: "refused", refusal: "platform-error" }),
};

/** Showing the file to the user without running it. The unsigned path's only
 *  affordance, and it executes nothing. */
export interface FileRevealer {
  reveal(path: string): Promise<void>;
}

/**
 * Permission to interrupt the running app, as a TRANSACTION.
 *
 * ## The host must not wait on the update
 *
 * The consent request runs WHILE `UpdateService.install` awaits it. So a host
 * implementation must quiesce OTHER work — transfers, resident jobs — and must
 * NOT join the update job that is asking: awaiting `install()` from inside
 * `request()` deadlocks both. The `token` exists to make that statement
 * checkable rather than a comment: it names the job to EXCLUDE from whatever
 * the host quiesces.
 *
 * ## Abortable
 *
 * `signal` fires when the user cancels or the app is quitting. A request that
 * cannot settle promptly must settle as `granted: false` rather than hanging —
 * and if it grants LATE, after the caller has given up, the lease is released
 * without installing (see `service.ts`).
 *
 * ## There is no default
 *
 * A build with no consent adapter refuses to install. An "assume granted"
 * default would mean the absence of the resident lane's opinion was
 * indistinguishable from its approval, on the one operation that ends the
 * user's session.
 */
export interface QuiesceLease {
  /**
   * Give the app back.
   *
   * Its OUTCOME matters: a release that fails leaves the app quiesced, and
   * reporting that as a healthy resume would hide an app a failed update
   * disabled.
   */
  release(reason: string): Promise<ReleaseOutcome>;
}

export type ReleaseOutcome =
  /** The app is working again. */
  | { readonly outcome: "resumed" }
  /** The release failed. The app may still be quiesced. */
  | { readonly outcome: "unknown"; readonly detail: string };

export type QuiesceDecision =
  | { readonly granted: true; readonly lease: QuiesceLease }
  | { readonly granted: false; readonly reason: string };

export interface QuiesceRequest {
  /**
   * The update job asking. The host quiesces everything EXCEPT this — joining
   * it would deadlock, since it is the thing awaiting this answer.
   */
  readonly excludeToken: string;
  readonly signal: AbortSignal;
}

export interface QuiesceConsent {
  request(request: QuiesceRequest): Promise<QuiesceDecision>;
}

/** Injected so the once-per-day bound is testable without waiting a day. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
