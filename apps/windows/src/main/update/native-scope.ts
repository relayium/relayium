// The host half of the update custody helper.
//
// ## No filesystem, at all
//
// This module imports nothing from `node:fs`. It creates no directory, opens no
// file and deletes nothing — every effect happens inside the helper, through
// handles the helper holds. That is what makes the Windows adapter
// unbypassable: if this file could touch a path, the pinning the helper does
// would be advisory.
//
// The one thing it does spawn is a FIXED executable, whose path the main process
// derives from `process.resourcesPath`. Nothing from a renderer, from IPC or
// from the environment reaches that argument, and the name is checked here as
// well — a helper path is a code-execution decision.
//
// ## One request at a time
//
// The helper is strictly sequential and does no read-ahead, so this side
// serialises too: every call joins a promise chain. A reply frame therefore
// always belongs to the request that is waiting.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { basename, isAbsolute, join } from "node:path";

import {
  CustodyError,
  type OwnedFile,
  type RetireOutcome,
  type StagingScope,
  type StagingScopeProvider,
} from "./custody.js";
import type {
  InstallExpectation,
  InstallOutcome,
  InstallRefusal,
  PlatformInstaller,
  PublisherPreview,
  PublisherVerdict,
  PublisherVerifier,
} from "./contracts.js";

/** The one name this build will spawn. */
export const HELPER_FILE_NAME = "relayium-update-helper.exe";

/** Frame kinds, matching `internal/updio/frame.go`. */
const KIND_JSON = 0x4a;
const KIND_BYTES = 0x42;

const MAX_CONTROL_BYTES = 16 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
/** Matches the helper's `MaxJournalBytes` and the core's `MAX_JOURNAL_BYTES`. */
const MAX_RECORD_BYTES = 512 * 1024;

/**
 * How long one request may take.
 *
 * Generous, because hashing a large staged file happens inside a single reply —
 * but FINITE, because a helper that stops answering must not hold a quit, an
 * update check or a shutdown open forever. A request that reaches this is a
 * terminal session failure, not a retry.
 */
const REQUEST_DEADLINE_MS = 120_000;
/** How long a helper gets to exit after its stdin closes, before it is killed. */
const CLOSE_DEADLINE_MS = 5_000;
/** How long a killed helper gets to actually die. */
const KILL_DEADLINE_MS = 5_000;

interface Reply {
  readonly ok: boolean;
  readonly code?: string;
  readonly version?: number;
  readonly receipt?: string;
  readonly handle?: number;
  readonly present?: boolean;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly verdict?: string;
  readonly gone?: boolean;
}

/** A reply plus the payload frame that followed it, when one did. */
interface Answer {
  readonly reply: Reply;
  readonly payload: Uint8Array | null;
}

const refusal = (code: string | undefined): CustodyError =>
  new CustodyError(
    code === "redirected" ||
    code === "not-a-directory" ||
    code === "exists" ||
    code === "bad-name" ||
    code === "too-large" ||
    code === "no-platform-scope"
      ? code
      : "io",
    code ?? null,
  );

/** The framed pipe to one helper process. */
class HelperSession {
  private chain: Promise<unknown> = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private waiting: ((answer: Answer | Error) => void) | null = null;
  private pendingReply: Reply | null = null;
  /**
   * Set once, by the first thing that makes this session untrustworthy.
   *
   * A stream whose framing was not understood cannot be resynchronised, and a
   * reply that arrived after a deadline cannot be matched to a request. So the
   * session is POISONED rather than continued: every later call rejects with
   * the original cause instead of pairing an answer with the wrong question.
   */
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  /** Injected so the deadline is testable without waiting two minutes. */
  private deadlineMs = REQUEST_DEADLINE_MS;

  /** Resolved when the child has exited. Subscribed ONCE, at spawn: a listener
   *  added later can miss an exit that already happened. */
  private readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcessByStdio<Writable, Readable, null>) {
    this.exited =
      child.pid === undefined
        ? // Never spawned: there is nothing to join, and waiting for an `exit`
          // that will never fire would hang every close.
          Promise.resolve()
        : new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("exit", () => resolve());
          });
    child.stdout.on("data", (chunk: Buffer) => this.absorb(chunk));
    child.stdout.on("error", (error) => this.poison(error));
    // Without this, a helper that died mid-write turns a normal EPIPE into an
    // uncaught exception that takes the app with it.
    child.stdin.on("error", (error) => this.poison(error));
    child.on("exit", () => this.poison(new CustodyError("io", "helper-exited")));
    child.on("error", (error) => this.poison(error));
  }

  /** Record the first cause and fail anything waiting on it. */
  private poison(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.settle(this.failure);
  }

  static start(helperPath: string, deadlineMs: number = REQUEST_DEADLINE_MS): HelperSession {
    // BASENAME equality, not a suffix: `evil-relayium-update-helper.exe` ends
    // with the right characters and is not the right file. The check claims to
    // be exact, so it is.
    if (!isAbsolute(helperPath) || basename(helperPath) !== HELPER_FILE_NAME) {
      // A helper path is a code-execution decision, so it is checked here too
      // rather than only where it was composed.
      throw new CustodyError("bad-name", "helper-path");
    }
    // Argument-free by contract, and no shell: this is a direct spawn of one
    // fixed executable. stderr is discarded because the helper writes nothing
    // there — every diagnosis it is allowed to give is a code in a reply.
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const session = new HelperSession(child);
    session.deadlineMs = deadlineMs;
    return session;
  }

  private settle(value: Answer | Error): void {
    const waiter = this.waiting;
    this.waiting = null;
    waiter?.(value);
  }

  /**
   * Accumulate and emit whole frames, strictly.
   *
   * Every departure from the protocol is TERMINAL. An earlier revision left the
   * buffer and the session intact after a malformed frame, so bytes accumulated
   * and the next reply could be attributed to the wrong request — which is
   * worse than a failure, because it looks like an answer.
   */
  private absorb(chunk: Buffer): void {
    if (this.failure !== null) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.byteLength < 5) return;
      const length = this.buffer.readUInt32BE(0);
      const kind = this.buffer[4];
      // Bounded per KIND, not by the largest thing any frame may carry: a
      // control frame of 512 KiB is not a large reply, it is a broken one.
      const limit = kind === KIND_BYTES ? MAX_RECORD_BYTES : MAX_CONTROL_BYTES;
      if (kind !== KIND_JSON && kind !== KIND_BYTES) {
        this.poison(new CustodyError("io", "helper-frame-kind"));
        return;
      }
      if (length > limit) {
        this.poison(new CustodyError("too-large", "helper-frame"));
        return;
      }
      if (this.buffer.byteLength < 5 + length) return;
      const frame = Buffer.from(this.buffer.subarray(5, 5 + length));
      this.buffer = this.buffer.subarray(5 + length);
      if (kind === KIND_JSON) {
        if (this.pendingReply !== null) {
          // A reply that announced bytes must be followed by its payload, not
          // by another reply.
          this.poison(new CustodyError("io", "helper-missing-payload"));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.toString("utf8"));
        } catch {
          this.poison(new CustodyError("io", "helper-unparseable"));
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          this.poison(new CustodyError("io", "helper-reply-shape"));
          return;
        }
        const reply = parsed as Reply;
        if (typeof reply.ok !== "boolean") {
          this.poison(new CustodyError("io", "helper-reply-shape"));
          return;
        }
        if (reply.bytes !== undefined) {
          if (typeof reply.bytes !== "number" || !Number.isSafeInteger(reply.bytes) ||
              reply.bytes < 0 || reply.bytes > MAX_RECORD_BYTES) {
            this.poison(new CustodyError("io", "helper-reply-shape"));
            return;
          }
        }
        if ((reply.bytes ?? 0) > 0) {
          this.pendingReply = reply;
          continue;
        }
        this.settle({ reply, payload: null });
      } else {
        const reply = this.pendingReply;
        this.pendingReply = null;
        if (reply === null) {
          this.poison(new CustodyError("io", "helper-unexpected-payload"));
          return;
        }
        // The announced length is the contract; a payload that disagrees means
        // the stream is no longer understood.
        if (frame.byteLength !== reply.bytes) {
          this.poison(new CustodyError("io", "helper-payload-length"));
          return;
        }
        this.settle({ reply, payload: frame });
      }
    }
  }

  /** One request, optionally with a payload frame, awaiting one answer. */
  request(body: Record<string, unknown>, payload?: Uint8Array): Promise<Answer> {
    const run = this.chain.then(
      () => this.exchange(body, payload),
      () => this.exchange(body, payload),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private exchange(body: Record<string, unknown>, payload?: Uint8Array): Promise<Answer> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const control = Buffer.from(JSON.stringify(body), "utf8");
    if (control.byteLength > MAX_CONTROL_BYTES) {
      return Promise.reject(new CustodyError("too-large", "request"));
    }
    if (payload !== undefined && payload.byteLength > MAX_CHUNK_BYTES) {
      return Promise.reject(new CustodyError("too-large", "chunk"));
    }
    return new Promise<Answer>((resolve, reject) => {
      // Finite, and terminal. A helper that stops answering would otherwise
      // hold a quiesce — and therefore a quit — open forever.
      const deadline = setTimeout(() => {
        this.poison(new CustodyError("io", "helper-timeout"));
      }, this.deadlineMs);
      this.waiting = (value) => {
        clearTimeout(deadline);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      try {
        this.child.stdin.write(frameOf(KIND_JSON, control));
        if (payload !== undefined) this.child.stdin.write(frameOf(KIND_BYTES, payload));
      } catch (error) {
        clearTimeout(deadline);
        this.poison(error as Error);
        reject(this.failure ?? (error as Error));
      }
    });
  }

  /**
   * End the session and JOIN the child.
   *
   * Closing stdin is the documented end: the helper releases every handle and
   * exits. A helper that does not is killed, and the kill is waited on too —
   * an earlier revision resolved the moment `kill()` returned, which claims the
   * scope is closed while its directory handles may still be held.
   *
   * A child that cannot be joined even after a kill THROWS. That is deliberately
   * loud: it means something is still holding this app's staging directory, and
   * silently returning would report a clean teardown that did not happen.
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = (async () => {
      // Anything still waiting fails NOW, with the close as its cause, rather
      // than hanging until the child happens to exit.
      this.poison(new CustodyError("io", "helper-closed"));
      const within = async (bound: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), bound);
        });
        try {
          return await Promise.race([this.exited.then(() => true), expired]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      if (await within(0)) return;
      this.child.stdin.end();
      if (await within(CLOSE_DEADLINE_MS)) return;
      this.child.kill();
      if (await within(KILL_DEADLINE_MS)) return;
      // RETAINED, not discarded: `closing` keeps this rejection, so every later
      // close reports the same unjoined child instead of a clean teardown.
      throw new CustodyError("io", "helper-unjoined");
    })();
    return this.closing;
  }
}

function frameOf(kind: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength, 0);
  header[4] = kind;
  return Buffer.concat([header, Buffer.from(payload)]);
}

const ok = (answer: Answer): Answer => {
  if (!answer.reply.ok) throw refusal(answer.reply.code);
  return answer;
};

class NativeOwnedFile implements OwnedFile {
  private live = true;

  constructor(
    readonly name: string,
    readonly path: string,
    readonly receipt: string,
    private readonly handle: number,
    private readonly session: HelperSession,
    readonly scope: NativeScope,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    // Split at the helper's chunk bound rather than failing: the caller streams
    // whatever the network hands it.
    for (let at = 0; at < chunk.byteLength; at += MAX_CHUNK_BYTES) {
      const slice = chunk.subarray(at, Math.min(at + MAX_CHUNK_BYTES, chunk.byteLength));
      ok(
        await this.session.request(
          { op: "custody.write", handle: this.handle, bytes: slice.byteLength },
          slice,
        ),
      );
    }
  }

  async sync(): Promise<void> {
    ok(await this.session.request({ op: "custody.sync", handle: this.handle }));
  }

  /** Release the handle WITHOUT deleting. The receipt stays valid. */
  async close(): Promise<void> {
    if (!this.live) return;
    this.live = false;
    await this.session.request({ op: "custody.close", handle: this.handle }).catch(() => undefined);
  }

  async discard(): Promise<RetireOutcome> {
    if (this.live) {
      this.live = false;
      const answer = await this.session
        .request({ op: "custody.discard", handle: this.handle })
        .catch(() => null);
      if (answer === null) return { outcome: "residue", detail: "helper" };
      if (!answer.reply.ok) return { outcome: "residue", detail: answer.reply.code ?? "io" };
      return answer.reply.gone === true ? { outcome: "gone" } : { outcome: "residue", detail: "pending" };
    }
    // Already released: the receipt is what still proves ownership.
    return this.scope.removeOwned(this.name, this.receipt);
  }

  /** Used by `commit`, which must name the handle that wrote the bytes. */
  get id(): number {
    return this.handle;
  }

  /** The scope that issued this handle. Identity, so a handle from another
   *  session cannot be presented to this one. */
  get owner(): StagingScope {
    return this.scope;
  }

  get held(): boolean {
    return this.live;
  }
}

class NativeScope implements StagingScope {
  constructor(
    readonly directory: string,
    private readonly session: HelperSession,
  ) {}

  pathFor(name: string): string {
    // Composed for display and for `reveal`, which executes nothing. No
    // filesystem call in this module ever takes it.
    return join(this.directory, name);
  }

  async createExclusive(name: string): Promise<OwnedFile> {
    const { reply } = ok(await this.session.request({ op: "custody.create", name }));
    return new NativeOwnedFile(
      name,
      this.pathFor(name),
      reply.receipt ?? "",
      reply.handle ?? 0,
      this.session,
      this,
    );
  }

  async identityOf(name: string): Promise<string | null> {
    const { reply } = ok(await this.session.request({ op: "scope.identity", name }));
    return reply.present === true ? (reply.receipt ?? null) : null;
  }

  async removeOwned(name: string, receipt: string): Promise<RetireOutcome> {
    const answer = await this.session
      .request({ op: "scope.remove", name, receipt })
      .catch(() => null);
    if (answer === null) return { outcome: "residue", detail: "helper" };
    if (!answer.reply.ok) return { outcome: "residue", detail: answer.reply.code ?? "io" };
    return answer.reply.gone === true ? { outcome: "gone" } : { outcome: "residue", detail: "pending" };
  }

  async readBounded(name: string, maxBytes: number): Promise<string | null> {
    const answer = ok(
      await this.session.request({
        op: "scope.read",
        name,
        // Passed through unchanged. The helper refuses a budget beyond its own
        // record limit rather than clamping, and this must not clamp either.
        max: Math.min(maxBytes, MAX_RECORD_BYTES),
      }),
    );
    if (answer.reply.present !== true) return null;
    return Buffer.from(answer.payload ?? new Uint8Array()).toString("utf8");
  }

  async hashOwned(name: string, receipt: string, expectedBytes: number): Promise<string | null> {
    const { reply } = ok(
      await this.session.request({ op: "scope.hash", name, receipt, size: expectedBytes }),
    );
    return reply.present === true ? (reply.sha256 ?? null) : null;
  }

  async commit(file: OwnedFile, toName: string): Promise<void> {
    // Same SCOPE, not merely the same class. Handle ids are small integers the
    // helper allocates per session, so two scopes hand out the same numbers —
    // and committing another scope's handle would publish a file this one never
    // wrote, under a name this one chose.
    if (!(file instanceof NativeOwnedFile) || file.owner !== this) {
      throw new CustodyError("bad-name", "foreign-handle");
    }
    if (!file.held) {
      // A released handle names nothing the helper still holds.
      throw new CustodyError("bad-name", "released-handle");
    }
    ok(await this.session.request({ op: "custody.commit", handle: file.id, to: toName }));
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

export interface NativeScopeOptions {
  /** Absolute path to the packaged helper. The main process derives it from
   *  `process.resourcesPath`; nothing else may choose it. */
  readonly helperPath: string;
  /** Per-request budget. Defaults to two minutes; narrowed only by tests, so
   *  the deadline can be proven without waiting for it. */
  readonly requestDeadlineMs?: number;
}

/** The provider a Windows build uses once the helper is packaged. */
export function nativeScopeProvider(options: NativeScopeOptions): StagingScopeProvider {
  return {
    async open(appRoot: string, component: string): Promise<StagingScope> {
      const session = HelperSession.start(options.helperPath, options.requestDeadlineMs);
      try {
        ok(await session.request({ op: "scope.open", root: appRoot, component }));
      } catch (error) {
        // The teardown's own failure must not replace the reason the open
        // failed, but it must not be silent either — an unjoined helper is
        // recorded on the session and reported by any later close.
        await session.close().catch(() => undefined);
        throw error;
      }
      return new NativeScope(join(appRoot, component), session);
    },
  };
}

const REFUSALS: ReadonlySet<string> = new Set<InstallRefusal>([
  "identity-changed",
  "publisher",
  "not-lockable",
  "no-expected-publisher",
  "cancelled",
  "platform-error",
]);

const VERDICTS: ReadonlySet<string> = new Set<PublisherVerdict>([
  "signed-by-expected-publisher",
  "signed-by-other-publisher",
  "unsigned",
  "unavailable",
]);

/**
 * The installer, over the same helper.
 *
 * `install.run` is the only operation that creates a process, and it carries the
 * SIGNED manifest's size, digest and pinned publisher plus an explicit consent
 * token. The helper verifies all of it through a handle it holds and refuses
 * without any one of them — this side cannot weaken that by omitting a field,
 * because an omitted field is a refusal there.
 */
export function nativeInstaller(options: NativeScopeOptions): PlatformInstaller {
  return {
    async installVerified(
      expectation: InstallExpectation,
      signal?: AbortSignal,
    ): Promise<InstallOutcome> {
      if (expectation.publisher === null) {
        return { outcome: "refused", refusal: "no-expected-publisher" };
      }
      const aborted = (): boolean => signal !== undefined && signal.aborted;
      // Before anything is spawned. A signal that fired while the user was
      // still deciding must not cost a process.
      if (aborted()) return { outcome: "refused", refusal: "cancelled" };
      const session = HelperSession.start(options.helperPath, options.requestDeadlineMs);
      let outcome: InstallOutcome = { outcome: "refused", refusal: "platform-error" };
      try {
        ok(
          await session.request({
            op: "scope.open",
            root: parentOf(expectation.directory),
            component: componentOf(expectation.directory),
          }),
        );
        // The LAST point at which cancelling is honest. Opening the scope can
        // take a moment on a cold directory, and a cancel that arrives during
        // it must still prevent the launch.
        if (aborted()) {
          outcome = { outcome: "refused", refusal: "cancelled" };
        } else {
          // From here the signal is deliberately IGNORED. Once `install.run` is
          // sent the helper may already have created the process, and reporting
          // `cancelled` would be a promise that nothing launched — which this
          // side cannot keep. The real answer is whatever the helper reports.
          const { reply } = await session.request({
            op: "install.run",
            name: expectation.name,
            receipt: expectation.receipt,
            sha256: expectation.sha256,
            size: expectation.sizeBytes,
            publisher: expectation.publisher,
            consent: "granted",
          });
          if (reply.ok) {
            outcome = { outcome: "launched" };
          } else {
            const verdict = VERDICTS.has(reply.verdict ?? "")
              ? (reply.verdict as PublisherVerdict)
              : undefined;
            const refused = REFUSALS.has(reply.code ?? "")
              ? (reply.code as InstallRefusal)
              : "platform-error";
            outcome =
              verdict === undefined
                ? { outcome: "refused", refusal: refused }
                : { outcome: "refused", refusal: refused, verdict };
          }
        }
      } catch {
        outcome = { outcome: "refused", refusal: "platform-error" };
      }
      // The teardown's outcome is part of the answer, not an afterthought.
      //
      // It cannot un-launch a process that really started — reporting a refusal
      // after a launch would be the worse lie — so a launched install keeps its
      // outcome and the unjoined helper stays recorded on the session, where any
      // later close reports it again. Anything else becomes a platform error: a
      // refusal reported alongside a helper this app could not stop is not a
      // clean refusal.
      const teardown = await session.close().then(
        () => null,
        (error: unknown) => error as Error,
      );
      if (teardown !== null && outcome.outcome !== "launched") {
        return { outcome: "refused", refusal: "platform-error" };
      }
      return outcome;
    },
  };
}

/**
 * The preview verifier, over the same helper.
 *
 * ## Why the host can classify at all
 *
 * Without this the only verifier a Windows build has is
 * `unavailableVerifier`, so every download lands in `verifier-unavailable` and
 * the user is never told whether what arrived is signed. That is honest but
 * useless, and it is not a limitation of the platform — the helper can answer.
 *
 * `install.verify` performs the full held verification and RETURNS; it never
 * creates a process. So a preview costs exactly what an install costs minus the
 * launch, and it is the same code path — the preview cannot disagree with the
 * decision because it IS the decision, taken twice.
 *
 * The pin is passed when there is one. Without one the helper answers
 * `unavailable` for a validly signed file rather than claiming it is expected,
 * and `unsigned` for one that carries no signature at all — which is the state
 * a build with no certificate provisioned actually needs.
 */
export function nativePublisherVerifier(
  options: NativeScopeOptions & { readonly expectedPublisher: string | null },
): PublisherVerifier {
  return {
    async verify(subject: PublisherPreview, signal?: AbortSignal): Promise<PublisherVerdict> {
      if (signal?.aborted === true) return "unavailable";
      const session = HelperSession.start(options.helperPath, options.requestDeadlineMs);
      let verdict: PublisherVerdict = "unavailable";
      try {
        ok(
          await session.request({
            op: "scope.open",
            root: parentOf(subject.directory),
            component: componentOf(subject.directory),
          }),
        );
        const { reply } = await session.request({
          op: "install.verify",
          name: subject.name,
          receipt: subject.receipt,
          sha256: subject.sha256,
          size: subject.sizeBytes,
          // Empty means "classify without an expectation", which the helper
          // permits for verify and refuses for run.
          publisher: options.expectedPublisher ?? "",
        });
        const answer = reply.verdict ?? "";
        // A verdict this build does not recognise is `unavailable`, never a
        // guess: an unrecognised answer is an unanswered question.
        if (VERDICTS.has(answer)) verdict = answer as PublisherVerdict;
      } catch {
        verdict = "unavailable";
      }
      const teardown = await session.close().then(
        () => null,
        (error: unknown) => error as Error,
      );
      if (teardown !== null) {
        // A helper this app could not stop is still holding the staging
        // directory. Returning `signed-by-expected-publisher` here would let a
        // `ready` state — the only one that may install — rest on a teardown
        // that failed. `unavailable` can never reach `ready`.
        return "unavailable";
      }
      return verdict;
    },
  };
}

const componentOf = (directory: string): string => {
  const parts = directory.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const parentOf = (directory: string): string =>
  directory.slice(0, directory.length - componentOf(directory).length - 1);
