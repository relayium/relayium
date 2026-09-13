// One `relayium-secret-helper` invocation.
//
// Plaintext crosses only the pipe. Never argv, never the environment, never a
// temp file, and never an error message — an exception quoting the value it
// failed on is a leak with a stack trace attached.
//
// Two lifetime rules the secret-durability harness had to learn the hard way:
// `close` is the only proof a process ended, and an `error` event is not a
// close. A third is added here: a kill that does not take effect must not be
// waited on forever. `get` runs on the sign-in path, so an unbounded wait is an
// application that never finishes signing in.

import { spawn, type ChildProcess } from "node:child_process";
import {
  MAX_BLOB_BYTES,
  MAX_PLAINTEXT_BYTES,
  decodeResponse,
  encodeRequest,
  EXIT_BY_STATUS,
  MAX_FRAME_BYTES,
  OP_OPEN,
  OP_SEAL,
  type HelperStatus,
} from "./protocol.js";

export type TransportFailure =
  /** The helper could not be run, timed out, or spoke nonsense. */
  | "helper-unavailable"
  /** The helper rejected the data: wrong key, or its integrity check failed. */
  | "refused";

export type TransportResult =
  | { readonly ok: true; readonly payload: Buffer }
  | { readonly ok: false; readonly failure: TransportFailure };

export interface HelperTransport {
  /** Never throws. */
  invoke(op: number, payload: Buffer): Promise<TransportResult>;
}

export interface SpawnHelperOptions {
  readonly executable: string;
  readonly timeoutMs: number;
  /** Diagnostics sink. Closed reasons only — never payload bytes. */
  readonly reportFailure: (reason: string) => void;
  /**
   * How the child is started. Injectable ONLY so the lifetime can be driven in
   * a test: a process that ignores a closed stdin and survives a kill cannot be
   * arranged portably, and that is the path most in need of proof.
   *
   * It supplies the PROCESS, not the command line. A seam that accepted
   * arguments would hand back the argv leak this design refuses, so the single
   * place a command line and an environment are built is `defaultSpawn`.
   */
  readonly spawnChild?: (executable: string) => ChildProcess;
  /** How long to wait for `close` after a kill before abandoning ownership. */
  readonly cleanupMs?: number;
}

/**
 * The environment the helper gets: a whitelist, not an inheritance.
 *
 * `process.env` in this process contains the user's whole environment — tokens
 * injected by CI, proxy credentials, anything a parent exported. None of it is
 * the helper's business, and a child that never needed a variable cannot leak
 * one. These are the entries a Win32 process genuinely needs to start and to
 * reach the DPAPI implementation.
 */
const HELPER_ENV_KEYS = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
] as const;

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const defaultSpawn = (executable: string): ChildProcess =>
  spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: helperEnv(),
    // No console flash. A helper invoked during sign-in must not blink a window
    // onto the user's desktop.
    windowsHide: true,
  });

/** Best effort. A JS string cannot be wiped; a Buffer can, so buffers are used. */
function wipe(...buffers: (Buffer | undefined)[]): void {
  for (const buffer of buffers) {
    if (buffer && buffer.byteLength > 0) buffer.fill(0);
  }
}

/**
 * A child that outlived its invocation.
 *
 * It is NOT forgotten and its close is NOT invented. Ownership is retained here
 * so a later invocation retries the cleanup — the alternative is a leaked
 * process holding a pipe, and pretending it closed would be the same lie the
 * durability harness was built to stop telling.
 */
interface AbandonedChild {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  closed: boolean;
}
const abandoned = new Set<AbandonedChild>();

/** Exposed for tests; production callers never need it. */
export function abandonedCount(): number {
  return abandoned.size;
}

/**
 * Retry the cleanup of anything abandoned, and report whether any is still live.
 *
 * A caller that spawned again while a previous child was unkillable would add a
 * second live helper, then a third — an unbounded fleet of processes each
 * holding a pipe. So this is not merely housekeeping: its return value gates
 * the next spawn.
 */
function retryAbandonedCleanup(report: (reason: string) => void): boolean {
  for (const entry of [...abandoned]) {
    if (entry.closed) {
      abandoned.delete(entry);
      continue;
    }
    try {
      entry.child.kill();
    } catch {
      // Still owned; the next invocation tries again.
    }
    report(`retry-cleanup:${String(entry.pid)}`);
  }
  return abandoned.size > 0;
}

/**
 * Retry the kill and JOIN, for a lifecycle owner that wants the fleet clear.
 *
 * Returns how many are STILL OWNED when it gives up. It does not clear the set,
 * and there is no code path that removes an entry without an observed `close`.
 *
 * An earlier revision killed and then cleared unconditionally. That released the
 * spawn gate against a process still holding a pipe, and it made "Stay" after a
 * failed quit-cleanup unretryable — there was nothing left to retry. It was
 * written to make tests independent of each other, and a comment was added
 * calling it a drain. Forgetting a live child is not draining, and a test's
 * convenience is not a reason to change what the application believes about
 * processes it started.
 */
export async function drainAbandoned(timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const entry of [...abandoned]) {
      if (entry.closed) {
        abandoned.delete(entry);
        continue;
      }
      try {
        entry.child.kill();
      } catch {
        // Still owned. Nothing here may drop it.
      }
    }
    if (abandoned.size === 0) return 0;
    if (Date.now() >= deadline) return abandoned.size;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

class BoundedSink {
  private chunks: Buffer[] = [];
  private size = 0;
  overflowed = false;

  push(chunk: Buffer, limit: number): boolean {
    if (this.overflowed) {
      wipe(chunk);
      return false;
    }
    if (this.size + chunk.byteLength > limit) {
      this.overflowed = true;
      // Wiped, not merely dropped: these bytes may be a partly-received
      // plaintext, and releasing them to the GC unscrubbed leaves them in the
      // heap for whatever reads it next.
      wipe(...this.chunks, chunk);
      this.chunks = [];
      this.size = 0;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    return true;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }

  destroy(): void {
    wipe(...this.chunks);
    this.chunks = [];
    this.size = 0;
  }
}

const MAX_STDERR_BYTES = 4096;
const DEFAULT_CLEANUP_MS = 2000;

export function spawnHelperTransport(options: SpawnHelperOptions): HelperTransport {
  const cleanupMs = options.cleanupMs ?? DEFAULT_CLEANUP_MS;

  return {
    invoke(op: number, payload: Buffer): Promise<TransportResult> {
      // Validated BEFORE anything is spawned. A bad op or an over-bound payload
      // is this process's mistake, and starting a child to discover it would
      // put the payload on a pipe for no reason.
      if (op !== OP_SEAL && op !== OP_OPEN) {
        options.reportFailure(`bad-op:${String(op)}`);
        return Promise.resolve({ ok: false, failure: "helper-unavailable" });
      }
      // PER-OP bounds. A seal carries plaintext and an open carries a DPAPI
      // blob, and they have different ceilings; using the larger for both would
      // have accepted a 69632-byte "plaintext" the store would never seal.
      const requestLimit = op === OP_SEAL ? MAX_PLAINTEXT_BYTES : MAX_BLOB_BYTES;
      if (payload.byteLength > requestLimit) {
        options.reportFailure("request-over-bound");
        return Promise.resolve({ ok: false, failure: "helper-unavailable" });
      }

      // Refuses to spawn while a previous child is still unkilled. Without this
      // gate, repeated invocations against an unkillable helper each add
      // another live process.
      if (retryAbandonedCleanup(options.reportFailure)) {
        options.reportFailure("abandoned-child-still-live");
        return Promise.resolve({ ok: false, failure: "helper-unavailable" });
      }

      return new Promise<TransportResult>((resolve) => {
        const request = encodeRequest(op, payload);
        const stdout = new BoundedSink();
        const stderr = new BoundedSink();

        let child: ChildProcess;
        try {
          child = (options.spawnChild ?? defaultSpawn)(options.executable);
        } catch {
          wipe(request);
          options.reportFailure("spawn-threw");
          resolve({ ok: false, failure: "helper-unavailable" });
          return;
        }

        let closed = false;
        let resolved = false;
        /** One-shot fence: terminate runs at most once per child. */
        let terminating = false;
        let failure: TransportFailure | null = null;
        let deadlineTimer: NodeJS.Timeout | undefined;
        let cleanupTimer: NodeJS.Timeout | undefined;

        const settle = (result: TransportResult) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(deadlineTimer);
          clearTimeout(cleanupTimer);
          // The request frame carries the plaintext on a seal; it is done with.
          wipe(request);
          stdout.destroy();
          stderr.destroy();
          resolve(result);
        };

        /** Kill, then wait a BOUNDED time for the close it may never send. */
        const terminate = (reason: string) => {
          // Idempotent. Every stdout chunk after an overflow used to schedule
          // another cleanup timer, overwrite the handle and add a duplicate
          // abandoned entry for one child; the deadline raced the same path.
          if (terminating || closed || resolved) return;
          terminating = true;
          // The deadline has nothing left to do once termination has begun.
          clearTimeout(deadlineTimer);
          failure ??= "helper-unavailable";
          options.reportFailure(reason);
          let killed = false;
          try {
            killed = child.kill();
          } catch {
            options.reportFailure("kill-threw");
          }
          // A `false` return means the signal was not delivered. Waiting on a
          // close that will not come is how the sign-in path hangs forever.
          if (!killed) options.reportFailure("kill-not-delivered");

          cleanupTimer = setTimeout(() => {
            if (closed) return;
            const entry: AbandonedChild = { child, pid: child.pid, closed: false };
            child.once("close", () => {
              entry.closed = true;
              // Ownership released the moment it really closes, rather than
              // lingering until some later invocation happens to sweep.
              abandoned.delete(entry);
            });
            abandoned.add(entry);
            options.reportFailure(`abandoned-pid:${String(child.pid)}`);
            settle({ ok: false, failure: failure ?? "helper-unavailable" });
          }, cleanupMs);
        };

        // Recorded; never treated as termination.
        child.on("error", () => {
          options.reportFailure("spawn-error");
          failure ??= "helper-unavailable";
        });
        child.stdout?.on("error", () => {
          options.reportFailure("stdout-stream-error");
          failure ??= "helper-unavailable";
        });
        child.stderr?.on("error", () => {
          options.reportFailure("stderr-stream-error");
        });
        child.stdin?.on("error", () => {
          options.reportFailure("stdin-stream-error");
          failure ??= "helper-unavailable";
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          // After settling, nothing is kept. A late chunk could be plaintext,
          // and buffering it into a sink nobody will read again is exactly the
          // retention this module wipes elsewhere to avoid.
          if (resolved || terminating) {
            wipe(chunk);
            return;
          }
          if (stdout.push(chunk, MAX_FRAME_BYTES)) return;
          // Immediately, not at the deadline: a helper streaming past a bounded
          // frame will not produce a valid one, and waiting costs the caller
          // the whole timeout for an answer already known.
          terminate("stdout-over-bound");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (resolved || terminating) {
            wipe(chunk);
            return;
          }
          // A helper that floods stderr has broken the protocol's bound, and a
          // logged warning that still returns `ok` would let it. Terminated,
          // like any other bound violation.
          if (!stderr.push(chunk, MAX_STDERR_BYTES)) terminate("stderr-over-bound");
        });

        deadlineTimer = setTimeout(() => {
          if (closed || resolved) return;
          terminate("timeout");
        }, options.timeoutMs);

        child.on("close", (code) => {
          closed = true;
          clearTimeout(deadlineTimer);
          clearTimeout(cleanupTimer);
          if (resolved) return;
          if (failure !== null) {
            settle({ ok: false, failure });
            return;
          }
          if (stdout.overflowed) {
            settle({ ok: false, failure: "helper-unavailable" });
            return;
          }

          const raw = stdout.buffer();
          const decoded = decodeResponse(raw);
          if (!decoded.ok) {
            wipe(raw);
            options.reportFailure(`bad-frame:${decoded.reason}`);
            settle({ ok: false, failure: "helper-unavailable" });
            return;
          }

          // Exit and status must agree; guessing which half to believe is how a
          // refusal becomes a success.
          const expected: number = EXIT_BY_STATUS[decoded.status as HelperStatus];
          if (code !== expected) {
            wipe(raw);
            options.reportFailure(`exit-status-mismatch:${String(code)}`);
            settle({ ok: false, failure: "helper-unavailable" });
            return;
          }

          // PER-OP response bound: a seal returns a blob, an open returns
          // plaintext, and the plaintext ceiling is the lower of the two.
          const responseLimit = op === OP_SEAL ? MAX_BLOB_BYTES : MAX_PLAINTEXT_BYTES;
          if (decoded.status === "ok" && decoded.payload.byteLength > responseLimit) {
            wipe(raw);
            options.reportFailure("response-over-bound");
            settle({ ok: false, failure: "helper-unavailable" });
            return;
          }

          if (decoded.status === "ok") {
            // COPIED before the source is wiped: the decoded payload is a view
            // onto `raw`, and settling wipes the sinks.
            const out = Buffer.from(decoded.payload);
            wipe(raw);
            settle({ ok: true, payload: out });
            return;
          }
          wipe(raw);
          // `refused` is about the DATA — a wrong key, or the helper's
          // integrity check rejecting a blob `CryptUnprotectData` returned
          // success for. The others are about the helper.
          settle({
            ok: false,
            failure: decoded.status === "refused" ? "refused" : "helper-unavailable",
          });
        });

        try {
          child.stdin?.end(request);
        } catch {
          failure ??= "helper-unavailable";
          options.reportFailure("stdin-write-failed");
        }
      });
    },
  };
}
