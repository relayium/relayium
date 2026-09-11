// A `File`-compatible view of a staged file this page never has the bytes of.
//
// The production encryptors take `File` objects and use exactly four things:
//
//   * `file.size`                                   (`transfer.ts:377`, `store-crypto.ts:180`)
//   * `file.slice(start, end).arrayBuffer()`        (`transfer.ts:369`, `store-crypto.ts:181`)
//   * `file.name`                                   (`picked-files.ts`)
//   * `file.webkitRelativePath`                     (folder sends)
//
// So that is what this provides, and it fetches each slice from MAIN over the
// capability token rather than holding any content. Nothing is materialised:
// the whole file is never in this process, and a slice is exactly one bounded
// read.
//
// ## Why an adapter rather than a real File
//
// Constructing a real `File` needs the bytes. The point of an OS entry is that
// the bytes stay in main until the encryptor asks for a chunk, so a real `File`
// would defeat it — a 4 GB selection would be a 4 GB allocation before a single
// frame was sealed.
//
// ## The slice contract, exactly
//
// `transfer.ts` warns that a negative offset slices from the END of a file.
// This adapter does NOT reproduce that: a negative or reversed range is refused,
// because the only caller here walks forward from zero and a silently
// end-relative read would seal the wrong bytes under the right nonce.

import {
  MAX_SELECTION_CHUNK,
  type SelectionEntryView,
  type SelectionReadResult,
} from "../../shared/os-entry.js";

/** What the adapter needs to fetch a range. Declared, not inferred. */
export interface SelectionReadBridge {
  read(payload: { token: string; offset: number; length: number }): Promise<SelectionReadResult>;
}

/** Thrown when main will not, or cannot, serve a range. */
export class SelectionReadError extends Error {
  constructor(readonly reason: SelectionReadResult["kind"]) {
    // No path, no name and no content: this string reaches a log.
    super(`selection read: ${reason}`);
    this.name = "SelectionReadError";
  }
}

/** The slice object the encryptors call `.arrayBuffer()` on. */
class SelectionSlice {
  constructor(
    private readonly bridge: SelectionReadBridge,
    private readonly token: string,
    private readonly start: number,
    private readonly end: number,
  ) {}

  get size(): number {
    return this.end - this.start;
  }

  /**
   * The bytes for this range, fetched in bounded reads.
   *
   * A slice is normally one chunk, because both encryptors ask in
   * `CHUNK_SIZE`/`STORE_CHUNK_SIZE` steps and that is this build's ceiling. The
   * loop exists so a larger slice is still correct rather than truncated.
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const total = this.size;
    const out = new Uint8Array(total);
    let filled = 0;
    while (filled < total) {
      const want = Math.min(MAX_SELECTION_CHUNK, total - filled);
      const result = await this.bridge.read({
        token: this.token,
        offset: this.start + filled,
        length: want,
      });
      if (result.kind !== "bytes") throw new SelectionReadError(result.kind);
      const bytes = result.bytes;
      if (bytes.length === 0) throw new SelectionReadError("failed");
      // A read may answer short only at the end of the file; the encryptor's
      // own loop bounds `end` by `size`, so a short answer mid-slice is a
      // failure rather than a signal to stop.
      if (bytes.length > total - filled) throw new SelectionReadError("failed");
      out.set(bytes, filled);
      filled += bytes.length;
    }
    return out.buffer;
  }
}

/**
 * One staged file, shaped like a `File`.
 *
 * Not a subclass of `File`: constructing one requires content, which is the
 * thing this exists to avoid. The encryptors are structurally typed against
 * what they use, and `asFile` states that cast in exactly one place.
 */
export class SelectionFile {
  readonly name: string;
  readonly size: number;
  readonly webkitRelativePath: string;
  /** Present because `File` has it; this build never reads it. */
  readonly type = "";
  readonly lastModified = 0;

  constructor(
    private readonly bridge: SelectionReadBridge,
    private readonly entry: SelectionEntryView,
  ) {
    this.name = entry.name;
    this.size = entry.size;
    // A single-file selection has no folder prefix, matching a plain multi-file
    // pick where `webkitRelativePath` is empty and the name is the whole path.
    this.webkitRelativePath = entry.relativePath === entry.name ? "" : entry.relativePath;
  }

  /**
   * A bounded, forward-only range.
   *
   * `end` defaults to the file's size, as `File.slice` does. Beyond it is
   * clamped rather than refused — the encryptor's final chunk is routinely past
   * the end — but a negative or reversed range is refused outright.
   */
  slice(start = 0, end = this.size): SelectionSlice {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SelectionReadError("bad-range");
    }
    if (start < 0 || end < 0) throw new SelectionReadError("bad-range");
    const from = Math.min(Math.floor(start), this.size);
    const to = Math.min(Math.floor(end), this.size);
    if (to < from) throw new SelectionReadError("bad-range");
    return new SelectionSlice(this.bridge, this.entry.token, from, to);
  }
}

/**
 * The one place the structural cast is made.
 *
 * `encryptFiles` and the transfer loop are typed against `File`. A
 * `SelectionFile` satisfies everything they actually touch — verified by
 * `selection-file.test.ts`, which runs the REAL `encryptFiles` over one and
 * checks the bytes that come out — and nothing they do not. Keeping the cast
 * here means a future use of some other `File` member is a change to this line
 * rather than a silent runtime `undefined`.
 */
export const asFile = (file: SelectionFile): File => file as unknown as File;
