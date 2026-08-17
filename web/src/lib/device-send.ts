// Sending files to one of your own devices: the network half.
//
// The whole sequence, and why it is this order:
//
//   1. generate ONE random AES-256-GCM content key, in this browser;
//   2. encrypt the manifest (names + sizes) and every file frame with it, using
//      the existing Stored Wire machinery — unchanged, so a Device Inbox
//      delivery is byte-identical to a share on the wire;
//   3. upload ONLY that ciphertext, as `?purpose=device_task`: no link, no
//      file-list row, 404 on the public endpoints even for its owner;
//   4. seal the content key to the target device's CURRENT public key with
//      libsodium `crypto_box_seal`;
//   5. create the task, which binds the object to it inside one transaction.
//
// Central therefore learns: an account, a target device, a ciphertext byte
// count, timestamps and a state. It never receives a file name, a directory, a
// destination path, the content key or any private material — there is no
// request field here that could carry one, and `httpx.DecodeStrictJSONBody`
// makes an accidental extra field a 400 rather than a silently ignored one.
//
// The seal happens AFTER the upload on purpose: it is the cheap step, and doing
// it last means a stale-key race (the device rotated while we were uploading) is
// resolved by re-sealing and retrying the create against ciphertext that is
// already there, rather than by re-uploading it.
import {
  UploadError,
  InvalidStoredObjectIdError,
  ManifestPurposeMismatchError,
  uploadFileResumable,
  type UploadProgress,
} from "./stored-file";
import { decodeKey } from "./store-crypto";
import { sealContentKey, UnusableDeviceKeyError } from "./device-seal";
import {
  encodeInboxManifestBytes,
  fileManifest,
  textManifest,
  InboxManifestError,
  INBOX_MANIFEST_MAX_TEXT_BYTES,
  INBOX_MANIFEST_MIN_TEXT_BYTES,
} from "./inbox-manifest";
import type { PickedFile } from "./drag";
import {
  CAP_TEXT_V1,
  INBOX_KEY_ALGORITHM,
  INBOX_PROTOCOL_VERSION,
  httpSendErrorCode,
  isInertId,
  parseInboxTask,
  toSendErrorCode,
  type DeviceKeyView,
  type InboxTaskView,
  type LocalPhase,
  type SendErrorCode,
} from "./device-inbox";

/** A send that did not produce a task, carrying the closed-set code the UI maps
 *  to one localized sentence. Never carries server text. */
export class SendFailure extends Error {
  constructor(public code: SendErrorCode) {
    super(`device send failed: ${code}`);
    this.name = "SendFailure";
  }
}

/** What the caller is told while a send is in flight. `sent`/`total` are
 *  ciphertext bytes for `uploading` and plaintext bytes for `encrypting`, which
 *  is what the underlying upload reports; `registering` has no byte count. */
export interface SendProgress {
  phase: LocalPhase;
  sent: number;
  total: number;
}

export interface SendTarget {
  deviceID: string;
  keyID: string;
  keyGeneration: number;
  algorithm: string;
  publicKey: string;
  /** What the target device announced. Read only by `sendTextToDevice`, which
   *  requires `inbox.text.v1`; a FILE send never consults it, because requiring
   *  it there would refuse every receiver that has no message surface.
   *
   *  Optional and fail-CLOSED: a caller that does not supply it cannot send a
   *  message, which is the safe direction — the cost of being wrong the other
   *  way is a message delivered to a build that never shows one. */
  capabilities?: readonly string[];
}

/** One outgoing file: the bytes, plus the "/"-separated relative path a folder
 *  send has to keep.
 *
 *  Structurally `drag.ts`'s `PickedFile`, and deliberately the same type rather
 *  than a copy: the walker that flattens a dropped folder is where the path
 *  comes from, and a send that took bare `File`s would have to throw it away —
 *  a folder would arrive on the other device as a flat pile of files. */
export type OutgoingFile = PickedFile;

export interface SendOptions {
  /** Requested retention of the ciphertext. Clamped by central and by the
   *  account's plan; the task cannot outlive it (protocol §12). */
  ttl: number;
  /** Sender-chosen, stable for the whole attempt INCLUDING its internal
   *  retries. That stability is the entire mechanism by which a lost response
   *  converges instead of queueing a second delivery. */
  idempotencyKey: string;
  signal?: AbortSignal;
  onProgress?: (p: SendProgress) => void;
}

/** ≤128 printable ASCII bytes without whitespace (protocol §17). Produced here
 *  rather than by the caller so the shape central accepts is enforced in one
 *  place, and random rather than derived from the files: deriving it would make
 *  two deliberate sends of the same file collide on `idempotency_key_conflict`
 *  or, worse, converge and report the second send as queued when it was not. */
export function newIdempotencyKey(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let s = "";
  for (const b of raw) s += b.toString(16).padStart(2, "0");
  return `web-${s}`;
}

function aborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

/** Map anything thrown by the upload/create layer onto the closed code set. */
function failureFor(e: unknown, signal?: AbortSignal): SendFailure {
  if (e instanceof SendFailure) return e;
  if (aborted(signal) || (e instanceof DOMException && e.name === "AbortError")) {
    return new SendFailure("cancelled");
  }
  if (e instanceof UnusableDeviceKeyError) return new SendFailure("unsupported_key");
  // This client refusing itself: the purpose and the frame-0 document did not
  // agree. Reported as its own terminal code rather than as a network failure,
  // which would invite a retry that cannot succeed.
  if (e instanceof ManifestPurposeMismatchError) return new SendFailure("unsendable_content");
  // A refused identifier is a trust-boundary failure, not a user-visible quota
  // or auth problem — reported as `unknown` rather than guessed at, and never
  // with the offending value.
  if (e instanceof InvalidStoredObjectIdError) return new SendFailure("unknown");
  if (e instanceof UploadError) return new SendFailure(httpSendErrorCode(e.status));
  return new SendFailure("network");
}

/** The task-creation request, split out so the stale-key retry can repeat it
 *  with a freshly sealed key and nothing else changed. */
interface CreateAttempt {
  wrappedKey: string;
  targetKeyId: string;
  targetKeyGeneration: number;
}

interface CreateResult {
  task?: InboxTaskView;
  /** Set when the server answered definitively and it was not a success. */
  error?: SendErrorCode;
  /** True when the request never reached a server, or its answer was lost — the
   *  one case where the outcome is genuinely unknown. */
  ambiguous?: boolean;
}

async function createTask(
  deviceID: string,
  storedFileId: string,
  idempotencyKey: string,
  attempt: CreateAttempt,
  signal?: AbortSignal,
): Promise<CreateResult> {
  let res: Response;
  try {
    res = await fetch(`/api/devices/${encodeURIComponent(deviceID)}/inbox/tasks`, {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        storedFileId,
        // The shape the sealed manifest was written to — not what is in it.
        protocolVersion: INBOX_PROTOCOL_VERSION,
        wrapAlgorithm: INBOX_KEY_ALGORITHM,
        wrappedKey: attempt.wrappedKey,
        targetKeyId: attempt.targetKeyId,
        targetKeyGeneration: attempt.targetKeyGeneration,
      }),
    });
  } catch (e) {
    if (aborted(signal)) throw new SendFailure("cancelled");
    return { ambiguous: true };
  }
  if (res.ok) {
    // A converged retry answers 200 `{"created": false}` with the ORIGINAL
    // task; a new one answers 201. Both are successes and both carry the task
    // that actually owns this ciphertext, so neither is special-cased.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ambiguous: true }; // 2xx with an unreadable body — the task may exist
    }
    const task = parseInboxTask((body as { task?: unknown } | null)?.task);
    return task ? { task } : { ambiguous: true };
  }
  if (res.status >= 500) return { ambiguous: true }; // retryable; the write may still have landed
  let code: SendErrorCode;
  try {
    code = toSendErrorCode(((await res.json()) as { error?: unknown } | null)?.error);
  } catch {
    code = httpSendErrorCode(res.status);
  }
  // A 4xx with no recognised token still has a status worth mapping — 401 must
  // read as "signed out", not as the generic sentence.
  if (code === "unknown") code = httpSendErrorCode(res.status);
  return { error: code };
}

/** Read the device's CURRENT public key straight from central.
 *
 *  Used only on `stale_target_key`: the device rotated between the moment the
 *  card was rendered and the moment the task was created. Returns `null` when
 *  there is no usable current key, which makes the send fail honestly rather
 *  than retry forever against a device that has none. */
async function currentDeviceKey(deviceID: string, signal?: AbortSignal): Promise<DeviceKeyView | null> {
  let res: Response;
  try {
    res = await fetch(`/api/devices/${encodeURIComponent(deviceID)}/inbox/keys`, {
      credentials: "include",
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return null;
  for (const raw of keys) {
    if (!raw || typeof raw !== "object") continue;
    const k = raw as Record<string, unknown>;
    if (k.SupersededAt === 0 && k.RevokedAt === 0 && typeof k.PublicKey === "string" && isInertId(k.ID)) {
      return {
        ID: k.ID as string,
        Algorithm: typeof k.Algorithm === "string" ? k.Algorithm : "",
        PublicKey: k.PublicKey,
        Generation: typeof k.Generation === "number" ? k.Generation : 0,
        CreatedAt: 0,
        SupersededAt: 0,
        RevokedAt: 0,
      };
    }
  }
  return null;
}

/** Does a task with this idempotency key already exist on the device?
 *
 *  The only honest way out of network ambiguity. `UNIQUE(user_id,
 *  idempotency_key)` means at most one can exist, so finding it is proof the
 *  create landed and finding none — from a request that SUCCEEDED — is proof it
 *  did not. A failed lookup returns `undefined`: still unknown, and the caller
 *  must not destroy ciphertext on a guess. */
async function findTaskByIdempotencyKey(
  deviceID: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<InboxTaskView | null | undefined> {
  let res: Response;
  try {
    res = await fetch(`/api/devices/${encodeURIComponent(deviceID)}/inbox/tasks?limit=100`, {
      credentials: "include",
      signal,
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  const tasks = (body as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return undefined;
  for (const raw of tasks) {
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).IdempotencyKey === idempotencyKey) {
      return parseInboxTask(raw);
    }
  }
  return null;
}

/** Drop a task-purpose object that no task owns.
 *
 *  Best effort, and only ever called when the object is provably unbound: a
 *  `device_task` object has no link, no file-list row and no user-facing
 *  control, so leaving one behind is storage the account pays for and cannot
 *  see. GC reclaims it an hour later either way (protocol §27), but an hour of
 *  invisible quota after a failure the user watched happen is not a good
 *  answer when one DELETE returns it now. */
async function releaseObject(storedFileId: string): Promise<void> {
  if (!isInertId(storedFileId)) return;
  try {
    await fetch(`/api/files/${encodeURIComponent(storedFileId)}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
    /* GC still reclaims it; nothing here is worth surfacing to the user */
  }
}

/** How many times a create may be repeated after an AMBIGUOUS answer. Each
 *  repeat carries the same idempotency key, so a landed write converges rather
 *  than duplicating. */
const CREATE_ATTEMPTS = 3;

/** What one delivery seals and sends: the canonical frame-0 document, and the
 *  payload blobs whose frames follow it in exactly this order. */
interface Delivery {
  manifest: Uint8Array;
  payload: File[];
}

/** Encrypt, upload and queue one FILE OR FOLDER delivery. Resolves with the task
 *  central actually holds, or throws `SendFailure`.
 *
 *  `files` carries each item's manifest NAME as well as its bytes, so a folder
 *  send keeps its shape: the name is the "/"-separated relative path, sealed
 *  inside the manifest and visible to nobody in between.
 *
 *  Deliberately does NOT require `inbox.text.v1` of its target. That token says
 *  the receiver presents a message as a message, which has nothing to do with
 *  whether it can take a file. */
export async function sendFilesToDevice(
  target: SendTarget,
  files: OutgoingFile[],
  opts: SendOptions,
): Promise<InboxTaskView> {
  if (!files.length) throw new SendFailure("no_files");
  let delivery: Delivery;
  try {
    // Item order is the caller's and is never sorted: item i describes the
    // payload frames of blob i, so reordering would rename every file.
    delivery = {
      manifest: encodeInboxManifestBytes(
        fileManifest(files.map((f) => ({ name: f.path ?? f.file.name, size: f.file.size }))),
      ),
      payload: files.map((f) => f.file),
    };
  } catch (e) {
    // A name no receiver would accept — traversal, a control character, a
    // backslash — fails the send here rather than after the upload, which is
    // where the receiver would otherwise refuse it. Terminal either way.
    if (e instanceof InboxManifestError) throw new SendFailure("unsendable_content");
    throw new SendFailure("unknown");
  }
  return deliver(target, delivery, opts);
}

/** Encrypt, upload and queue one MESSAGE. Exactly one nonempty UTF-8 message of
 *  at most 64 KiB, and no attachments: one delivery is one kind.
 *
 *  The body travels ONLY in the encrypted payload frames. The manifest declares
 *  its length and nothing else, and the create request central sees is the same
 *  seven opaque fields a file send produces — so a message and a file delivery
 *  are indistinguishable to the server, to its operators, and to anyone reading
 *  its storage.
 *
 *  Refused outright for a target that does not announce `inbox.text.v1`: that
 *  build has not promised a surface that shows a message, so the delivery would
 *  either be refused after the whole upload or be stored where its user never
 *  sees it. Offering the action at all would promise something else. */
export async function sendTextToDevice(
  target: SendTarget,
  message: string,
  opts: SendOptions,
): Promise<InboxTaskView> {
  // Measured in UTF-8 BYTES, which is what the manifest declares and what the
  // receiver re-measures. A per-character bound would let one emoji past a
  // check the seal then refuses.
  const body = new TextEncoder().encode(message);
  if (body.length < INBOX_MANIFEST_MIN_TEXT_BYTES) throw new SendFailure("empty_message");
  if (body.length > INBOX_MANIFEST_MAX_TEXT_BYTES) throw new SendFailure("message_too_long");
  if (!target.capabilities?.includes(CAP_TEXT_V1)) throw new SendFailure("text_unsupported");
  return deliver(
    target,
    {
      manifest: encodeInboxManifestBytes(textManifest(body.length)),
      // A `File` because that is what the chunked encryptor reads, and its name
      // is never used: the manifest omits `name` entirely for a text item, and
      // the upload path does not build a Stored-Wire manifest for a delivery at
      // all.
      // nonlocalized: an internal blob label, never sealed and never displayed
      payload: [new File([body as BlobPart], "message")],
    },
    opts,
  );
}

/** The wire half every delivery shares, whatever it contains. */
async function deliver(
  target: SendTarget,
  delivery: Delivery,
  opts: SendOptions,
): Promise<InboxTaskView> {
  const { signal, onProgress } = opts;
  if (!isInertId(target.deviceID)) throw new SendFailure("unsupported_key");
  if (aborted(signal)) throw new SendFailure("cancelled");

  let storedFileId = "";
  let released = false;
  /** Return the object's quota once, and only when nothing can own it. */
  const release = async () => {
    if (!storedFileId || released) return;
    released = true;
    await releaseObject(storedFileId);
  };
  try {
    const uploaded = await uploadFileResumable(
      delivery.payload,
      // burnAfterRead is false and maxDownloads is never sent: the queue
      // requires an unlimited-until-TTL object and central refuses the
      // contradiction by name rather than rewriting it (protocol §25).
      //
      // `sealedManifest` is what makes frame 0 the Device Inbox v2 document
      // rather than the shared Stored-Wire one. It is REQUIRED for this purpose
      // and refused for every other, in both directions, before a byte is
      // encrypted — a delivery that sealed the shared manifest would be refused
      // by its own receiver as `verify_failed`.
      {
        burnAfterRead: false,
        ttl: opts.ttl,
        purpose: "device_task",
        sealedManifest: delivery.manifest,
      },
      (p: UploadProgress) => onProgress?.({ phase: p.phase, sent: p.sent, total: p.total }),
      signal,
    );
    storedFileId = uploaded.id;
    if (aborted(signal)) throw new SendFailure("cancelled");

    onProgress?.({ phase: "registering", sent: 0, total: 0 });
    let attempt: CreateAttempt = {
      wrappedKey: await sealContentKey(decodeKey(uploaded.key), target.algorithm, target.publicKey),
      targetKeyId: target.keyID,
      targetKeyGeneration: target.keyGeneration,
    };

    let staleRetried = false;
    for (let n = 0; n < CREATE_ATTEMPTS; n++) {
      const result = await createTask(target.deviceID, storedFileId, opts.idempotencyKey, attempt, signal);
      if (result.task) return result.task;
      if (result.error === "stale_target_key" && !staleRetried) {
        // The device rotated while we were uploading. Re-read its current key
        // and seal again — with the SAME idempotency key and the SAME object,
        // because the failed create rolled its binding back inside its own
        // transaction, so this is the first binding, not a rebinding.
        staleRetried = true;
        const fresh = await currentDeviceKey(target.deviceID, signal);
        if (!fresh) {
          await release();
          throw new SendFailure("stale_target_key");
        }
        attempt = {
          wrappedKey: await sealContentKey(decodeKey(uploaded.key), fresh.Algorithm, fresh.PublicKey),
          targetKeyId: fresh.ID,
          targetKeyGeneration: fresh.Generation,
        };
        n--; // the re-seal is not one of the ambiguity retries
        continue;
      }
      if (result.error) {
        // A definitive refusal means the create's transaction rolled back, so
        // nothing bound this object and it can be returned immediately.
        await release();
        throw new SendFailure(result.error);
      }
      if (aborted(signal)) throw new SendFailure("cancelled");
    }

    // Every attempt was ambiguous. Ask what actually exists rather than guess.
    const found = await findTaskByIdempotencyKey(target.deviceID, opts.idempotencyKey, signal);
    if (found) return found;
    // `null` is a definitive "no such task": safe to return the quota now.
    // `undefined` is still unknown, so the ciphertext is KEPT — a delivery that
    // may be live must never be destroyed to tidy up a failed request.
    if (found === null) await release();
    throw new SendFailure("network");
  } catch (e) {
    const failure = failureFor(e, signal);
    // Every failure except `network` is a definitive one: the create either
    // never happened or rolled back, so no task can own this ciphertext and
    // holding it would be invisible quota. `network` is the one case where a
    // delivery MAY be live, and the convergence lookup above is the only thing
    // allowed to decide it — a guess there would destroy a real transfer.
    if (failure.code !== "network") await release();
    throw failure;
  }
}

/** Read one task's current state (protocol §17).
 *
 *  Returns `undefined` on a transient failure — the caller keeps the state it
 *  has and polls again — and `null` when central says the task is gone (404),
 *  which is the honest end of a poll. */
export async function fetchInboxTask(
  deviceID: string,
  taskID: string,
  signal?: AbortSignal,
): Promise<InboxTaskView | null | undefined> {
  if (!isInertId(deviceID) || !isInertId(taskID)) return null;
  let res: Response;
  try {
    res = await fetch(
      `/api/devices/${encodeURIComponent(deviceID)}/inbox/tasks/${encodeURIComponent(taskID)}`,
      { credentials: "include", signal },
    );
  } catch {
    return undefined;
  }
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  try {
    return parseInboxTask(((await res.json()) as { task?: unknown } | null)?.task) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Cancel a queued delivery: removes the task and, for a task-purpose object,
 *  drops its ciphertext in the same transaction (protocol §27).
 *
 *  Only offered while nothing is in flight — see `CANCELLABLE_STATES`. */
export async function cancelInboxTask(deviceID: string, taskID: string): Promise<boolean> {
  if (!isInertId(deviceID) || !isInertId(taskID)) return false;
  try {
    const res = await fetch(
      `/api/devices/${encodeURIComponent(deviceID)}/inbox/tasks/${encodeURIComponent(taskID)}`,
      { method: "DELETE", credentials: "include" },
    );
    // 404 means it is already gone — the outcome the caller asked for.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** States in which cancelling is honest.
 *
 *  Deliberately excludes `downloading` and `verifying`: the device holds a live
 *  lease there, and deleting under it would turn work that may be seconds from
 *  a successful commit into a failed report. It also excludes every terminal
 *  state, where there is nothing left to cancel. */
export const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  "queued",
  "notified",
  "attention_required",
  "failed_retryable",
]);
