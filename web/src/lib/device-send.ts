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
  uploadFileResumable,
  type UploadProgress,
} from "./stored-file";
import { decodeKey } from "./store-crypto";
import { sealContentKey, UnusableDeviceKeyError } from "./device-seal";
import {
  INBOX_KEY_ALGORITHM,
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
}

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

/** Encrypt, upload and queue one delivery. Resolves with the task central
 *  actually holds, or throws `SendFailure`.
 *
 *  Never creates a share link, never persists the content key: the key exists
 *  in this function's locals and inside the sealed box, and nowhere else. The
 *  caller gets a task id, not a key. */
export async function sendFilesToDevice(
  target: SendTarget,
  files: File[],
  opts: SendOptions,
): Promise<InboxTaskView> {
  const { signal, onProgress } = opts;
  if (!isInertId(target.deviceID)) throw new SendFailure("unsupported_key");
  if (!files.length) throw new SendFailure("no_files");
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
      files,
      // burnAfterRead is false and maxDownloads is never sent: the queue
      // requires an unlimited-until-TTL object and central refuses the
      // contradiction by name rather than rewriting it (protocol §25).
      { burnAfterRead: false, ttl: opts.ttl, purpose: "device_task" },
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
