// Receiving one stored link: metadata, manifest, ciphertext, publication.
//
// ## The order of operations is the design
//
//   1. Parse the link. An id and a key; the ORIGIN is the build's.
//   2. Read `/meta` and open the manifest under the fragment key. Until this
//      succeeds nothing about the object is known, and the manifest is the only
//      authenticated description of it there is.
//   3. Judge the manifest (`manifest.ts`). A manifest this build will refuse is
//      refused HERE — before the folder picker, before the helper, before a byte.
//   4. Only now ask the user where to put it, and open the native destination.
//   5. Stream `/blob`, decrypt, and write by INDEX into the destination.
//   6. Validate the end of the stream — exact plaintext total, no trailing
//      bytes — and only then publish.
//
// ## Publication is the last step and cannot be reached early
//
// `publish()` is the only operation whose success means "saved", and this module
// reaches it from exactly one place: after `decryptor.end(totalBytes)` has
// returned. That call is what distinguishes a stream truncated on a frame
// boundary from a clean end, so publishing on EOF alone — or on a full file
// count, or on the server's `size` field — would publish plaintext that was
// never fully authenticated. Every other exit from the stream cancels the
// destination instead.
//
// ## Nothing here is a plain filesystem write
//
// The destination is the accepted native helper (`io/native-helper-client.ts`),
// which creates, writes, finishes and publishes through handles it holds from
// creation to rename. This module never learns the staging path, never composes
// a destination path, and refers to files only by their index in the manifest it
// validated. There is no plain-stream fallback: a build without the helper
// reports `destination-unavailable` rather than writing files a different way
// with weaker guarantees than the ones the product claims.
//
// ## What a stored link cannot do here
//
// No account, no bearer, no cookie — see `transport.ts`. No `complete` call: an
// ordinary share never sends the pair-room completion capability. No access-code
// prompt: there is no such field in the protocol, and the fragment key is not a
// pairing code. No upload.

import {
  NativeHelperClient,
  NativeHelperError,
  type NativeManifestEntry,
  type NativePublishReport,
  type NativeReceiveDestination,
} from "../io/native-helper-client.js";
import { apiOrigin } from "../origin.js";
import { CleanupRegistry, storedCleanups, type CleanupReservation } from "./cleanup.js";
import { parseStoredLink } from "./link.js";
import { planStoredManifest, sealedManifestBytes, type StoredWritePlan } from "./manifest.js";
import { isRetryable, type StoredFailureCode, type StoredObjectFacts, type StoredReceiveReport } from "./report.js";
import type { RuntimeStoredManifest, StoredRuntime } from "./runtime-contract.js";
import { storedRuntime } from "./runtime.js";
import {
  StoredTransport,
  StoredTransportError,
  type StoredBlobBody,
  type StoredObjectMeta,
  type StoredObjectSource,
} from "./transport.js";

/**
 * The folder the user chose, and the identity of the transfer that may write
 * into it.
 *
 * `authorityId` is checked against the destination's own record before the first
 * write and again before publication. Belt and braces against this process's
 * bookkeeping: a handle driven under another transfer's identity is caught by
 * the destination rather than silently writing one transfer's bytes into
 * another's folder.
 */
export interface DestinationGrant {
  readonly rootPath: string;
  readonly authorityId: string;
}

/**
 * How the host is asked for a destination.
 *
 * A seam, not an abstraction for its own sake: the native folder picker lives
 * in the main process's window/dialog layer, which S1 does not own, and the
 * only correct default is therefore "the host supplies one". It is asked AFTER
 * the manifest is judged, so it receives a description worth showing the user
 * and is never opened for a transfer that is going to be refused.
 *
 * Returning null means the user declined. It is not an error and is never
 * reported as one.
 */
export interface DestinationAuthority {
  grant(object: StoredObjectFacts): Promise<DestinationGrant | null>;
}

export interface DestinationRequest {
  readonly authorityId: string;
  readonly rootPath: string;
  readonly manifest: readonly NativeManifestEntry[];
}

export type DestinationFactory = (request: DestinationRequest) => Promise<NativeReceiveDestination>;

/**
 * The production destination: the packaged IO helper at its fixed resolved path.
 *
 * `NativeHelperClient.open` with no `spawnHelper` defaults to
 * `spawnBundledHelper`, which resolves ONE executable from the process's own
 * layout — no argument, no environment variable, no runtime flag can redirect
 * it. Injecting a factory is a test seam and a future wiring seam; it is not a
 * way to choose a different program.
 */
export const nativeHelperDestination: DestinationFactory = (request) =>
  NativeHelperClient.open(request);

export interface StoredReceiveOptions {
  readonly link: string;
  readonly authority: DestinationAuthority;
  /** Defaults to a `StoredTransport` on this build's origin. */
  readonly transport?: StoredObjectSource;
  readonly destination?: DestinationFactory;
  readonly runtime?: () => Promise<StoredRuntime>;
  readonly signal?: AbortSignal;
  /** Cumulative decrypted plaintext bytes, against the manifest's total. */
  readonly onProgress?: (received: number, total: number) => void;
  /** Where a destination whose teardown failed is retained. */
  readonly cleanups?: CleanupRegistry;
  /** Overrides the accepted link hosts. Tests only. */
  readonly hosts?: readonly string[];
}

/** Cancellation, as an internal signal. Never reported as a fault. */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "StoredReceiveCancelled";
  }
}

/**
 * The ciphertext did not open, or did not describe what arrived.
 *
 * Deliberately message-free at the boundary: a decrypt failure's detail is
 * bytes, offsets and lengths of the user's data, and a caller needs to know
 * only that nothing can be trusted and nothing was saved.
 */
class IntegrityFailure extends Error {
  constructor(readonly detail: string) {
    super("integrity");
    this.name = "StoredIntegrityFailure";
  }
}

/**
 * Wait for `work`, but stop waiting if the caller cancels.
 *
 * Applied to the body read, which is the one unbounded wait in a receive. The
 * real transport aborts its own fetch when the signal fires, so its read
 * rejects — but this module must not DEPEND on the transport being well
 * behaved: a source whose read never settles would otherwise make a cancelled
 * transfer hang forever, holding a helper process and a staging directory. The
 * abandoned read is never looked at again; the body is closed on the way out,
 * which is what actually releases the connection.
 */
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const failed = (
  code: StoredFailureCode,
  residue = false,
  status: number | null = null,
  cleanupTicket: string | null = null,
  /** Defaults to the PROVEN case: everything below the publish step either
   *  never asked the helper to publish, or was refused before it could. Only
   *  `publishInto` widens this. */
  published: "none" | "unknown" = "none",
): StoredReceiveReport => ({
  status: "failed",
  failure: { code, status, refusal: null, residue, retryable: isRetryable(code), cleanupTicket, published },
});

/** A cancellation, with whatever teardown actually achieved. */
const cancelled = (teardown: Teardown = CLEAN): StoredReceiveReport => ({
  status: "cancelled",
  residue: teardown.residue,
  cleanupTicket: teardown.cleanupTicket,
});

/** HTTP and transport faults, mapped once. */
function fromTransport(error: StoredTransportError): StoredReceiveReport {
  switch (error.code) {
    case "http":
      // 404 is the one status that means something entirely different from the
      // rest: the link points at nothing any more. It says nothing about this
      // recipient's key or this object's integrity, which is what an
      // unclassified failure would imply.
      if (error.status === 404) return failed("not-found", false, 404);
      if (error.status === 403) return failed("forbidden", false, 403);
      if (error.status === 429) return failed("rate-limited", false, 429);
      return failed("server-error", false, error.status);
    case "network":
      return failed("network");
    case "timeout":
      return failed("timeout");
    case "redirect":
      return failed("redirect-refused");
    case "too-large":
      return failed("too-large");
    case "malformed":
      return failed("malformed-response");
    case "cancelled":
      return cancelled();
  }
}

/** Helper failures, mapped once. `residue` is carried, never inferred. */
function fromHelper(error: NativeHelperError): { code: StoredFailureCode; residue: boolean } {
  switch (error.code) {
    case "helper-unavailable":
    case "helper-timeout":
    case "protocol":
    case "busy":
      return { code: "destination-unavailable", residue: error.residue };
    case "manifest-refused":
      // The helper refused a manifest this build already judged acceptable —
      // its bounds are stricter in two places (`manifest.ts` pre-checks both),
      // so this is a real divergence rather than an ordinary refusal, and it is
      // reported as a manifest refusal rather than dressed up as an IO fault.
      return { code: "manifest-refused", residue: error.residue };
    case "authority-changed":
      return { code: "authority-changed", residue: error.residue };
    case "length-exceeded":
    case "length-short":
    case "short-write":
    case "io-failed":
      return { code: "destination-io", residue: error.residue };
    case "publish-failed":
      return { code: "publish-failed", residue: error.residue };
    case "residue":
    case "cleanup-uncertain":
      return { code: "cleanup-uncertain", residue: true };
    case "cancelled":
    case "internal":
      return { code: "internal", residue: error.residue };
  }
}

/**
 * Tear the destination down and report whether it left bytes behind.
 *
 * `cancel()` REJECTS when cleanup could not be confirmed — the destination
 * interface resolves `void`, so a residue flag has nowhere else to travel — and
 * that rejection is the only source of truth about residue here. It is never
 * softened into a clean teardown.
 */
interface Teardown {
  readonly residue: boolean;
  readonly cleanupTicket: string | null;
}

const CLEAN: Teardown = { residue: false, cleanupTicket: null };

/**
 * Tear the destination down, and keep it if that did not settle.
 *
 * `cancel()` REJECTS when cleanup could not be confirmed — the destination
 * interface resolves `void`, so a residue flag has nowhere else to travel — and
 * that rejection is the only source of truth about residue here. It is never
 * softened into a clean teardown.
 *
 * The handle is then RETAINED rather than dropped, into the slot this transfer
 * reserved before the destination existed. `cancel()` is retryable by contract
 * and a later attempt may be the one that kills the child and removes the
 * bytes; throwing the reference away would leave a report that says "bytes may
 * remain" next to a process that discarded the only thing that could still act
 * on it — and would leak a live child process.
 */
async function discard(
  destination: NativeReceiveDestination,
  reservation: CleanupReservation,
): Promise<Teardown> {
  try {
    await destination.cancel();
    reservation.release();
    return CLEAN;
  } catch (error) {
    const residue = error instanceof NativeHelperError ? error.residue : true;
    return { residue, cleanupTicket: reservation.claim(destination) };
  }
}

export async function receiveStoredLink(options: StoredReceiveOptions): Promise<StoredReceiveReport> {
  const { signal } = options;
  const throwIfCancelled = (): void => {
    if (signal?.aborted === true) throw new Cancelled();
  };

  const parsed = options.hosts === undefined
    ? parseStoredLink(options.link)
    : parseStoredLink(options.link, options.hosts);
  if (!parsed.ok) return failed("link-invalid");

  let runtime: StoredRuntime;
  try {
    runtime = await (options.runtime ?? storedRuntime)();
  } catch {
    return failed("runtime-unavailable");
  }

  let key: CryptoKey;
  try {
    // Decoded and imported inside the bundle — which runs in this same
    // process, so this is not isolation. The raw bytes stay a temporary inside
    // that call, the handle is non-extractable, and a refusal never quotes the
    // fragment.
    key = await runtime.importKeyFromFragment(parsed.link.key);
  } catch {
    return failed("link-invalid");
  }

  const transport = options.transport ?? new StoredTransport(apiOrigin());

  let meta: StoredObjectMeta;
  try {
    throwIfCancelled();
    meta = await transport.meta(parsed.link.id, signal);
  } catch (error) {
    if (error instanceof Cancelled) return cancelled();
    if (error instanceof StoredTransportError) return fromTransport(error);
    return failed("internal");
  }

  const sealed = sealedManifestBytes(meta.encManifest);
  if (sealed === null) return failed("malformed-response");

  let manifest: RuntimeStoredManifest;
  try {
    manifest = await runtime.decryptManifest(key, sealed);
  } catch (error) {
    // Two failures arrive through one call, and they are not the same news.
    // The shared validator's refusals carry its own stable `relayium:` prefix —
    // the manifest opened, and its CONTENTS are not a manifest this product
    // will accept. Anything else is the AEAD refusing to open frame 0: a wrong
    // key, or tampering.
    const message = String((error as Error)?.message ?? "");
    if (/^relayium: invalid manifest/.test(message)) {
      return failed("manifest-refused");
    }
    return failed("integrity");
  }

  const planned = planStoredManifest(manifest, runtime.constants);
  if (!planned.ok) {
    return {
      status: "failed",
      failure: {
        code: "manifest-refused",
        status: null,
        refusal: planned.refusal,
        residue: false,
        retryable: false,
        cleanupTicket: null,
        // Proven: the manifest was refused before a picker opened, let alone a
        // helper.
        published: "none",
      },
    };
  }
  const plan = planned.plan;
  const facts: StoredObjectFacts = {
    fileCount: plan.manifest.length,
    totalBytes: plan.totalBytes,
    burnAfterRead: meta.burnAfterRead,
    expiresAt: meta.expiresAt,
  };

  // The picker comes AFTER every refusal this side can make.
  let grant: DestinationGrant | null;
  try {
    throwIfCancelled();
    grant = await options.authority.grant(facts);
  } catch (error) {
    return error instanceof Cancelled ? cancelled() : failed("internal");
  }
  if (grant === null) return { status: "declined" };
  // A cancellation that landed while the dialog was open must not open a lease.
  if (signal?.aborted === true) return cancelled();

  // Capacity for a cleanup that might not settle is taken BEFORE the child
  // exists. Checking it afterwards would mean discovering at the cap that this
  // process has a live helper it cannot promise to own, and the only options
  // there are to drop the handle or to exceed the cap. Refusing to start is the
  // honest third answer.
  const cleanups = options.cleanups ?? storedCleanups;
  const reservation = cleanups.reserve();
  if (reservation === null) return failed("cleanup-capacity");

  let destination: NativeReceiveDestination;
  try {
    destination = await (options.destination ?? nativeHelperDestination)({
      authorityId: grant.authorityId,
      rootPath: grant.rootPath,
      manifest: plan.manifest,
    });
  } catch (error) {
    // `NativeHelperClient.open` tears its own failed lease down and carries any
    // residue onto the original error, so there is no handle to retain here —
    // the factory never returned one.
    reservation.release();
    if (error instanceof NativeHelperError) {
      const mapped = fromHelper(error);
      return failed(mapped.code, mapped.residue);
    }
    return failed("destination-unavailable");
  }

  return streamIntoDestination({
    runtime,
    key,
    transport,
    destination,
    plan,
    facts,
    options,
    id: parsed.link.id,
    authorityId: grant.authorityId,
    reservation,
  });
}

/** Everything that happens once a lease exists, so every exit from it either
 *  publishes or tears the lease down. */
async function streamIntoDestination(context: {
  readonly runtime: StoredRuntime;
  readonly key: CryptoKey;
  readonly transport: StoredObjectSource;
  readonly destination: NativeReceiveDestination;
  readonly plan: StoredWritePlan;
  readonly facts: StoredObjectFacts;
  readonly options: StoredReceiveOptions;
  readonly id: string;
  readonly authorityId: string;
  readonly reservation: CleanupReservation;
}): Promise<StoredReceiveReport> {
  const { runtime, key, transport, destination, plan, facts, options, id, authorityId, reservation } =
    context;
  const { signal } = options;
  const sizes = plan.manifest.map((entry) => entry.size);

  const throwIfCancelled = (): void => {
    if (signal?.aborted === true) throw new Cancelled();
  };

  let index = 0;
  let intoFile = 0;
  let started = false;
  let received = 0;

  /**
   * Split one plaintext delivery across manifest entries.
   *
   * Cancellation is re-checked after every await, not only at the top of a
   * round: each line below is an await, and a signal that fires while one is
   * pending resumes past every check that came before it. The line it draws is
   * "nothing new is started once the run is cancelled" — no file is created and
   * no file is finished.
   */
  const deliver = async (plaintext: Uint8Array): Promise<void> => {
    let off = 0;
    while (off < plaintext.byteLength) {
      throwIfCancelled();
      if (index >= sizes.length) {
        // More plaintext than the authenticated manifest describes. Refused
        // here rather than at `end()`: these bytes have nowhere legitimate to
        // go, and writing them anywhere would be writing data the manifest
        // never declared.
        throw new IntegrityFailure("plaintext past the manifest");
      }
      const declared = sizes[index] ?? 0;
      if (!started) {
        await destination.begin(index);
        started = true;
        throwIfCancelled();
      }
      const take = Math.min(declared - intoFile, plaintext.byteLength - off);
      if (take > 0) {
        await destination.write(index, plaintext.subarray(off, off + take));
        intoFile += take;
        off += take;
        received += take;
        throwIfCancelled();
      }
      if (intoFile >= declared) {
        await destination.finish(index);
        index += 1;
        intoFile = 0;
        started = false;
        throwIfCancelled();
      }
      options.onProgress?.(received, plan.totalBytes);
    }
  };

  /**
   * Drive one decryptor generator, handing each plaintext piece to `deliver`.
   *
   * The two halves are separated deliberately. Anything the DECRYPTOR throws is
   * an integrity failure — a frame that did not open under this key, a length
   * past the frame ceiling, trailing bytes, or a plaintext total that disagrees
   * with the manifest — and it is the one failure a user can actually act on
   * ("this link's key is wrong, or this object was corrupted"). Letting it fall
   * through to a generic internal fault would hide exactly that. Anything
   * `deliver` throws is a cancellation or a destination fault and passes
   * through untouched, because those are not statements about the ciphertext.
   */
  const feed = async (source: AsyncIterable<Uint8Array>): Promise<void> => {
    const iterator = source[Symbol.asyncIterator]();
    for (;;) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await iterator.next();
      } catch (error) {
        throw error instanceof IntegrityFailure ? error : new IntegrityFailure("frame did not open");
      }
      if (step.done === true) return;
      await deliver(step.value);
    }
  };

  let body: StoredBlobBody | null = null;
  try {
    throwIfCancelled();
    // Asserted before the first byte and again before publication: the lease
    // must still belong to this transfer at both ends of the stream.
    destination.assertAuthority(authorityId);
    body = await transport.blob(id, plan.cipherBytes, signal);
    const decryptor = runtime.createDecryptor(key);
    for (;;) {
      throwIfCancelled();
      const chunk = await untilCancelled(body.read(), signal);
      if (chunk === null) break;
      throwIfCancelled();
      await feed(decryptor.push(chunk));
    }
    // The gate. A stream that stopped on a frame boundary is indistinguishable
    // from a clean end without this, and `end` is what compares the decrypted
    // total against the manifest's own.
    await feed(decryptor.end(plan.totalBytes));
    // Manifest entries the plaintext stream never reached. Only zero-byte files
    // can be here: the ciphertext carries no frame for them, so nothing ever
    // drove the loop that would have created them. Without this the transfer
    // would publish a folder missing files and report success.
    while (index < sizes.length) {
      throwIfCancelled();
      const declared = sizes[index] ?? 0;
      if (declared !== intoFile) {
        // Unreachable while `end()` above holds — it already proved the totals
        // agree — and kept because an empty file standing in for a real
        // shortfall is precisely the silent truncation this path exists to
        // prevent.
        throw new IntegrityFailure("unfilled manifest entry after a validated stream");
      }
      if (!started) await destination.begin(index);
      throwIfCancelled();
      await destination.finish(index);
      index += 1;
      intoFile = 0;
      started = false;
    }
    await body.close();
    body = null;

    throwIfCancelled();
    destination.assertAuthority(authorityId);
    return await publishInto(destination, facts, reservation);
  } catch (error) {
    // Every failure from here tears the lease down. Nothing was published on
    // this path — publication is the only statement above that can succeed, and
    // it returns rather than throwing past this point.
    // The body first: it is the live connection, and the helper teardown that
    // follows can take its own deadline to settle. Both awaited, so a caller
    // holding the report knows the network is released and the lease is torn
    // down — not that both were merely asked to stop.
    if (body !== null) await body.close();
    const teardown = await discard(destination, reservation);
    if (error instanceof Cancelled) return cancelled(teardown);
    // A caller that cancelled gets a cancellation, whatever error the
    // cancellation happened to surface first: a helper request that raced the
    // teardown rejects with its own code, and reporting that as a fault would
    // put a failure in front of a user who simply changed their mind.
    if (signal?.aborted === true) return cancelled(teardown);
    if (error instanceof IntegrityFailure) {
      return failed("integrity", teardown.residue, null, teardown.cleanupTicket);
    }
    if (error instanceof StoredTransportError) {
      const mapped = fromTransport(error);
      if (mapped.status === "cancelled") return cancelled(teardown);
      if (mapped.status === "failed") {
        // The transport decides the code and whether a fresh attempt is worth
        // offering; the teardown decides the residue. Neither overwrites the
        // other: a 404 that also left bytes behind is both facts at once.
        return {
          status: "failed",
          failure: { ...mapped.failure, residue: teardown.residue, cleanupTicket: teardown.cleanupTicket },
        };
      }
      return mapped;
    }
    if (error instanceof NativeHelperError) {
      const mapped = fromHelper(error);
      return failed(mapped.code, mapped.residue || teardown.residue, null, teardown.cleanupTicket);
    }
    return failed("internal", teardown.residue, null, teardown.cleanupTicket);
  }
}

/**
 * Publish, and report what publication actually achieved.
 *
 * ## A publish error still leaves this process owning a child
 *
 * `settleAfterPublish` (native-helper-client.ts:778-797) throws
 * `cleanup-uncertain` with `residue: true` AND the validated receipt when the
 * helper did not close after being killed. The process is still there. An
 * earlier version of this function returned the receipt and walked away, which
 * leaked that child and threw away the only handle that could kill it — root's
 * probe caught it as `registry 0`. So EVERY publish error now gets an owned
 * teardown attempt, and the handle is retained if that attempt does not settle.
 *
 * ## The receipt is never replaced by a failure
 *
 * A `partial` resolves, and so does a `complete` whose teardown failed: the
 * files under `publishedCount` exist on the user's disk whatever happened next.
 * The report keeps the count, adds the residue, and carries the cleanup ticket.
 * Rewriting either into "nothing was saved" would be false in the one direction
 * that loses the user's data silently.
 *
 * ## And an error with NO receipt does not prove nothing was published
 *
 * When the helper stopped answering the publish request, or answered with a
 * receipt this side could not verify, the rename may or may not have happened.
 * That is reported as `published: "unknown"` rather than as a clean "nothing
 * was saved", because only a well-formed refusal for the whole batch proves the
 * latter.
 */
async function publishInto(
  destination: NativeReceiveDestination,
  facts: StoredObjectFacts,
  reservation: CleanupReservation,
): Promise<StoredReceiveReport> {
  let report: NativePublishReport;
  try {
    report = await destination.publish();
  } catch (error) {
    // The teardown attempt comes FIRST, whatever the error was: if the child is
    // still running this is the call that kills it, and if it is already gone
    // this settles cheaply and frees the slot.
    const teardown = await discard(destination, reservation);
    if (error instanceof NativeHelperError) {
      const receipt = error.publishReport;
      if (receipt !== undefined) {
        // Published — and then the teardown could not be confirmed. Residue is
        // the union of what the helper reported and what this attempt found; a
        // later kill succeeding does not prove the bytes it left were removed,
        // so the helper's own claim is never downgraded.
        return fromPublishReport(receipt, facts, error.residue || teardown.residue, teardown.cleanupTicket);
      }
      const mapped = fromHelper(error);
      return failed(
        mapped.code,
        mapped.residue || teardown.residue,
        null,
        teardown.cleanupTicket,
        provenUnpublished(error) ? "none" : "unknown",
      );
    }
    return failed("internal", true, null, teardown.cleanupTicket, "unknown");
  }
  reservation.release();
  return fromPublishReport(report, facts, false, null);
}

/**
 * Whether a publish error proves that no file reached its final name.
 *
 * Only one shape does: the helper answered, in the documented form, that
 * publication was refused for the batch. Everything else — a request that
 * stopped being answered, a protocol fault, a partial-publication code whose
 * receipt did not corroborate its own prefix claim — leaves the question open,
 * and answering it "none" would tell a user nothing was saved on the strength
 * of evidence that does not say so.
 */
function provenUnpublished(error: NativeHelperError): boolean {
  return error.code === "publish-failed" && error.helperCode !== "E_PARTIAL_PUBLICATION";
}

function fromPublishReport(
  report: NativePublishReport,
  facts: StoredObjectFacts,
  residue: boolean,
  cleanupTicket: string | null,
): StoredReceiveReport {
  if (report.status === "complete") {
    return { status: "saved", facts, publishedCount: report.publishedCount, residue, cleanupTicket };
  }
  return {
    status: "partially-saved",
    facts,
    publishedCount: report.publishedCount,
    total: report.total,
    failedIndex: report.failedIndex,
    reason: report.reason,
    residue,
    cleanupTicket,
  };
}
