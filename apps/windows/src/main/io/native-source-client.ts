// The host half of the source-read helper: one child process, three operations.
//
// ## Why this is not the receive client
//
// `native-helper-client.ts` owns the receive lease and is accepted, in
// production, and not modified here. Its framing is private to it, so this
// module carries its own encoder and decoder rather than reaching into it. That
// is a real cost — two implementations of one frame format — and it is paid
// deliberately: the alternative was widening an accepted module's surface for a
// second protocol that must never be reachable from the first.
//
// What IS reused, read-only and unmodified, is everything already exported for
// the purpose: the executable name, the layout-driven path resolution, the child
// process seam and the deadline shape. The two clients therefore agree about
// which binary exists and where, and disagree about nothing else.
//
// The frames are pinned against the Go encoder by fixtures in the owning test,
// not against this module's own encoder, so a divergence is a failing test here
// rather than a stall in production.
//
// ## No path, no bearer, no trust leaves this module
//
// A source path is main-held. It is written into one stdin frame and appears
// nowhere else: not in argv, where every process on the machine could read it,
// not in an environment variable, and not in any error this module raises.
// Nothing here is reachable from a renderer.
import {
  DEFAULT_DEADLINES,
  type HelperChild,
  type NativeHelperDeadlines,
  type SpawnHelper,
} from "./native-helper-client.js";

/**
 * The one literal that selects source mode, matching `SourceModeArg` in
 * `native/cmd/relayium-io-helper/main_windows.go`.
 *
 * It carries no value. A `--source-mode=<something>` form would put caller data
 * in argv, which is the one place this protocol refuses to put it.
 */
export const SOURCE_MODE_ARG = "--source-mode";

/** Matches `sourceserve.ProtocolVersion`. */
export const SOURCE_PROTOCOL_VERSION = 1;

/** Matches `sourceserve.ReadyEvent`. */
export const SOURCE_READY_EVENT = "source-ready";

/** Matches `sourceserve.MaxReadBytes` and `MAX_SELECTION_CHUNK`. */
export const MAX_SOURCE_READ_BYTES = 192 * 1024;

/** Matches `sourceserve.MaxOpenSources`. */
export const MAX_OPEN_SOURCES = 8;

const KIND_REQUEST = 1;
const KIND_CHUNK = 2;
const KIND_RESPONSE = 3;
const KIND_EVENT = 4;

/** Matches `wire.MaxFrameBytes`. Checked before any buffer is reserved. */
const MAX_FRAME_BYTES = 8 << 20;

/** `u64 id` + `u32 index`, matching `wire.ChunkHeaderBytes`. */
const CHUNK_HEADER_BYTES = 12;

export type NativeSourceErrorCode =
  /** The helper could not be located, spawned, or never announced itself. */
  | "unavailable"
  /** A deadline elapsed. The process is killed; nothing is retried here. */
  | "timeout"
  /** The helper broke the protocol. Always terminal for the session. */
  | "protocol"
  /** The helper refused the operation and said why, with a stable code. */
  | "refused"
  /** The client was disposed, or the process ended, while this was in flight. */
  | "closed";

/**
 * A source-helper failure.
 *
 * `helperCode` is the helper's own stable `E_*` string when it supplied one.
 * These are protocol, not prose: they are chosen from a fixed set on the Go
 * side, so carrying one here is not the free-form diagnostic text that must
 * never cross a boundary.
 */
export class NativeSourceError extends Error {
  constructor(
    readonly code: NativeSourceErrorCode,
    readonly helperCode?: string,
    readonly exitCode?: number | null,
    message?: string,
  ) {
    super(message ?? (helperCode !== undefined ? `${code}: ${helperCode}` : code));
    this.name = "NativeSourceError";
  }
}

/** The helper's `open-source` result. */
export interface SourceOpened {
  readonly source: number;
  readonly size: number;
  /** 16 lowercase hex characters. A STRING, never a number — see native-source.ts. */
  readonly volumeSerial: string;
  /** 32 lowercase hex characters. */
  readonly fileId: string;
}

/** The helper's `read-source` result, with the bytes it carried. */
export interface SourceRead {
  readonly bytes: Uint8Array;
  /** Reported by the read itself, never inferred from a size read earlier. */
  readonly eof: boolean;
}

export type SourceCloseState = "closed" | "failed-close";

interface Pending {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: NativeSourceError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  chunk: Uint8Array | null;
}

export interface NativeSourceClientOptions {
  readonly spawn: SpawnHelper;
  readonly deadlines?: Partial<NativeHelperDeadlines>;
}

/**
 * One helper process, strictly one request in flight.
 *
 * The helper tolerates a small amount of pipelining, but the documented
 * contract is strict request/response and this side keeps to it: a queue here
 * means the inbox bound on the far side is never the thing that has to hold.
 */
export class NativeSourceClient {
  #child: HelperChild | null = null;
  #starting: Promise<void> | null = null;
  #ready = false;
  #disposed = false;
  #nextRequestId = 1;
  #pending: Pending | null = null;
  #queue: Array<() => void> = [];
  #buffer = new Uint8Array(0);
  /**
   * Why the session ended, kept so every later call reports the CAUSE.
   *
   * Without it the first caller learned the helper was missing and every
   * caller after it was told "closed" — which describes this object's internal
   * state, not the situation. Staging fifty files would produce one truthful
   * answer and forty-nine misleading ones.
   */
  #terminal: NativeSourceError | null = null;
  #exitCode: number | null = null;
  #readyWaiters: Array<{ resolve: () => void; reject: (e: NativeSourceError) => void }> = [];
  readonly #deadlines: NativeHelperDeadlines;
  readonly #spawn: SpawnHelper;

  constructor(options: NativeSourceClientOptions) {
    this.#spawn = options.spawn;
    this.#deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
  }

  /** True once the helper has announced a protocol version this client speaks. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Starts the process and waits for its ready event. Idempotent. */
  async start(): Promise<void> {
    if (this.#disposed) throw this.#terminal ?? new NativeSourceError("closed");
    if (this.#ready) return;
    this.#starting ??= this.#startOnce();
    return this.#starting;
  }

  async open(absolutePath: string): Promise<SourceOpened> {
    const result = await this.#request<SourceOpened>(
      { op: "open-source", path: absolutePath },
      this.#deadlines.requestMs,
    );
    // Shape-checked here rather than trusted. A helper that answered `ok` with a
    // missing field would otherwise become an identity of `undefined`, which is
    // exactly the unbound read this path exists to prevent.
    if (
      typeof result.source !== "number" ||
      !Number.isSafeInteger(result.source) ||
      result.source <= 0 ||
      typeof result.size !== "number" ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      typeof result.volumeSerial !== "string" ||
      typeof result.fileId !== "string"
    ) {
      throw new NativeSourceError("protocol", undefined, undefined, "open result has unexpected shape");
    }
    return result;
  }

  async read(source: number, offset: number, length: number): Promise<SourceRead> {
    // Refused here, before a frame is sent. A request the helper would refuse
    // anyway is still worth stopping at the shorter boundary.
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new NativeSourceError("protocol", undefined, undefined, "offset out of range");
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SOURCE_READ_BYTES) {
      throw new NativeSourceError("protocol", undefined, undefined, "length out of range");
    }
    const { value, chunk } = await this.#requestWithChunk<{ bytes: number; eof: boolean }>(
      { op: "read-source", source, offset, length },
      this.#deadlines.requestMs,
    );
    if (typeof value.bytes !== "number" || typeof value.eof !== "boolean") {
      throw new NativeSourceError("protocol", undefined, undefined, "read result has unexpected shape");
    }
    const bytes = chunk ?? new Uint8Array(0);
    // The count the helper stated and the bytes it actually sent must agree. A
    // mismatch means one of the two is wrong and there is no way to tell which,
    // so neither is used.
    if (bytes.length !== value.bytes) {
      throw new NativeSourceError("protocol", undefined, undefined, "chunk length disagrees with the reported count");
    }
    if (bytes.length > length) {
      throw new NativeSourceError("protocol", undefined, undefined, "helper returned more than was asked for");
    }
    return { bytes, eof: value.eof };
  }

  async close(source: number): Promise<SourceCloseState> {
    const result = await this.#request<{ state: string }>(
      { op: "close-source", source },
      this.#deadlines.requestMs,
    );
    if (result.state !== "closed" && result.state !== "failed-close") {
      throw new NativeSourceError("protocol", undefined, undefined, "close result has unexpected state");
    }
    return result.state;
  }

  /**
   * Ends the session and reports the process exit code.
   *
   * stdin is closed first so the helper can settle on its own, then the exit is
   * awaited under a bound and the process killed if it does not come. Everything
   * still in flight is rejected as `closed`, never resolved: a request whose
   * answer was never received has an unknown outcome, and reporting it as
   * success would be the silent-loss failure this whole path avoids.
   */
  async dispose(): Promise<{ exitCode: number | null }> {
    if (this.#disposed) return { exitCode: this.#exitCode };
    this.#disposed = true;
    const child = this.#child;
    if (child === null) {
      this.#failAll(new NativeSourceError("closed"));
      return { exitCode: this.#exitCode };
    }
    try {
      child.stdin?.end();
    } catch {
      // A pipe that is already gone is the state we were trying to reach.
    }
    const exited = await this.#awaitExit(this.#deadlines.cancelExitMs);
    if (!exited) {
      child.kill();
      await this.#awaitExit(this.#deadlines.closeAfterExitMs);
    }
    this.#failAll(new NativeSourceError("closed", undefined, this.#exitCode));
    return { exitCode: this.#exitCode };
  }

  // -------------------------------------------------------------------------

  async #startOnce(): Promise<void> {
    let child: HelperChild;
    try {
      child = await this.#spawn();
    } catch (error) {
      const failure = new NativeSourceError(
        "unavailable", undefined, null,
        error instanceof Error ? error.message : "helper could not be started",
      );
      this.#failAll(failure);
      throw failure;
    }
    this.#child = child;
    if (child.stdout === null || child.stdin === null) {
      const failure = new NativeSourceError("unavailable", undefined, null, "helper has no usable stdio");
      this.#failAll(failure);
      throw failure;
    }
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.onError((error) => this.#onTerminal(new NativeSourceError("unavailable", undefined, null, error.message)));
    child.onExit((code) => {
      this.#exitCode = code;
    });
    child.onClose(() => {
      this.#onTerminal(new NativeSourceError("closed", undefined, this.#exitCode, "helper exited"));
    });
    // stderr is DRAINED and discarded. The helper writes codes and counts there
    // and nothing else, but a pipe nobody reads eventually blocks the writer,
    // and a helper blocked on stderr is a helper that cannot answer.
    child.stderr?.on("data", () => {});

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onTerminal(new NativeSourceError("timeout", undefined, this.#exitCode, "helper did not become ready"));
      }, this.#deadlines.startupMs);
      this.#readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #request<T>(body: Record<string, unknown>, deadlineMs: number): Promise<T> {
    return this.#requestWithChunk<T>(body, deadlineMs).then((r) => r.value);
  }

  async #requestWithChunk<T>(
    body: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<{ value: T; chunk: Uint8Array | null }> {
    await this.start();
    if (this.#disposed) throw this.#terminal ?? new NativeSourceError("closed");
    // Serialised rather than pipelined. Waiting here is what keeps the helper's
    // inbox bound from ever being the mechanism that has to hold.
    if (this.#pending !== null) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
      if (this.#disposed) throw this.#terminal ?? new NativeSourceError("closed");
    }
    const id = this.#nextRequestId++;
    const frame = encodeFrame(KIND_REQUEST, encodeJson({ id, ...body }));
    return new Promise<{ value: T; chunk: Uint8Array | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onTerminal(new NativeSourceError("timeout", undefined, this.#exitCode, "request deadline elapsed"));
      }, deadlineMs);
      this.#pending = {
        id,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        chunk: null,
      };
      try {
        this.#child?.stdin?.write(frame);
      } catch (error) {
        this.#onTerminal(
          new NativeSourceError("closed", undefined, this.#exitCode,
            error instanceof Error ? error.message : "write failed"),
        );
      }
    });
  }

  #onData(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    for (;;) {
      if (this.#buffer.length < 5) return;
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      const length = view.getUint32(0, false);
      // Validated against the HEADER alone, before anything is reserved for the
      // body: a malformed four-byte header must not become a large allocation.
      if (length < 1 || length > MAX_FRAME_BYTES) {
        this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "frame length out of range"));
        return;
      }
      const total = 4 + length;
      if (this.#buffer.length < total) return;
      // Read through the view rather than by index: the length check above
      // proves the byte is there, but an indexed read is typed as possibly
      // absent and silencing that with a non-null assertion would remove the
      // only mechanism that catches a future off-by-one here.
      const kind = view.getUint8(4);
      const payload = this.#buffer.subarray(5, total);
      this.#buffer = this.#buffer.slice(total);
      if (!this.#onFrame(kind, payload)) return;
    }
  }

  /** Returns false once the session is terminal and decoding must stop. */
  #onFrame(kind: number, payload: Uint8Array): boolean {
    switch (kind) {
      case KIND_EVENT:
        return this.#onEvent(payload);
      case KIND_RESPONSE:
        return this.#onResponse(payload);
      case KIND_CHUNK:
        return this.#onChunk(payload);
      default:
        this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "unknown frame kind"));
        return false;
    }
  }

  #onEvent(payload: Uint8Array): boolean {
    const event = decodeJson(payload) as { event?: unknown; protocol?: unknown } | null;
    if (event === null || event.event !== SOURCE_READY_EVENT) {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "unexpected event"));
      return false;
    }
    // A version mismatch is an architecture or packaging fault. Settling it as a
    // distinguishable failure is the whole reason the version is announced;
    // proceeding hopefully would produce a hang instead.
    if (event.protocol !== SOURCE_PROTOCOL_VERSION) {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "protocol version mismatch"));
      return false;
    }
    this.#ready = true;
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
    return true;
  }

  #onChunk(payload: Uint8Array): boolean {
    if (payload.length < CHUNK_HEADER_BYTES) {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "chunk shorter than its header"));
      return false;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const id = Number(view.getBigUint64(0, false));
    const pending = this.#pending;
    // A chunk for no request, for the wrong request, or a second chunk for one
    // that already has bytes. All three mean this side and the helper disagree
    // about what is outstanding, and continuing would attribute bytes to a file
    // that did not produce them.
    if (pending === null || pending.id !== id || pending.chunk !== null) {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "unattributable chunk"));
      return false;
    }
    pending.chunk = payload.slice(CHUNK_HEADER_BYTES);
    return true;
  }

  #onResponse(payload: Uint8Array): boolean {
    const response = decodeJson(payload) as
      | { id?: unknown; ok?: unknown; code?: unknown; result?: unknown }
      | null;
    if (response === null || typeof response.id !== "number") {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "unreadable response"));
      return false;
    }
    const pending = this.#pending;
    if (pending === null || pending.id !== response.id) {
      this.#onTerminal(new NativeSourceError("protocol", undefined, this.#exitCode, "uncorrelated response"));
      return false;
    }
    this.#settle(pending, response);
    return true;
  }

  #settle(pending: Pending, response: { ok?: unknown; code?: unknown; result?: unknown }): void {
    clearTimeout(pending.timer);
    this.#pending = null;
    if (response.ok === true) {
      pending.resolve({ value: response.result ?? {}, chunk: pending.chunk });
    } else {
      const helperCode = typeof response.code === "string" ? response.code : undefined;
      pending.reject(new NativeSourceError("refused", helperCode, this.#exitCode));
    }
    const next = this.#queue.shift();
    if (next !== undefined) next();
  }

  /** Ends the session. Every terminal path funnels here so none can forget one. */
  #onTerminal(error: NativeSourceError): void {
    if (this.#child !== null) {
      try {
        this.#child.kill();
      } catch {
        // Already gone.
      }
    }
    this.#failAll(error);
  }

  #failAll(error: NativeSourceError): void {
    // First cause wins: a later teardown must not overwrite the reason the
    // session actually ended.
    this.#terminal ??= error;
    this.#disposed = true;
    this.#ready = false;
    const pending = this.#pending;
    this.#pending = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
    const queued = this.#queue;
    this.#queue = [];
    // Woken so their own disposed check rejects them, rather than left parked on
    // a promise nothing will ever resolve.
    for (const resume of queued) resume();
  }

  async #awaitExit(withinMs: number): Promise<boolean> {
    if (this.#exitCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.#exitCode !== null), withinMs);
      this.#child?.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** Length-prefixed framing, matching `wire.EncodeFrame`. */
export function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(payload: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
