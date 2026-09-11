// Bound reads of a file the user chose, or nothing at all.
//
// ## Fail closed, and what that actually means
//
// On Windows this module NEVER returns "no native support". If the helper
// cannot be located, cannot be started, or refuses, `open` rejects. It does not
// hand back a Node-based reader, because the caller asked for a guarantee and a
// silent substitute would let the product keep claiming one it no longer has.
//
// Off Windows the factory returns `null`. That is not the same answer dressed
// differently: `null` says no native guarantee exists on this platform at all,
// so a caller cannot mistake it for a degraded one. The Node path remains, as a
// disclosed development and test path, and it reports no identity.
//
// ## Identity binds bytes to an object, and it is exact
//
// The walk excludes ancestor redirection: no component is resolved by the OS on
// our behalf, so a junction swapped mid-walk cannot move us. It does NOT by
// itself bind the leaf across a reopen — a file replaced between two opens is a
// different object reached by the same name. Two mechanisms cover that, in
// order:
//
//  1. The helper holds the handle from open through every read to close. While
//     a handle is held, the bytes are bound by the handle and nothing here has
//     to compare anything.
//  2. A caller that must reopen — an eviction under a handle cap, for instance —
//     passes the identity captured at staging. A mismatch is TERMINAL for that
//     entry: it is refused, not retried, because a retry would loop on whatever
//     now occupies the name.
//
// The identity is a 64-bit volume serial and a 128-bit file id, and it crosses
// as hex STRINGS end to end. Neither value survives a float64, so there is no
// numeric form of either anywhere on this path; the Node fallback's tolerance
// for a zero or unavailable identity deliberately does NOT apply here, because
// that tolerance exists for a path which claims nothing.
import {
  MAX_SOURCE_READ_BYTES,
  NativeSourceClient,
  NativeSourceError,
  SOURCE_MODE_ARG,
  type SourceCloseState,
} from "./native-source-client.js";
import {
  bundledHelperPath,
  type HelperChild,
  type SpawnHelper,
} from "./native-helper-client.js";

export { MAX_SOURCE_READ_BYTES, SOURCE_MODE_ARG };

/** An exact, nonzero file identity, hex-encoded. */
export interface SourceIdentity {
  /** 16 lowercase hex characters — a 64-bit volume serial. */
  readonly volumeSerial: string;
  /** 32 lowercase hex characters — a 128-bit file id. */
  readonly fileId: string;
}

const VOLUME_SERIAL_PATTERN = /^[0-9a-f]{16}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Whether an identity is exact and nonzero.
 *
 * All-zero is rejected even though it is well-formed: a volume that reports
 * zeroes gives every file the same identity, which would make `sameIdentity`
 * answer true for two different files.
 */
export function isCompleteIdentity(identity: SourceIdentity): boolean {
  if (!VOLUME_SERIAL_PATTERN.test(identity.volumeSerial)) return false;
  if (!FILE_ID_PATTERN.test(identity.fileId)) return false;
  if (/^0+$/.test(identity.volumeSerial)) return false;
  if (/^0+$/.test(identity.fileId)) return false;
  return true;
}

/**
 * Exact equality, and only between two complete identities.
 *
 * Two incomplete identities are NOT equal to each other. Returning true for
 * them would be the precise failure this rule exists to prevent: a volume that
 * cannot identify its files would report every file as matching every other.
 */
export function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  if (!isCompleteIdentity(a) || !isCompleteIdentity(b)) return false;
  return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
}

export type BindingFailure =
  /** The helper answered with an identity that is not exact and nonzero. */
  | "identity-incomplete"
  /** The file at this path is not the file that was staged. */
  | "identity-mismatch";

/**
 * A reopen that did not land on the staged object.
 *
 * Separate from `NativeSourceError` because it is not a helper failure: the
 * helper did exactly what it was asked and the answer was that the name now
 * refers to something else. Terminal for the entry.
 */
export class SourceBindingError extends Error {
  constructor(readonly reason: BindingFailure) {
    super(reason);
    this.name = "SourceBindingError";
  }
}

/** One open source. Reads are bounded; nothing here exposes a path. */
export interface NativeSourceHandle {
  /** Length observed at open time, from the handle. */
  readonly size: number;
  readonly identity: SourceIdentity;
  /**
   * Reads at most `length` bytes from `offset`.
   *
   * `eof` is what the read itself observed, never inferred from `size`: the
   * file may have been truncated or extended since it was opened.
   */
  read(offset: number, length: number): Promise<{ bytes: Uint8Array; eof: boolean }>;
  /** Releases the handle and reports whether the process actually got it back. */
  close(): Promise<SourceCloseState>;
}

export interface NativeSourceProvider {
  /**
   * Opens one source.
   *
   * When `expected` is supplied this is a REBIND: the identity must match
   * exactly or the handle is released and the call rejects with
   * `SourceBindingError`. There is no retry, here or above.
   */
  open(absolutePath: string, expected?: SourceIdentity): Promise<NativeSourceHandle>;
  /** Releases everything and reports handles this process did not get back. */
  dispose(): Promise<{ leftover: number; exitCode: number | null }>;
  /** Handles currently open through this provider. */
  readonly openCount: number;
}

export interface NativeSourceProviderOptions {
  /**
   * How the child is obtained. Supplied only by tests; production resolves the
   * one packaged executable and passes the one fixed argument.
   */
  readonly spawn?: SpawnHelper;
  /** Overridden only by tests. Production reads the real platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Creates the provider, or reports that this platform has no native guarantee.
 *
 * Returns `null` only off Windows. On Windows it always returns a provider,
 * even when the helper is missing — that provider then rejects every open,
 * which is the fail-closed behaviour. A `null` on Windows would read to a
 * caller as "use the other path", and there is no other path that can make this
 * claim.
 */
export function createNativeSourceProvider(
  options: NativeSourceProviderOptions = {},
): NativeSourceProvider | null {
  // Main-only, asserted rather than assumed. A renderer holding this would hold
  // a reader for arbitrary absolute paths, which is the whole shape this design
  // exists to keep out of the renderer.
  const processType = (process as { type?: unknown }).type;
  if (processType === "renderer") {
    throw new Error("the native source provider is main-only");
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return null;
  return new HelperSourceProvider(options.spawn ?? defaultSpawn);
}

/**
 * The production spawn: the one packaged executable, one fixed argument.
 *
 * The path comes from the layout resolver the receive client already uses, so
 * both helpers agree about where the binary lives. There is no environment
 * variable and no runtime flag that can redirect it, because such a switch
 * would be reachable from anything able to set an environment variable.
 */
const defaultSpawn: SpawnHelper = async (): Promise<HelperChild> => {
  const { spawn } = await import("node:child_process");
  const child = spawn(bundledHelperPath(), [SOURCE_MODE_ARG], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.on("exit", listener);
    },
    onClose: (listener) => {
      child.on("close", () => listener());
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    kill: (signal) => child.kill(signal),
  };
};

class HelperSourceProvider implements NativeSourceProvider {
  readonly #client: NativeSourceClient;
  readonly #open = new Set<HelperSourceHandle>();
  #disposed = false;
  #leftover = 0;

  constructor(spawn: SpawnHelper) {
    this.#client = new NativeSourceClient({ spawn });
  }

  get openCount(): number {
    return this.#open.size;
  }

  async open(absolutePath: string, expected?: SourceIdentity): Promise<NativeSourceHandle> {
    if (this.#disposed) throw new NativeSourceError("closed");
    const opened = await this.#client.open(absolutePath);
    const identity: SourceIdentity = {
      volumeSerial: opened.volumeSerial,
      fileId: opened.fileId,
    };
    // Checked before the handle is handed out, and the handle is RELEASED on
    // refusal. Returning it alongside a binding failure would leave the caller
    // holding a reader for an object it just refused.
    const failure = bindingFailure(identity, expected);
    if (failure !== null) {
      await this.#release(opened.source);
      throw new SourceBindingError(failure);
    }
    const handle = new HelperSourceHandle(this.#client, opened.source, opened.size, identity, (h) => {
      this.#open.delete(h);
    }, () => {
      this.#leftover++;
    });
    this.#open.add(handle);
    return handle;
  }

  async dispose(): Promise<{ leftover: number; exitCode: number | null }> {
    this.#disposed = true;
    // Every handle is attempted even after one fails; stopping early would
    // abandon the rest to make the count tidier.
    for (const handle of [...this.#open]) {
      try {
        await handle.close();
      } catch {
        // The process teardown below is what actually reclaims it, and the
        // count already records that this side did not get it back.
        this.#leftover++;
        this.#open.delete(handle);
      }
    }
    const { exitCode } = await this.#client.dispose();
    return { leftover: this.#leftover, exitCode };
  }

  async #release(source: number): Promise<void> {
    try {
      if ((await this.#client.close(source)) === "failed-close") this.#leftover++;
    } catch {
      this.#leftover++;
    }
  }
}

function bindingFailure(identity: SourceIdentity, expected?: SourceIdentity): BindingFailure | null {
  if (!isCompleteIdentity(identity)) return "identity-incomplete";
  if (expected === undefined) return null;
  return sameIdentity(identity, expected) ? null : "identity-mismatch";
}

class HelperSourceHandle implements NativeSourceHandle {
  #closed = false;
  readonly #client: NativeSourceClient;
  readonly #source: number;
  readonly #forget: (handle: HelperSourceHandle) => void;
  readonly #countLeftover: () => void;

  constructor(
    client: NativeSourceClient,
    source: number,
    readonly size: number,
    readonly identity: SourceIdentity,
    forget: (handle: HelperSourceHandle) => void,
    countLeftover: () => void,
  ) {
    this.#client = client;
    this.#source = source;
    this.#forget = forget;
    this.#countLeftover = countLeftover;
  }

  async read(offset: number, length: number): Promise<{ bytes: Uint8Array; eof: boolean }> {
    if (this.#closed) throw new NativeSourceError("closed");
    return this.#client.read(this.#source, offset, length);
  }

  async close(): Promise<SourceCloseState> {
    if (this.#closed) return "closed";
    // Marked closed BEFORE the call, and forgotten regardless of outcome. A
    // handle whose release failed is in an unknown state and must not stay
    // readable; leaving it usable so the caller could retry would be offering a
    // read on exactly that handle.
    this.#closed = true;
    this.#forget(this);
    try {
      const state = await this.#client.close(this.#source);
      if (state === "failed-close") this.#countLeftover();
      return state;
    } catch (error) {
      this.#countLeftover();
      throw error;
    }
  }
}
