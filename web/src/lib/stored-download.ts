// Turning one stored object's ciphertext into files on disk.
//
// Extracted from DownloadPage so the pre-upload receiver (a pairing-code peer
// that was handed object ids and keys over the end-to-end channel) writes files
// through the SAME code, not a second copy of it. Everything here was learned
// from real failures on the download page — the folder hierarchy that lives in
// `name`, the zero-byte entries the plaintext stream never drives, the sink that
// fails to open before a single byte is wrong — and a re-implementation would
// have started by not knowing any of it.
//
// Deliberately free of UI: it takes a target and reports progress. Error
// CLASSIFICATION stays with each caller, because what a failure means to a user
// differs between "the link you opened" and "the device you paired with".

import { downloadBlob, throwIfAborted } from "./stored-file";
import { SinkTransportError, type FileSink, type FileMetaLite, type SaveTarget } from "./filesink";
import { safeSegments } from "./zip";
import type { StoredManifest } from "./store-crypto";

/**
 * The manifest's entries as the save layer wants them.
 *
 * The stored manifest has no `path` field (it is frozen, with gold-standard
 * ciphertext vectors pinning it), so a folder's hierarchy is written into
 * `name` as "trip/day1/a.txt" — that is what the Go CLI's walkUploadPaths and
 * the native macOS client both send. Split here into filesink's
 * {name(leaf), path(relative)}: handing the whole string down as a filename
 * happens to work for a desktop directory handle (it runs safeSegments itself)
 * but leaves `path` undefined on the Firefox/Safari/mobile route, which then
 * cannot tell this is a folder and downloads loose blobs — the tree is lost at
 * the very last step. Split, the batch goes to ZIP and the tree survives.
 */
export function storedSaveSpecs(manifest: StoredManifest): FileMetaLite[] {
  return manifest.files.map((f) => {
    const segs = safeSegments(f.name);
    return {
      name: segs[segs.length - 1] ?? f.name,
      size: f.size,
      path: segs.length > 1 ? segs.join("/") : undefined,
    };
  });
}

/** Total plaintext bytes the manifest describes. */
export function storedTotalBytes(manifest: StoredManifest): number {
  return manifest.files.reduce((n, f) => n + f.size, 0);
}

/**
 * Open one file's write end.
 *
 * Failures here (blob sink construction, the ZIP writer, a directory handle) are
 * normalised to SinkTransportError: not one byte was wrong, there is just
 * nowhere to put it. Callers classify that as a retryable save problem rather
 * than "wrong key or corrupted file".
 *
 * **A sink open when this function throws is deliberately ABANDONED, not
 * closed.** `FileSink` has `write` and `close` and nothing else — there is no
 * `abort` — and `close()` is the COMMIT on every target: the native writable
 * publishes the partial file, `blobSink` triggers a browser download of the
 * bytes it happens to hold, the ZIP branch adds the truncated entry to the
 * archive. Closing on the way out of a failure would therefore hand the user a
 * silently truncated file, which is worse than the thing it looks like it is
 * cleaning up. Dropping the reference is what "abort" means for all four:
 * nothing is committed, nothing is downloaded, nothing is added, and the
 * garbage collector takes the buffers. (The one target with real teardown state
 * is the service-worker stream, and it is unreachable from here — `swStream` is
 * off for every receive path, see SaveOptions.)
 */
async function openSink(target: SaveTarget, specs: FileMetaLite[], i: number): Promise<FileSink> {
  try {
    const spec = specs[i];
    return await target.file(spec.name, spec.size, spec.path);
  } catch (e) {
    throw new SinkTransportError(`could not open a save sink: ${(e as Error)?.message ?? "unknown"}`);
  }
}

/**
 * Stream one stored object into `target`, splitting the plaintext by the
 * manifest's file sizes.
 *
 * `onProgress` receives cumulative plaintext bytes. `target.done()` is called
 * exactly once, after every entry has been closed — the ZIP branch needs it to
 * assemble and trigger the download at all, and its contract is "every file is
 * closed", so it must not run earlier.
 *
 * `signal` stops it, and it is checked after every await rather than only at the
 * top of a round: the awaits here are the sink's own — write, close, open — and
 * a cancellation that lands while one is pending resumes past every check that
 * came before it. The line it draws is "nothing NEW is started once the run is
 * cancelled": no file is committed, no entry created, no batch finished. A close
 * that was already under way finishes, because its bytes were all written while
 * the run was live and `close()` is how they reach the disk.
 *
 * Every abandonment point below is a sink left OPEN and dropped, never closed —
 * see openSink: `close()` is the commit on all four targets, so "tidying up" on
 * the way out is exactly what would hand the user the truncated file. Cancelling
 * therefore leaves at most one uncommitted entry: the one being written, or (if
 * the signal fired while its open was in flight) the empty one after it.
 */
export async function writeStoredObject(
  opts: {
    id: string;
    key: CryptoKey;
    manifest: StoredManifest;
    target: SaveTarget;
    specs?: FileMetaLite[];
    onProgress?: (received: number) => void;
    /**
     * One of this object's files has been CLOSED — that is, handed to the target
     * as complete.
     *
     * Not the same event as `onProgress`, and the difference is the whole point:
     * progress is bytes read, which says nothing about whether they reached a
     * disk. A caller that has to report what a failed batch actually saved needs
     * the count of files the target took delivery of, and only this call knows
     * it. (Whether the target then made them visible to the user is a second
     * question — see SaveTarget.bundled.)
     */
    onFileClosed?: () => void;
    /** Whether this call owns the end of the batch. False when several stored
     *  objects share ONE target (the pre-upload receiver's case): `done()` means
     *  "every file is closed", and the ZIP branch assembles the whole archive
     *  from it, so calling it after each object would emit a partial archive and
     *  then write into a finished one. */
    finalize?: boolean;
    /** Cancel this run. See the note above on what a cancelled run leaves
     *  behind, and `downloadBlob` for why a caller cannot stop one from the
     *  outside once the response body has started streaming. */
    signal?: AbortSignal;
  },
): Promise<void> {
  const { id, key, manifest, target, onProgress, signal } = opts;
  const specs = opts.specs ?? storedSaveSpecs(manifest);
  let fileIdx = 0;
  let intoFile = 0;
  // Before the first sink, because opening one is already a visible act on a
  // directory target — it creates the entry — and a run that was cancelled
  // before it began must leave nothing at all.
  throwIfAborted(signal);
  // Opened INSIDE the caller's try: a construction failure here used to escape
  // the whole function, leaving the page on a progress bar forever with nothing
  // said. openSink normalises it to a save fault the caller can classify.
  let sink: FileSink | null = manifest.files.length ? await openSink(target, specs, 0) : null;
  await downloadBlob(
    id,
    key,
    async (pt: Uint8Array) => {
      let off = 0;
      while (off < pt.length && fileIdx < manifest.files.length) {
        // Top of every round, so it precedes all three things this loop does
        // that a cancelled run must not: write bytes into a sink, CLOSE one —
        // the commit, the moment a file becomes the user's — and open the next.
        // downloadBlob checks between plaintext deliveries; this is what covers
        // the several files a single delivery can span.
        //
        // It is NOT the only check, and it cannot be: every line below it is an
        // await, and a cancellation that fires while one of them is pending
        // resumes PAST this point — inside a round that already passed it —
        // with the close and the open still ahead of it. So the boundary is
        // redrawn after each of those awaits too, and what it means is "nothing
        // new is started once the run is cancelled": no file becomes the user's,
        // no entry is created, no batch is finished.
        throwIfAborted(signal);
        const remaining = manifest.files[fileIdx].size - intoFile;
        const take = Math.min(remaining, pt.length - off);
        if (take > 0 && sink) {
          await sink.write(pt.subarray(off, off + take));
          intoFile += take;
          off += take;
          // A write that resolves after the cancellation must not go on to
          // CLOSE this sink — the commit — or open the next entry. The bytes it
          // wrote are uncommitted and stay that way: the sink is abandoned,
          // which is what "abort" means for all four targets (see openSink).
          throwIfAborted(signal);
        }
        if (intoFile >= manifest.files[fileIdx].size) {
          if (sink) {
            await sink.close();
            // Reported before the check below, deliberately. This close was
            // initiated while the run was live and it COMPLETED: the file is on
            // the user's disk whatever happened meanwhile, and a caller counting
            // what a stopped batch actually saved has to be told so.
            opts.onFileClosed?.();
            // But nothing new. A close that resolves after the cancellation
            // ends the run here rather than creating the next entry for a room
            // that is over.
            throwIfAborted(signal);
          }
          fileIdx++;
          intoFile = 0;
          sink = fileIdx < manifest.files.length ? await openSink(target, specs, fileIdx) : null;
          // And an open that resolved after the cancellation stops here rather
          // than at whichever later check happens to come first. The sink is
          // abandoned unclosed, so nothing it holds is ever committed.
          throwIfAborted(signal);
        }
      }
    },
    onProgress,
    // The caller already has the manifest, so hand downloadBlob the expected
    // plaintext total instead of letting it fetch and decrypt /meta a SECOND
    // time to derive the same number. Byte-identical to what it would compute
    // (expectedPlaintextBytes sums exactly these sizes), one fewer request per
    // object, and one fewer place the transfer can fail after it has started.
    storedTotalBytes(manifest),
    signal,
  );
  // Finish the manifest entries the plaintext stream never reached.
  //
  // The callback above only advances fileIdx WHILE IT HOLDS BYTES — its loop
  // condition is `off < pt.length`. A zero-byte file with no later bytes to
  // drive the loop is therefore never opened, because the ciphertext stream
  // carries no frame for it. Two real shapes: a manifest that is entirely
  // zero-byte files (downloadBlob never calls back at all, so only the sink
  // pre-opened above exists), and a non-empty file followed by two or more
  // zero-byte ones (the last bytes close entry 0 and open entry 1, then the loop
  // exits and nothing opens entry 2). Without this, target.done() still runs and
  // the caller still reports success — the user gets a folder missing files and
  // is told everything is fine.
  //
  // Only the REMAINDER is finished here: the callback still closes the sinks it
  // filled, and this closes the one it left open plus every never-opened tail
  // entry. Each round nulls the sink immediately and the next `??=` opens a new
  // one, so a closed sink is never closed twice; each round advances fileIdx, so
  // the loop terminates.
  while (fileIdx < manifest.files.length) {
    // Zero-byte entries are still entries: a cancelled run must not go on
    // creating and committing empty files after it was told to stop.
    throwIfAborted(signal);
    sink ??= await openSink(target, specs, fileIdx);
    // Post-await, and load-bearing rather than symmetrical: the very next thing
    // this loop does is close() — the commit — so an open that resolved after
    // the cancellation would put an empty file in front of the user for a room
    // they have already left. Abandoned instead, exactly like every other sink
    // a cancelled run leaves behind.
    throwIfAborted(signal);
    // Anything unfilled here can only be zero-byte: downloadBlob was handed the
    // manifest's own plaintext total above and checks it with
    // StoreDecryptor.end(expected) before resolving. A mismatch is a genuine
    // byte-count disagreement with what the manifest describes, and must never
    // be papered over with an empty file standing in for it.
    if (manifest.files[fileIdx].size !== intoFile) {
      throw new Error(
        `manifest entry ${fileIdx} expected ${manifest.files[fileIdx].size} bytes, got ${intoFile}`,
      );
    }
    await sink.close();
    opts.onFileClosed?.();
    sink = null;
    fileIdx++;
    intoFile = 0;
  }
  // Last of all, and guarded like everything else: `done()` is what publishes
  // the ZIP / triggers the browser download, so running it for a cancelled
  // transfer hands the user the very archive the cancellation was meant to
  // prevent. (The pre-upload receiver passes `finalize: false` and owns this
  // call itself — it guards its own.)
  throwIfAborted(signal);
  if (opts.finalize !== false) await target.done?.();
}
