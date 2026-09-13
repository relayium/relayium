// The host half of the native receive helper: one child process, one lease.
//
// ## What this replaces, and why it is not a publisher
//
// `ReceiveLease` stages with Node and cannot publish: `fs.rename` overwrites,
// and an `lstat` before it is a race. The obvious-looking fix — hand the helper
// the staged paths and let it do the rename — is the one shape that must not be
// built. `apps/windows/native/internal/winio` refuses it in as many words: an
// externally supplied staging path is a trust claim the helper cannot verify.
// Every containment guarantee it offers comes from holding the handle it wrote
// through, from creation to rename, so splitting staging from publication gives
// away the whole point.
//
// So this is a sibling destination, not a publisher plugged into the old one.
// `ReceiveLease` is untouched and remains the non-native path.
//
// ## No host staging. No filesystem at all.
//
// This module imports nothing from `node:fs`. It creates no directory, opens no
// file and deletes nothing. It does not know the staging path and must not learn
// it: cleanup belongs to the helper, by handle. The only filesystem interaction
// in the whole client is spawning one fixed executable.
//
// ## Types are structural on purpose
//
// The receive-destination interface and the publish report live in a lane whose
// source is not accepted yet, and copying a live file across writer trees is how
// two versions of one contract start drifting. The shapes below are declared
// here instead, so this module compiles against nothing unaccepted; assignment
// to the integrating interface is proven at wiring time.

// `node:path` and `node:url` are pure string manipulation and touch no
// filesystem. They are the ONLY additions to the import surface; `node:fs` in
// any form stays forbidden, which the test asserts on this module's source.
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Manifest entry as the helper's `open` request carries it. */
export interface NativeManifestEntry {
  readonly name: string;
  readonly size: number;
}

/**
 * Structural mirror of the receive-destination shape.
 *
 * Indices, never paths: the caller refers to files by their position in the
 * manifest the helper already validated. That is what makes a compromised
 * renderer unable to name a destination, and it is preserved verbatim here —
 * no method on this interface accepts a path.
 */
export interface NativeReceiveDestination {
  readonly fileCount: number;
  assertAuthority(authorityId: string): void;
  begin(index: number): Promise<void>;
  write(index: number, chunk: Uint8Array): Promise<void>;
  finish(index: number): Promise<void>;
  publish(): Promise<NativePublishReport>;
  cancel(): Promise<void>;
}

/**
 * The truthful outcome of publication.
 *
 * `partial` is a value rather than a rejection because some files can genuinely
 * exist under their final names while the rest never will, and calling that
 * either success or failure is a lie in one direction.
 */
export type NativePublishReport =
  | { readonly status: "complete"; readonly publishedCount: number; readonly total: number }
  | {
      readonly status: "partial";
      readonly publishedCount: number;
      readonly total: number;
      readonly failedIndex: number;
      readonly reason: string;
    };

export type NativeHelperErrorCode =
  | "helper-unavailable"
  | "helper-timeout"
  | "protocol"
  | "busy"
  | "cancelled"
  | "manifest-refused"
  | "authority-changed"
  | "length-exceeded"
  | "length-short"
  | "short-write"
  | "publish-failed"
  | "cleanup-uncertain"
  | "residue"
  | "io-failed"
  | "internal";

/**
 * A helper failure, carrying whether bytes may have been left on the user's
 * disk.
 *
 * `residue` is on the error rather than in a report because the destination
 * interface's `cancel()` resolves `void`: a cleanup that left bytes behind has
 * no field to travel in, and resolving cleanly would be the silent-loss
 * reporting this whole path exists to prevent. So an inconclusive teardown
 * REJECTS, and the flag rides along.
 */
export class NativeHelperError extends Error {
  constructor(
    readonly code: NativeHelperErrorCode,
    /** True when bytes may remain on disk. Never a guess dressed as a `false`. */
    readonly residue: boolean = false,
    /** The helper's own stable `E_*` code, when it supplied one. */
    readonly helperCode?: string,
    /** Process exit code, when the process had ended. */
    readonly exitCode?: number | null,
    message?: string,
    /**
     * The validated publish receipt, when publication had already succeeded and
     * only the teardown afterwards failed.
     *
     * This is root's `partialReport`, widened: a COMPLETE publish followed by a
     * residue-reporting cleanup must preserve its counts too, and a field named
     * for the partial case would misdescribe it. Its purpose is the same — the
     * outputs that were published still exist, and an error about cleanup must
     * not erase that. The caller renders this rather than inferring that
     * nothing was saved.
     */
    readonly publishReport?: NativePublishReport,
  ) {
    super(message ?? (helperCode !== undefined ? `${code}: ${helperCode}` : code));
    this.name = "NativeHelperError";
  }
}

/** What cleanup actually achieved, as the helper reported it. */
export interface NativeCancelReport {
  readonly removedFiles: number;
  readonly residue: boolean;
  readonly exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Wire protocol. Mirrors apps/windows/native/internal/wire.
// ---------------------------------------------------------------------------

const KIND_REQUEST = 1;
const KIND_CHUNK = 2;
const KIND_RESPONSE = 3;
const KIND_EVENT = 4;

const FRAME_HEADER_BYTES = 5; // u32be length (payload + kind) + u8 kind
const CHUNK_HEADER_BYTES = 12; // u64be id + u32be index

const PROTOCOL_VERSION = 1;

/**
 * Inbound frames are bounded by what the helper can legally send, not by its
 * global frame ceiling.
 *
 * The helper enforces a 4096-byte response bound on encode, and the only other
 * thing it sends is a tiny `ready` event. Sizing this side's limit from the
 * 8 MiB frame ceiling instead would let a compromised or wedged helper make the
 * main process allocate megabytes per frame for messages that can never
 * legitimately exceed 4 KiB.
 */
const MAX_INBOUND_PAYLOAD_BYTES = 4096;
const MAX_INBOUND_LENGTH_FIELD = MAX_INBOUND_PAYLOAD_BYTES + 1;

/** Outbound bounds, enforced here so a host bug cannot trip the helper's own
 *  protocol kill and turn a local mistake into a failed transfer. */
const MAX_OPEN_REQUEST_BYTES = 4 << 20;
const MAX_REQUEST_BYTES = 64 << 10;
const MAX_CHUNK_BYTES = 256 << 10;

/**
 * The closed set of codes this client will retain from stderr.
 *
 * ## Why a closed set and not a pattern
 *
 * The previous version kept any line matching a character class that excluded
 * `\` and `/`, and claimed that made it path-free. It did not: `SECRET.txt` is
 * a filename, `Documents` is a private word, and a path split across two writes
 * arrives as two slash-free pieces. Excluding separators excludes separators,
 * nothing more.
 *
 * So no raw text is retained at all. A line is reduced to a code from this set,
 * or it is counted and discarded. `diagnostics` is therefore incapable of
 * carrying user content, by construction rather than by filtering.
 */
const KNOWN_HELPER_CODES: ReadonlySet<string> = new Set([
  "E_PROTOCOL", "E_SEQUENCE", "E_CANCELLED", "E_HOST_BACKPRESSURE",
  "E_RESPONSE_TOO_LARGE", "E_INTERNAL", "E_MANIFEST", "E_NAME_TOO_LONG",
  "E_ROOT", "E_REPARSE_COMPONENT", "E_UNSUPPORTED_VOLUME", "E_EXISTS",
  "E_TYPE_CONFLICT", "E_ACCESS", "E_SHARING", "E_NO_SPACE", "E_DELETE_PENDING",
  "E_NOT_FOUND", "E_IO", "E_LENGTH_EXCEEDED", "E_LENGTH_SHORT",
  "E_SHORT_WRITE", "E_PARTIAL_PUBLICATION",
]);

/** Distinct codes tracked before the counter stops growing. */
const MAX_TRACKED_CODES = 32;

export const HELPER_EXECUTABLE_NAME = "relayium-io-helper.exe";

// ---------------------------------------------------------------------------
// Process seam
// ---------------------------------------------------------------------------

export interface HelperReadable {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
}

export interface HelperWritable {
  write(chunk: Uint8Array): unknown;
  end(): unknown;
}

/**
 * The subset of a child process this client uses.
 *
 * A structural seam rather than `ChildProcess` so the tests can drive an
 * adversarial fake. It is supplied through the CONSTRUCTOR only: there is no
 * environment variable and no runtime flag that can redirect which executable
 * runs, because such a switch would be reachable from anything that can set an
 * environment variable in the main process.
 */
export interface HelperChild {
  readonly stdin: HelperWritable | null;
  readonly stdout: HelperReadable | null;
  readonly stderr: HelperReadable | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * How the child is obtained. May be async, which is what lets the production
 * factory — a dynamic `node:child_process` import — be the DEFAULT rather than
 * something a caller has to supply.
 */
export type SpawnHelper = () => HelperChild | Promise<HelperChild>;

export interface NativeHelperDeadlines {
  /** Until the `ready` event. */
  readonly startupMs: number;
  /** Any ordinary request. */
  readonly requestMs: number;
  /** `publish`, which does real filesystem work per file. */
  readonly publishMs: number;
  /** From sending `cancel` to the process closing. Must exceed the helper's
   *  own ShutdownGrace, or this side would kill a helper that was about to
   *  settle cleanly. */
  readonly cancelExitMs: number;
  /** From `exit` to `close`. Node emits `exit` while stdio may still be
   *  draining, and the last buffered response can arrive in that window. */
  readonly closeAfterExitMs: number;
}

export const DEFAULT_DEADLINES: NativeHelperDeadlines = {
  startupMs: 5_000,
  requestMs: 30_000,
  publishMs: 120_000,
  // The helper's ShutdownGrace is 5s and its WriterDrainGrace 1s.
  cancelExitMs: 7_000,
  closeAfterExitMs: 1_000,
};

export interface NativeHelperClientOptions {
  readonly authorityId: string;
  readonly rootPath: string;
  readonly manifest: readonly NativeManifestEntry[];
  /**
   * Test seam. **Omit it in production** — it then defaults to
   * `spawnBundledHelper`, so this client is usable with no injection at all.
   * Supplied through the constructor only: an environment variable or runtime
   * flag would be reachable by anything able to set one in the main process.
   */
  readonly spawnHelper?: SpawnHelper;
  readonly deadlines?: Partial<NativeHelperDeadlines>;
}

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

function encodeFrame(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength + 1, false);
  frame[4] = kind;
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

function encodeChunkPayload(id: number, index: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, BigInt(id), false);
  view.setUint32(8, index, false);
  payload.set(data, CHUNK_HEADER_BYTES);
  return payload;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

interface InboundFrame {
  readonly kind: number;
  readonly payload: Uint8Array;
}

/** A helper response, after shape validation but before semantic checks. */
interface HelperResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Bundled executable path
// ---------------------------------------------------------------------------

/**
 * Which install layout this process is running from.
 *
 * Read from the process, never from a caller, a renderer message or an
 * environment variable — there is no executable override of any kind.
 */
export interface HelperLayout {
  /** Electron's `process.defaultApp`: set only when running UNPACKAGED. */
  readonly unpackaged: boolean;
  /** Electron's `process.resourcesPath`, or null outside Electron. */
  readonly resourcesPath: string | null;
  /** Directory of this module, used only by the engineering layout. */
  readonly moduleDir: string;
}

/**
 * Resolve the one executable this client will run.
 *
 * ## Why the layout is explicit
 *
 * The previous version used `process.resourcesPath` whenever it was defined and
 * fell back to `process.cwd()`. Both halves were wrong: `resourcesPath` is also
 * defined in an UNPACKAGED Electron run, so the packaged branch was taken in
 * development and pointed at Electron's own resources; and `cwd()` is whatever
 * directory the process happened to start in, which gates nothing. Neither
 * branch could be tested without mutating globals.
 *
 * So the two layouts are named and fixed, `unpackaged` selects between them,
 * and an unresolvable or relative result THROWS rather than producing a path
 * that would be spawned hopefully.
 */
export function resolveHelperPath(layout: HelperLayout): string {
  let resolved: string;
  if (layout.unpackaged) {
    // Engineering: the Go build output beside the app. `dist/main/io` (compiled)
    // and `src/main/io` (tests, via the bundler) sit at the same depth, which is
    // why one fixed climb serves both.
    resolved = join(layout.moduleDir, "..", "..", "..", "native", "build", HELPER_EXECUTABLE_NAME);
  } else {
    if (layout.resourcesPath === null || layout.resourcesPath.length === 0) {
      throw new NativeHelperError(
        "helper-unavailable", false, undefined, null,
        "packaged layout has no resourcesPath, so the bundled helper cannot be located",
      );
    }
    resolved = join(layout.resourcesPath, HELPER_EXECUTABLE_NAME);
  }
  if (!isAbsolute(resolved)) {
    throw new NativeHelperError(
      "helper-unavailable", false, undefined, null,
      "resolved helper path is not absolute",
    );
  }
  return resolved;
}

function currentLayout(): HelperLayout {
  const proc = process as { defaultApp?: unknown; resourcesPath?: unknown };
  const resources = typeof proc.resourcesPath === "string" ? proc.resourcesPath : null;
  return {
    unpackaged: proc.defaultApp === true,
    resourcesPath: resources,
    moduleDir: join(fileURLToPath(import.meta.url), ".."),
  };
}

/** The production executable path. Takes no arguments by design. */
export function bundledHelperPath(): string {
  return resolveHelperPath(currentLayout());
}

/**
 * The production spawn, isolated so the client itself holds no reference to
 * `node:child_process` and the test never needs to stub a module.
 *
 * Deliberately: no arguments, no shell, and an explicit minimal environment.
 * `TEMP` is included because it is a genuine system prerequisite — this is not
 * a claim that the environment is path-free, only that it carries no credential,
 * token, account identifier or user-chosen path, and that it is an allowlist
 * rather than a copy of `process.env`.
 */
export async function spawnBundledHelper(): Promise<HelperChild> {
  const { spawn } = await import("node:child_process");
  const child = spawn(bundledHelperPath(), [], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      SystemRoot: process.env["SystemRoot"] ?? "",
      windir: process.env["windir"] ?? "",
      TEMP: process.env["TEMP"] ?? "",
      NUMBER_OF_PROCESSORS: process.env["NUMBER_OF_PROCESSORS"] ?? "",
    },
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onClose: (listener) => {
      child.once("close", () => listener());
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    kill: (signal) => child.kill(signal),
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

interface Pending {
  readonly id: number;
  readonly settle: (response: HelperResponse) => void;
  readonly fail: (error: NativeHelperError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// "failed" blocks every new operation but still permits teardown: an accounting
// mismatch leaves the staged file in an unknown state, so nothing more may be
// written — but the helper is alive and its cleanup must still be asked for.
/** What a cancel reply established. */
type CancelVerdict = "none" | "clean" | "residue" | "malformed";

type ClientState = "starting" | "ready" | "failed" | "cancelling" | "closing" | "closed";

export class NativeHelperClient implements NativeReceiveDestination {
  private readonly deadlines: NativeHelperDeadlines;
  private readonly declaredSizes: readonly number[];

  private child: HelperChild | null = null;
  private state: ClientState = "starting";
  private nextId = 1;

  /** The one ordinary operation in flight. */
  private pending: Pending | null = null;
  /** Cancel is out of band and correlates separately, so an ordinary request
   *  in flight neither blocks it nor is mistaken for it. */
  private cancelPending: Pending | null = null;

  // Annotated rather than inferred: without the explicit ArrayBufferLike the
  // field narrows to an ArrayBuffer-backed view and concat's result no longer
  // assigns to it.
  /**
   * Inbound bytes not yet parsed, held as CHUNK REFERENCES.
   *
   * Nothing is copied on arrival. The previous version concatenated every
   * incoming chunk into one growing buffer before even reading the length
   * field, then re-sliced the remainder after each frame — so a read carrying
   * N coalesced frames cost O(N^2) copying, and an arbitrarily large chunk was
   * copied in full before it could be rejected.
   */
  private queue: Uint8Array[] = [];
  private queued = 0;

  /** Counts per known helper code. No raw stderr text is ever retained. */
  private readonly codeCounts = new Map<string, number>();
  private withheldLines = 0;

  private exitCode: number | null = null;
  private exited = false;
  private closed = false;
  private readonly closeWaiters: Array<() => void> = [];
  private spawnError: Error | null = null;

  /**
   * True once the `open` request has been WRITTEN to the helper.
   *
   * The helper creates its staging directory while handling `open`, so before
   * that frame goes out a kill cannot have left anything on disk, and after it
   * one may have. This is the whole basis for deciding residue after a forced
   * kill, and it is a fact about what was sent rather than a guess.
   */
  private stagingMayExist = false;
  /** Guards terminalFailure so a second malformed frame cannot re-enter it. */
  private terminating = false;
  private cancellation: Promise<void> | null = null;
  private lastCancel: NativeCancelReport | null = null;
  /** What the cancel reply established, if one arrived at all. */
  private cancelReply: CancelVerdict = "none";

  private files = 0;
  /** Bytes this side has counted for the open file, compared against the
   *  helper's own `written` rather than trusted from the request length. */
  private writtenForCurrent = 0;
  private currentIndex: number | null = null;

  private constructor(
    readonly authorityId: string,
    manifest: readonly NativeManifestEntry[],
    deadlines: NativeHelperDeadlines,
  ) {
    this.deadlines = deadlines;
    this.declaredSizes = manifest.map((entry) => entry.size);
  }

  /**
   * Spawn the helper, wait for it to announce itself, and open the lease.
   *
   * The `ready` event is required first so a launch failure, an architecture
   * mismatch or a missing executable settles the caller instead of hanging on a
   * request that will never be answered.
   */
  static async open(options: NativeHelperClientOptions): Promise<NativeHelperClient> {
    const deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
    const client = new NativeHelperClient(options.authorityId, options.manifest, deadlines);
    // Production default. The previous version claimed the bundled executable
    // was used when no transport was injected, and then threw — so there was no
    // production path at all.
    const spawnHelper = options.spawnHelper ?? spawnBundledHelper;

    let child: HelperChild;
    try {
      // Awaited ONLY when the factory is actually asynchronous.
      //
      // An unconditional await inserts a microtask boundary between the child
      // being produced and its listeners being attached, and a transport that
      // emits promptly — `ready` on a queued microtask, say — loses that frame
      // into a stdout nobody is listening to yet. Node's own streams stay
      // paused until a listener attaches, so the production factory is
      // unaffected either way; a synchronous transport must not be penalised
      // for the async one's needs.
      const produced = spawnHelper();
      child = produced instanceof Promise ? await produced : produced;
    } catch (error) {
      throw error instanceof NativeHelperError
        ? error
        : new NativeHelperError("helper-unavailable", false, undefined, null, String(error));
    }
    client.attach(child);

    try {
      await client.awaitReady();
      // From here a staging directory may exist on the user's disk, whatever
      // happens next.
      client.stagingMayExist = true;
      const result = await client.request(
        "open",
        { root: options.rootPath, manifest: options.manifest },
        deadlines.requestMs,
        MAX_OPEN_REQUEST_BYTES,
      );
      const files = isRecord(result) ? asInteger(result["files"]) : null;
      if (files === null || files !== options.manifest.length) {
        throw new NativeHelperError(
          "protocol",
          false,
          undefined,
          client.exitCode,
          "open receipt disagrees with the manifest length",
        );
      }
      client.files = files;
      return client;
    } catch (error) {
      // A lease that failed to open still owns a process, and possibly a
      // staging directory, so it is torn down before the error escapes.
      //
      // The ORIGINAL failure is the cause and stays the reported code. An
      // earlier version let the teardown's own rejection win, which turned
      // "the helper never announced itself" into "residue" — and the residue
      // was this client's own SIGKILL of a process that had never opened a
      // lease. Residue is additive: it is carried onto the original error when
      // cleanup genuinely reported it, never substituted for the diagnosis.
      let leftBytes = false;
      await client.cancel().catch((cleanupError: unknown) => {
        if (cleanupError instanceof NativeHelperError && cleanupError.residue) {
          leftBytes = true;
        }
      });
      if (leftBytes && error instanceof NativeHelperError) {
        throw new NativeHelperError(error.code, true, error.helperCode, error.exitCode, error.message);
      }
      throw error;
    }
  }

  get fileCount(): number {
    return this.files;
  }

  /** Diagnostic only. Never a substitute for the rejection `cancel()` raises. */
  get lastCancelReport(): NativeCancelReport | null {
    return this.lastCancel;
  }

  /**
   * Counted helper codes, and how many lines were withheld entirely.
   *
   * Cannot carry user content: every value here is either a code from a closed
   * set or an integer.
   */
  get diagnostics(): readonly string[] {
    const out: string[] = [];
    for (const [code, count] of this.codeCounts) out.push(`${code} x${count}`);
    if (this.withheldLines > 0) out.push(`withheld ${this.withheldLines} line(s)`);
    return out;
  }

  assertAuthority(authorityId: string): void {
    if (authorityId !== this.authorityId) {
      throw new NativeHelperError("authority-changed");
    }
  }

  async begin(index: number): Promise<void> {
    await this.request("begin", { index }, this.deadlines.requestMs, MAX_REQUEST_BYTES);
    this.currentIndex = index;
    this.writtenForCurrent = 0;
  }

  /**
   * Append one bounded chunk and require the helper's own count to agree.
   *
   * The helper reports `written` as the cumulative total it has accounted for
   * on the open file. Comparing it against a count kept here means two
   * independently derived numbers have to match; trusting the request length
   * instead would advance this side past bytes that are not on disk.
   */
  async write(index: number, chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength > MAX_CHUNK_BYTES) {
      throw new NativeHelperError("length-exceeded", false, undefined, null, "chunk exceeds maximum");
    }
    if (this.currentIndex !== index) {
      throw new NativeHelperError("protocol", false, undefined, null, "chunk for a file that is not open");
    }
    const declared = this.declaredSizes[index];
    if (declared === undefined) {
      throw new NativeHelperError("protocol", false, undefined, null, "index outside the manifest");
    }
    const expected = this.writtenForCurrent + chunk.byteLength;
    if (expected > declared) {
      throw new NativeHelperError("length-exceeded");
    }

    const result = await this.sendChunk(index, chunk);
    const written = isRecord(result) ? asInteger(result["written"]) : null;
    const reportedDeclared = isRecord(result) ? asInteger(result["declared"]) : null;
    if (written === null || reportedDeclared === null) {
      throw this.terminalize(new NativeHelperError("protocol", false, undefined, null, "chunk receipt is not the documented shape"));
    }
    if (reportedDeclared !== declared) {
      throw this.terminalize(new NativeHelperError("protocol", false, undefined, null, "helper and host disagree about the declared length"));
    }
    if (written !== expected) {
      // Not merely a mismatch to log: the helper counted a different number of
      // bytes on disk than this side sent, so the file's length is no longer
      // something either party can vouch for.
      throw this.terminalize(new NativeHelperError("short-write", false, undefined, null, `helper accounted ${written}, host sent ${expected}`));
    }
    this.writtenForCurrent = written;
  }

  async finish(index: number): Promise<void> {
    const declared = this.declaredSizes[index];
    if (declared === undefined) {
      throw new NativeHelperError("protocol", false, undefined, null, "index outside the manifest");
    }
    const result = await this.request("finish", { index }, this.deadlines.requestMs, MAX_REQUEST_BYTES);
    const bytes = isRecord(result) ? asInteger(result["bytes"]) : null;
    if (bytes === null) {
      throw this.terminalize(new NativeHelperError("protocol", false, undefined, null, "finish receipt is not the documented shape"));
    }
    if (bytes !== declared) {
      throw this.terminalize(new NativeHelperError("length-short", false, undefined, null, `helper finished ${bytes} of ${declared}`));
    }
    this.currentIndex = null;
    this.writtenForCurrent = 0;
  }

  /**
   * Move the staged batch to the user's chosen names. The only operation whose
   * success means "saved".
   *
   * ## A partial publish arrives as ok:false, and that is not an error
   *
   * The helper answers a partial batch with `ok:false`, code
   * `E_PARTIAL_PUBLICATION`, and a receipt describing exactly what landed. An
   * earlier draft of this client treated every `ok:false` as a plain failure,
   * which would have thrown away truthful knowledge that files 0..N-1 exist on
   * the user's disk — the user would be told nothing was saved while some of it
   * was.
   *
   * But the converse is worse, so the partial mapping is gated on proof. Only a
   * receipt whose every field corroborates the prefix claim becomes a `partial`:
   * the total must equal the manifest count, the published count must be a
   * proper prefix, the failure index must be exactly that count (which is what
   * makes "0..count-1 saved" true), the unattempted range must be the rest, and
   * the code must be the partial-publication code specifically. Anything else —
   * a generic `ok:false`, a missing receipt, an inconsistent count — is an
   * error, because a report this side cannot verify is not a report.
   */
  async publish(): Promise<NativePublishReport> {
    const response = await this.requestRaw("publish", {}, this.deadlines.publishMs, MAX_REQUEST_BYTES);
    const total = this.files;

    if (response.ok) {
      const result = response.result;
      if (!isRecord(result) || result["status"] !== "complete") {
        throw this.terminalize(new NativeHelperError("protocol", false, response.code, this.exitCode, "publish success without a complete receipt"));
      }
      const publishedCount = asInteger(result["publishedCount"]);
      const reportedTotal = asInteger(result["total"]);
      if (publishedCount === null || reportedTotal === null) {
        throw this.terminalize(new NativeHelperError("protocol", false, response.code, this.exitCode, "complete receipt is not the documented shape"));
      }
      if (reportedTotal !== total || publishedCount !== total) {
        // "Complete" has exactly one arithmetic: everything, and the same
        // everything both sides agreed on.
        throw this.terminalize(new NativeHelperError("protocol", false, response.code, this.exitCode, `complete receipt claims ${publishedCount} of ${reportedTotal}, manifest has ${total}`));
      }
      return this.settleAfterPublish({ status: "complete", publishedCount, total });
    }

    const partial = this.validatedPartial(response, total);
    if (partial !== null) {
      return this.settleAfterPublish(partial);
    }
    throw new NativeHelperError("publish-failed", false, response.code, this.exitCode, response.code ?? "publish refused");
  }

  /**
   * Finish the lease after a validated receipt.
   *
   * ## The helper does not exit on publish
   *
   * `Serve` keeps running its loop after answering `publish`, and the caller
   * drops the lease once publication settles. If this method returned the
   * report and nothing else, the process and its staging directory would
   * outlive every reference to them — a leaked child per transfer, and leaked
   * bytes after a partial. So stdin is closed, which is the documented way to
   * ask the helper to clean up and exit, and the close is JOINED before the
   * report is handed back.
   *
   * ## The saved prefix survives a failed teardown
   *
   * Cleanup failing does not un-publish anything. Files 0..publishedCount-1
   * exist on the user's disk whatever happens next, so a residue-reporting or
   * inconclusive teardown rejects — residue must never be dropped — but the
   * validated report rides along on the error. The outcome is never rewritten
   * into `complete`, and the fact that some outputs exist is never erased.
   */
  private async settleAfterPublish(report: NativePublishReport): Promise<NativePublishReport> {
    this.state = "closing";
    this.endStdin();

    let observed = await this.awaitClose(this.deadlines.cancelExitMs);
    if (!observed) {
      this.killChild();
      observed = await this.awaitClose(this.deadlines.closeAfterExitMs);
      if (!observed) {
        throw new NativeHelperError(
          "cleanup-uncertain",
          true,
          undefined,
          this.exitCode,
          "helper did not close after publication",
          report,
        );
      }
    }

    const code = this.exitCode;
    if (code === 0) return report;
    if (code === 3) {
      throw new NativeHelperError("residue", true, undefined, code, "published, but cleanup left bytes on disk", report);
    }
    if (code === 5) {
      throw new NativeHelperError("residue", true, undefined, code, "published, but shutdown grace was exceeded", report);
    }
    throw new NativeHelperError(
      "cleanup-uncertain",
      true,
      undefined,
      code,
      `published, but the helper exited ${String(code)}`,
      report,
    );
  }

  /**
   * Returns a partial report only if the receipt proves the prefix claim.
   *
   * Every check here is load-bearing. Without the `failedIndex === count`
   * check in particular, a receipt could claim three files published while
   * naming file one as the failure — and since publication runs in manifest
   * order and stops at the first failure, those two statements cannot both be
   * true. Mapping it anyway would report files as saved on the strength of a
   * receipt that contradicts itself.
   */
  private validatedPartial(response: HelperResponse, total: number): NativePublishReport | null {
    if (response.code !== "E_PARTIAL_PUBLICATION") return null;
    const result = response.result;
    if (!isRecord(result) || result["status"] !== "partial") return null;

    const publishedCount = asInteger(result["publishedCount"]);
    const reportedTotal = asInteger(result["total"]);
    if (publishedCount === null || reportedTotal === null) return null;
    if (reportedTotal !== total) return null;
    // A proper prefix: a partial that published everything is not partial, and
    // a negative count is not a count.
    if (publishedCount < 0 || publishedCount >= total) return null;

    const failed = result["failed"];
    if (!isRecord(failed)) return null;
    const failedIndex = asInteger(failed["index"]);
    const failedCode = failed["code"];
    if (failedIndex === null || typeof failedCode !== "string" || failedCode.length === 0) return null;
    // The prefix proof itself.
    if (failedIndex !== publishedCount) return null;

    const unattempted = result["unattempted"];
    if (unattempted !== undefined) {
      if (!isRecord(unattempted)) return null;
      const from = asInteger(unattempted["from"]);
      const to = asInteger(unattempted["to"]);
      if (from === null || to === null) return null;
      // Derived rather than trusted: the helper's range must be exactly the
      // files after the failure. `from > to` is the documented empty range,
      // which is correct when the last file is the one that failed.
      const expectedFrom = failedIndex + 1;
      const expectedTo = total - 1;
      const empty = expectedFrom > expectedTo;
      if (!empty && (from !== expectedFrom || to !== expectedTo)) return null;
      if (empty && from <= to) return null;
    }

    // `failed.detail` is deliberately NOT forwarded: it carries bounded
    // diagnostics, and `reason` is a field the renderer maps to copy.
    return { status: "partial", publishedCount, total, failedIndex, reason: failedCode };
  }

  /**
   * Terminal and idempotent. Rejects when cleanup could not be confirmed.
   *
   * ## Why this rejects instead of resolving
   *
   * The interface resolves `void`, so a residue flag has nowhere to travel. A
   * cancel that left bytes on the user's disk therefore resolves nothing: it
   * REJECTS with `NativeHelperError.residue === true`, which is the only way
   * this shape can refuse to quietly report a clean teardown it did not
   * achieve. Exit 3 (cleanup incomplete) and exit 5 (shutdown grace exceeded,
   * which implies the documented bounded residue) both take that path, as does
   * a kill whose outcome could not be observed.
   *
   * ## No filesystem access
   *
   * Nothing here touches a path. Cleanup is the helper's, by handle, and this
   * client does not know the staging directory. A host-side `rm` would be a
   * string-resolved delete of a directory it cannot verify it owns.
   */
  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const run = this.runCancel();
    this.cancellation = run;
    // A FAILED teardown must be retryable. Memoising the rejection forever
    // meant a caller acting on `cleanup-uncertain` got the identical rejection
    // back with no second kill attempted — the retained child reference this
    // client's own contract promised was retryable never was. Root's probe
    // caught it: killCount was unchanged across two cancels.
    //
    // A SUCCESSFUL teardown stays memoised, so cancel remains idempotent and a
    // second call cannot send a second cancel frame.
    run.catch(() => {
      if (this.cancellation === run) this.cancellation = null;
    });
    return run;
  }

  private async runCancel(): Promise<void> {
    this.state = "cancelling";
    // A retry re-derives its own verdict rather than inheriting the last one.
    // Reset through a method so control-flow analysis does not narrow the field
    // to the literal and then hide the mutation recordCancelReply makes during
    // the awaits below.
    this.resetCancelVerdict();

    // Signalled promptly and out of band: an ordinary request in flight must
    // not delay it, and must not make it fail `busy`.
    if (!this.closed && this.child !== null) {
      const id = this.nextId++;
      const frame = this.encodeRequest(id, "cancel", {});
      if (frame !== null) {
        const cancelReply = new Promise<HelperResponse>((resolve, reject) => {
          this.cancelPending = { id, settle: resolve, fail: reject, timer: null };
        });
        // A rejection here is recorded through the exit path below rather than
        // thrown: the process outcome is the authority on cleanup.
        cancelReply
          .then((response) => {
            this.recordCancelReply(response);
          })
          .catch(() => undefined);
        this.writeFrame(frame);
        this.endStdin();
      }
    }

    const observed = await this.awaitClose(this.deadlines.cancelExitMs);


    if (!observed) {
      // The helper is past its own shutdown bound. Kill, then require the kill
      // to be OBSERVED — a `kill()` that returns true only means the signal was
      // delivered.
      const signalled = this.killChild();
      const afterKill = await this.awaitClose(this.deadlines.closeAfterExitMs);
      if (!afterKill) {
        // Deliberately not an unbounded wait. The child reference is retained
        // so a caller can retry teardown; ownership is not dropped just because
        // this attempt was inconclusive.
        this.failPendingWith(
          new NativeHelperError("cleanup-uncertain", true, undefined, this.exitCode, "helper did not close after kill"),
        );
        throw new NativeHelperError(
          "cleanup-uncertain",
          true,
          undefined,
          this.exitCode,
          signalled ? "kill signalled but the process did not close" : "kill could not be delivered",
        );
      }
    }

    this.failPendingWith(new NativeHelperError("cancelled", false, undefined, this.exitCode));

    const code = this.exitCode;

    // ## The reply is evidence only if it is well formed
    //
    // The previous version read `removedFiles` and `residue` out of whatever
    // arrived, defaulting a missing count to 0 and then returning cleanly on
    // exit 0 REGARDLESS of what the reply said. Two ways to be wrong: an
    // `ok:false`, negative or absent count was accepted as a cleanup report,
    // and an explicit `residue:true` was discarded whenever the process
    // happened to exit 0.
    // Read into a local annotated with the full union: the field is mutated by
    // recordCancelReply during the awaits above, which narrowing from the reset
    // at the top of this function would otherwise hide.
    const verdict: CancelVerdict = this.cancelReply;
    if (verdict === "malformed") {
      throw new NativeHelperError(
        "cleanup-uncertain", this.stagingMayExist, undefined, code,
        "the cancel reply was not the documented shape, so cleanup is unconfirmed",
      );
    }
    // Honoured whatever the exit code says. The helper reporting bytes left
    // behind is the most direct evidence there is.
    if (verdict === "residue") {
      throw new NativeHelperError("residue", true, undefined, code, "cleanup reported bytes left on disk");
    }

    if (code === 3) {
      throw new NativeHelperError("residue", true, undefined, code, "cleanup incomplete: bytes remain on disk");
    }
    if (code === 5) {
      throw new NativeHelperError("residue", true, undefined, code, "shutdown grace exceeded: bounded residue remains");
    }
    if (code === 0) {
      // Clean, and safe to say so: the helper upgrades a clean exit to 3 when
      // cleanup left anything, so exit 0 cannot hide residue.
      if (this.lastCancel === null) this.lastCancel = { removedFiles: 0, residue: false, exitCode: code };
      return;
    }
    // Any other non-zero exit carries no residue information of its own — the
    // helper's finalCode only upgrades a CLEAN exit to 3 — so the validated
    // reply is used when there is one and uncertainty is assumed when there is
    // not. Root dispositioned this: conservative here, no native change.
    // The validated report when there is one; otherwise whether staging could
    // exist at all. A non-zero code from this client's own kill of a helper
    // that never opened a lease is not evidence of anything left behind.
    throw new NativeHelperError(
      "cleanup-uncertain",
      this.lastCancel?.residue ?? this.stagingMayExist,
      undefined,
      code,
      `helper exited ${String(code)}`,
    );
  }

  /**
   * Validate and record a cancel reply.
   *
   * Every field is checked: an `ok:false`, a non-record result, a missing or
   * negative `removedFiles`, or a non-boolean `residue` all make the reply
   * malformed — which is treated as unconfirmed cleanup, never as clean.
   */
  private resetCancelVerdict(): void {
    this.cancelReply = "none";
  }

  private recordCancelReply(response: HelperResponse): void {
    const result = response.result;
    if (!response.ok || !isRecord(result)) {
      this.cancelReply = "malformed";
      return;
    }
    const removed = asInteger(result["removedFiles"]);
    const residue = result["residue"];
    if (removed === null || removed < 0 || typeof residue !== "boolean") {
      this.cancelReply = "malformed";
      return;
    }
    this.lastCancel = { removedFiles: removed, residue, exitCode: this.exitCode };
    this.cancelReply = residue ? "residue" : "clean";
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private attach(child: HelperChild): void {
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      this.onStdout(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      this.onStderr(chunk);
    });
    child.onError((error) => {
      // RECORDED ONLY.
      //
      // `error` does not always mean the spawn failed — it is also emitted when
      // a signal could not be delivered or a message could not be sent, and the
      // child may still be running. The previous version synthesised `exit` and
      // `close` here, which reported a live process as gone and abandoned its
      // staging directory.
      //
      // Nothing is synthesised now. A genuine spawn failure emits a real
      // `close` right after this, and if it does not, the startup and request
      // deadlines bound the wait.
      this.spawnError = error;
    });
    child.onExit((code) => {
      this.onExit(code, null);
    });
    child.onClose(() => {
      this.onClose();
    });
  }

  /**
   * `exit` records the code and nothing else.
   *
   * Node emits `exit` when the process ends, but stdout may still hold a
   * buffered frame, and the last thing a helper does is often the reply the
   * caller is waiting for. Failing the pending request here would discard a
   * valid receipt that was already on its way. `close` is the event that means
   * "no more data", so settlement waits for it.
   */
  private onExit(code: number | null, _signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const cancelling = this.state === "cancelling" || this.state === "closing";
    this.state = "closed";
    const waiters = this.closeWaiters.splice(0, this.closeWaiters.length);
    for (const waiter of waiters) waiter();
    // Anything still outstanding can never be answered now.
    //
    // A request outstanding while a cancel is in progress is `cancelled`, not a
    // transport failure: the caller asked for teardown and the helper refusing
    // or dropping the queued operation is the correct outcome, not a fault to
    // report as one.
    this.failPendingWith(
      this.spawnError !== null
        ? new NativeHelperError("helper-unavailable", false, undefined, this.exitCode, this.spawnError.message)
        : this.cancellation !== null || cancelling
          ? new NativeHelperError("cancelled", false, undefined, this.exitCode)
          : new NativeHelperError("io-failed", this.exitCode !== 0, undefined, this.exitCode, "helper closed without replying"),
    );
  }

  private awaitClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // REMOVED on timeout. A child that never closes used to leave its
        // waiter in this list forever, and now that a failed teardown is
        // retryable, every retry added another one — unbounded retention keyed
        // to exactly the situation that makes retries happen.
        const at = this.closeWaiters.indexOf(waiter);
        if (at >= 0) this.closeWaiters.splice(at, 1);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.closeWaiters.push(waiter);
    });
  }

  /**
   * How many close watchers are outstanding. Diagnostic only — it exists so the
   * no-stale-waiter invariant can be asserted rather than assumed.
   */
  get pendingCloseWatchers(): number {
    return this.closeWaiters.length;
  }

  private killChild(): boolean {
    try {
      return this.child?.kill("SIGKILL") ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Kill the child and wait for the close to be OBSERVED.
   *
   * Returns whether it was. `kill()` returning true only says the signal was
   * delivered, so its return value is not evidence the process is gone.
   */
  private async joinAfterKill(): Promise<boolean> {
    if (this.closed) return true;
    this.killChild();
    return this.awaitClose(this.deadlines.closeAfterExitMs);
  }

  /**
   * The single terminal-failure path: stop the session, kill, JOIN, and only
   * then settle the caller.
   *
   * ## Why the join has to come first
   *
   * Every terminal path used to fire `void this.awaitClose(...)` and reject
   * immediately, so a caller was told the operation had failed while the child
   * was still running and its staging directory still on disk. Root's probe
   * caught exactly that: the request timeout settled before the close was
   * observed or the bounded join had elapsed. A caller that then dropped the
   * lease had nothing left to tear down with.
   *
   * So the cause is captured, the pending slots are cleared synchronously (so
   * nothing new can attach to them), and the rejection is delivered only after
   * the join settles. If the close could NOT be observed, the error carries
   * `residue: true` — bytes may remain and nobody can say otherwise.
   */
  private terminalFailure(cause: NativeHelperError): void {
    // Idempotent. More malformed data can arrive while the join is in flight,
    // and re-entering would start a second kill and a second join for a session
    // already being torn down.
    if (this.terminating) return;
    this.terminating = true;

    this.state = "closed";
    const ordinary = this.pending;
    const cancelWaiter = this.cancelPending;
    this.pending = null;
    this.cancelPending = null;
    if (ordinary !== null) this.clear(ordinary);
    if (cancelWaiter !== null) this.clear(cancelWaiter);

    void (async () => {
      const observed = await this.joinAfterKill();
      // ## An observed close proves the process EXITED, not that it cleaned up
      //
      // This is the correction root caught. Every terminal path built its cause
      // with `residue: false` and only upgraded it when the close could not be
      // observed — so a forced kill whose close WAS observed reported a clean
      // teardown. It is the opposite: this path always kills, the shipped build
      // has `OnCloseDeletionEnabled = false`, and a hard kill therefore leaves
      // the documented bounded staging residue. Watching the process go tells
      // us nothing about what it left behind.
      //
      // So residue follows what could exist on disk: false only before the
      // `open` frame was ever written, or when a validated CLEAN cleanup report
      // was actually received. Otherwise true.
      const left = this.residueAfterForcedKill();
      const detail = observed ? cause.message : `${cause.message} (process did not close)`;
      const settled = new NativeHelperError(
        cause.code, left, cause.helperCode, this.exitCode, detail, cause.publishReport,
      );
      ordinary?.fail(settled);
      cancelWaiter?.fail(settled);
    })();
  }

  /**
   * Whether a forced kill may have left bytes on the user's disk.
   *
   * The only two ways to answer "no": the helper was never asked to open a
   * lease, so it created no staging directory; or it returned a validated clean
   * cleanup report before being killed. Anything else is a yes, because nothing
   * observable distinguishes it from a yes.
   */
  private residueAfterForcedKill(): boolean {
    if (!this.stagingMayExist) return false;
    if (this.cancelReply === "clean") return false;
    return true;
  }

  /**
   * Mark the session unusable for FUTURE operations while leaving teardown
   * possible.
   *
   * An accounting mismatch means the staged file's length is not something
   * either side can vouch for. The previous version threw and left the state
   * `ready`, so a caller could go on to `begin` the next file or `publish` the
   * batch — publishing a file this client had already refused to believe in.
   * The helper is still alive, so this deliberately does NOT kill: its cleanup
   * still has to be asked for.
   */
  private terminalize(error: NativeHelperError): NativeHelperError {
    if (this.state === "ready" || this.state === "starting") this.state = "failed";
    return error;
  }

  private onStderr(chunk: Uint8Array): void {
    const text = textDecoder.decode(chunk);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      // Reduced to a code from the closed set, or counted and discarded. No
      // substring of the line survives either way.
      let matched: string | null = null;
      for (const token of line.split(/\s+/)) {
        if (KNOWN_HELPER_CODES.has(token)) {
          matched = token;
          break;
        }
      }
      if (matched === null) {
        this.withheldLines += 1;
        continue;
      }
      const seen = this.codeCounts.get(matched);
      if (seen === undefined && this.codeCounts.size >= MAX_TRACKED_CODES) {
        this.withheldLines += 1;
        continue;
      }
      this.codeCounts.set(matched, (seen ?? 0) + 1);
    }
  }

  /**
   * Accumulate and drain.
   *
   * Coalescing is normal on a pipe: one read can carry three frames, or half of
   * one. So every complete frame in the buffer is parsed, in order, and only
   * the incomplete remainder is carried forward. Two frames in one read is not
   * an error, and treating it as one would break the protocol against a
   * perfectly correct helper.
   *
   * The length field is validated BEFORE anything is allocated or sliced.
   */
  private onStdout(chunk: Uint8Array): void {
    // Nothing arriving after a terminal decision can change it, and parsing on
    // would only re-enter terminalFailure.
    if (this.closed || this.terminating || this.state === "closed") return;
    if (chunk.byteLength === 0) return;
    // Held by reference, not copied. Chunks are drained in this same call, so
    // an oversized one is inspected and rejected without ever being duplicated.
    this.queue.push(chunk);
    this.queued += chunk.byteLength;

    for (;;) {
      if (this.queued < FRAME_HEADER_BYTES) break;
      const header = this.copyFront(FRAME_HEADER_BYTES);
      const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
      // Validated BEFORE the payload is materialised.
      if (length < 1 || length > MAX_INBOUND_LENGTH_FIELD) {
        this.protocolFailure(`inbound frame length ${length} outside 1..${MAX_INBOUND_LENGTH_FIELD}`);
        return;
      }
      const total = 4 + length;
      if (this.queued < total) break;
      // Exactly one copy, of exactly this frame.
      const frameBytes = this.takeFront(total);
      const kind = frameBytes[4];
      if (kind === undefined) {
        this.protocolFailure("inbound frame without a kind");
        return;
      }
      if (!this.onFrame({ kind, payload: frameBytes.subarray(FRAME_HEADER_BYTES) })) return;
    }

    // Only an incomplete remainder may be carried between reads, and it is
    // compacted into one small buffer so the queue cannot accumulate slices.
    if (this.queued > 4 + MAX_INBOUND_LENGTH_FIELD) {
      this.protocolFailure("unparsed inbound bytes exceed one frame");
      return;
    }
    if (this.queue.length > 1) {
      const compacted = this.copyFront(this.queued);
      this.queue = [compacted];
    }
  }

  /** Copy the first n queued bytes without consuming them. */
  private copyFront(n: number): Uint8Array {
    const first = this.queue[0];
    if (first !== undefined && first.byteLength >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let filled = 0;
    for (const part of this.queue) {
      if (filled >= n) break;
      const take = Math.min(part.byteLength, n - filled);
      out.set(part.subarray(0, take), filled);
      filled += take;
    }
    return out;
  }

  /** Copy and consume the first n queued bytes. */
  private takeFront(n: number): Uint8Array {
    const out = this.copyFront(n);
    let remaining = n;
    while (remaining > 0) {
      const part = this.queue[0];
      if (part === undefined) break;
      if (part.byteLength <= remaining) {
        remaining -= part.byteLength;
        this.queue.shift();
      } else {
        this.queue[0] = part.subarray(remaining);
        remaining = 0;
      }
    }
    this.queued -= n;
    return out.byteLength === n ? out.slice() : out;
  }

  /** Returns false when the session has been terminated. */
  private onFrame(frame: InboundFrame): boolean {
    if (frame.kind === KIND_REQUEST || frame.kind === KIND_CHUNK) {
      // Helper-to-host only. Receiving one means the peer is not the helper
      // this protocol describes. The helper applies the mirror-image rule.
      this.protocolFailure(`inbound frame kind ${frame.kind} is host-to-helper only`);
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(frame.payload)) as unknown;
    } catch {
      this.protocolFailure("inbound frame payload is not JSON");
      return false;
    }
    if (!isRecord(parsed)) {
      this.protocolFailure("inbound frame payload is not an object");
      return false;
    }

    if (frame.kind === KIND_EVENT) {
      const name = parsed["event"];
      if (name !== "ready") {
        this.protocolFailure("unknown event");
        return false;
      }
      const protocol = asInteger(parsed["protocol"]);
      if (protocol !== PROTOCOL_VERSION) {
        this.protocolFailure(`protocol version ${String(protocol)}, expected ${PROTOCOL_VERSION}`);
        return false;
      }
      if (this.state === "starting") this.state = "ready";
      const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
      for (const waiter of waiters) waiter();
      return true;
    }

    if (frame.kind !== KIND_RESPONSE) {
      this.protocolFailure(`unknown frame kind ${frame.kind}`);
      return false;
    }

    const id = asInteger(parsed["id"]);
    const ok = parsed["ok"];
    if (id === null || typeof ok !== "boolean") {
      this.protocolFailure("response is not the documented shape");
      return false;
    }
    const code = parsed["code"];
    const detail = parsed["detail"];
    const response: HelperResponse = {
      id,
      ok,
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof detail === "string" ? { detail } : {}),
      ...(parsed["result"] !== undefined ? { result: parsed["result"] } : {}),
    };

    // Correlation. A cancel reply may legitimately arrive while an ordinary
    // request is still outstanding, and an ordinary reply may arrive after a
    // cancel was sent — neither is an unknown id.
    if (this.cancelPending !== null && this.cancelPending.id === id) {
      const target = this.cancelPending;
      this.cancelPending = null;
      this.clear(target);
      target.settle(response);
      return true;
    }
    if (this.pending !== null && this.pending.id === id) {
      const target = this.pending;
      this.pending = null;
      this.clear(target);
      target.settle(response);
      return true;
    }
    // Genuinely uncorrelated: the streams have desynchronised.
    this.protocolFailure("response correlates to no outstanding request");
    return false;
  }

  private readonly readyWaiters: Array<() => void> = [];

  private awaitReady(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Killed and JOINED before the caller is told, same rule as every other
        // terminal path.
        const atClose = this.closeWaiters.indexOf(finish);
        if (atClose >= 0) this.closeWaiters.splice(atClose, 1);
        void this.joinAfterKill().then(() => {
          reject(
            new NativeHelperError(
              "helper-unavailable", this.residueAfterForcedKill(), undefined, this.exitCode,
              this.spawnError?.message ?? "helper did not announce itself",
            ),
          );
        });
      }, this.deadlines.startupMs);
      timer.unref?.();
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Removed from BOTH lists. Leaving the close watcher in place made
        // every successful open retain one dead entry for the life of the
        // client — benign on its own, and exactly the retention the
        // no-stale-waiter invariant is supposed to exclude.
        const atClose = this.closeWaiters.indexOf(finish);
        if (atClose >= 0) this.closeWaiters.splice(atClose, 1);
        const atReady = this.readyWaiters.indexOf(finish);
        if (atReady >= 0) this.readyWaiters.splice(atReady, 1);
        if (this.state === "ready") {
          resolve();
        } else {
          reject(
            new NativeHelperError(
              this.spawnError !== null ? "helper-unavailable" : "protocol",
              false,
              undefined,
              this.exitCode,
              this.spawnError?.message ?? "helper closed before announcing itself",
            ),
          );
        }
      };
      this.readyWaiters.push(finish);
      this.closeWaiters.push(finish);
    });
  }

  private protocolFailure(reason: string): void {
    this.terminalFailure(new NativeHelperError("protocol", false, undefined, this.exitCode, reason));
  }

  private failPendingWith(error: NativeHelperError): void {
    const ordinary = this.pending;
    this.pending = null;
    if (ordinary !== null) {
      this.clear(ordinary);
      ordinary.fail(error);
    }
    const cancelWaiter = this.cancelPending;
    this.cancelPending = null;
    if (cancelWaiter !== null) {
      this.clear(cancelWaiter);
      cancelWaiter.fail(error);
    }
  }

  private clear(pending: Pending): void {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private encodeRequest(id: number, op: string, extra: Record<string, unknown>): Uint8Array | null {
    const payload = textEncoder.encode(JSON.stringify({ id, op, ...extra }));
    const limit = op === "open" ? MAX_OPEN_REQUEST_BYTES : MAX_REQUEST_BYTES;
    if (payload.byteLength > limit) return null;
    return encodeFrame(KIND_REQUEST, payload);
  }

  private writeFrame(frame: Uint8Array): void {
    try {
      this.child?.stdin?.write(frame);
    } catch {
      // stdin is gone; the close path is what settles callers.
    }
  }

  private endStdin(): void {
    try {
      this.child?.stdin?.end();
    } catch {
      // Nothing to do: teardown is driven by the process exit.
    }
  }

  private async request(
    op: string,
    extra: Record<string, unknown>,
    timeoutMs: number,
    limit: number,
  ): Promise<unknown> {
    const response = await this.requestRaw(op, extra, timeoutMs, limit);
    if (!response.ok) {
      throw new NativeHelperError(
        response.code === "E_CANCELLED" ? "cancelled" : "io-failed",
        false,
        response.code,
        this.exitCode,
        response.code ?? "helper refused the request",
      );
    }
    return response.result;
  }

  private requestRaw(
    op: string,
    extra: Record<string, unknown>,
    timeoutMs: number,
    limit: number,
  ): Promise<HelperResponse> {
    if (this.state === "closed" || this.closed) {
      return Promise.reject(new NativeHelperError("io-failed", false, undefined, this.exitCode, "the lease is closed"));
    }
    if (this.state === "cancelling" || this.state === "closing") {
      return Promise.reject(new NativeHelperError("cancelled", false, undefined, this.exitCode));
    }
    if (this.state === "failed") {
      // An earlier accounting mismatch left a staged file this client cannot
      // vouch for. No further IO, and in particular no publish.
      return Promise.reject(new NativeHelperError("io-failed", false, undefined, this.exitCode, "the lease failed an accounting check"));
    }
    if (this.state !== "ready") {
      return Promise.reject(new NativeHelperError("protocol", false, undefined, this.exitCode, "helper has not announced itself"));
    }
    // Strict one in flight, for ORDINARY operations only. Two overlapping
    // writes on one file have no correct order, and the helper's inbox is
    // bounded and terminates the session on overflow, so pipelining would risk
    // a protocol kill rather than merely being untidy.
    if (this.pending !== null) {
      return Promise.reject(new NativeHelperError("busy"));
    }

    const id = this.nextId++;
    const frame = this.encodeRequest(id, op, extra);
    if (frame === null) {
      return Promise.reject(new NativeHelperError("length-exceeded", false, undefined, null, `${op} request exceeds ${limit} bytes`));
    }
    return this.dispatch(id, frame, timeoutMs);
  }

  private sendChunk(index: number, data: Uint8Array): Promise<unknown> {
    if (this.state === "closed" || this.closed) {
      return Promise.reject(new NativeHelperError("io-failed", false, undefined, this.exitCode, "the lease is closed"));
    }
    if (this.state === "cancelling" || this.state === "closing") {
      return Promise.reject(new NativeHelperError("cancelled", false, undefined, this.exitCode));
    }
    if (this.state === "failed") {
      // An earlier accounting mismatch left a staged file this client cannot
      // vouch for. No further IO, and in particular no publish.
      return Promise.reject(new NativeHelperError("io-failed", false, undefined, this.exitCode, "the lease failed an accounting check"));
    }
    if (this.state !== "ready") {
      return Promise.reject(new NativeHelperError("protocol", false, undefined, this.exitCode, "helper has not announced itself"));
    }
    if (this.pending !== null) {
      return Promise.reject(new NativeHelperError("busy"));
    }
    const id = this.nextId++;
    const frame = encodeFrame(KIND_CHUNK, encodeChunkPayload(id, index, data));
    return this.dispatch(id, frame, this.deadlines.requestMs).then((response) => {
      if (!response.ok) {
        throw new NativeHelperError(
          response.code === "E_CANCELLED" ? "cancelled" : "io-failed",
          false,
          response.code,
          this.exitCode,
          response.code ?? "helper refused the chunk",
        );
      }
      return response.result;
    });
  }

  private dispatch(id: number, frame: Uint8Array, timeoutMs: number): Promise<HelperResponse> {
    return new Promise<HelperResponse>((resolve, reject) => {
      const pending: Pending = { id, settle: resolve, fail: reject, timer: null };
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        // Killed and JOINED before the caller is told. `reject` is not called
        // here: terminalFailure owns the pending slot and settles it after the
        // join, so "the request failed" is never reported while the child is
        // still running.
        this.terminalFailure(
          new NativeHelperError("helper-timeout", false, undefined, this.exitCode, "helper did not reply"),
        );
      }, timeoutMs);
      pending.timer.unref?.();
      this.pending = pending;
      this.writeFrame(frame);
    });
  }
}
