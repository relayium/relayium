// API wrappers for the zero-knowledge stored-transfer mode. All encryption
// happens here/in store-crypto; the server only ever receives ciphertext.
import {
  generateStoreKey,
  importStoreKey,
  encryptManifest,
  decryptManifest,
  encryptFiles,
  cipherSizeFor,
  decodeKey,
  encodeKey,
  completionVerifier,
  sealManifestBytes,
  StoreDecryptor,
  STORE_CHUNK_SIZE,
  FRAME_OVERHEAD,
  type StoredManifest,
} from "./store-crypto";
import { DOWNLOAD_PREFIX } from "./transfer-link";

export interface UploadResult {
  id: string;
  expiresAt: number;
  key: string; // base64url, belongs in the URL fragment only
}

/** Why this ciphertext exists (protocol §24). `share` is the capability-link
 *  object — public `meta`/`blob`, listed in the account's files — and is the
 *  default for every caller that says nothing, which is every share upload.
 *
 *  `device_task` is ciphertext uploaded for ONE Device Inbox delivery: no link,
 *  no file-list row, 404 on the public endpoints even for its owner. It carries
 *  an authorization decision, so it is sent explicitly on BOTH upload paths and
 *  a resumable session persists it — `finalize` may run on a different instance
 *  and must not re-derive it from a query string it can no longer see.
 *
 *  `pair_room` is ciphertext staged against a pairing code while its room waits
 *  for the other device (docs/protocol/relayium-pair-room-v1.md). One object per
 *  FILE, bound to the room the `?code=` names, with a lifetime that is the
 *  room's rather than a TTL of its own. */
export type UploadPurpose = "share" | "device_task" | "pair_room";

/** A share or Device Inbox upload: the caller chooses the retention the server
 *  then resolves against its settings. */
export interface RetainedUploadOptions {
  burnAfterRead: boolean;
  ttl: number;
  /** Omitted means `share`, exactly as the server resolves an absent
   *  `?purpose=`. Never inferred from anything else. */
  purpose?: "share" | "device_task";
  /** The plaintext frame-0 document, when this upload seals its own.
   *
   *  A Device Inbox delivery's frame 0 is the dedicated v2 manifest
   *  (`inbox-manifest.ts`), which carries the delivery's content kind; a share's
   *  is the shared Stored-Wire manifest, whose bytes are frozen and interop
   *  tested across unrelated products. Neither may be the other, so this field
   *  and `purpose` are checked against each other before a byte is encrypted —
   *  see `checkedManifest`.
   *
   *  Already canonical when it arrives: `encodeInboxManifestBytes` produced it,
   *  and the frozen cross-language vectors pin that spelling. Nothing here
   *  re-encodes or re-validates it. */
  sealedManifest?: Uint8Array;
}

/** A pre-upload into a pairing room.
 *
 *  A separate arm of the union rather than three optional fields, because the two
 *  shapes are mutually exclusive on the wire and the server enforces it: a pair-
 *  room upload with `burnAfterRead`, `maxDownloads` or a positive `ttl` is a 400,
 *  refused rather than overridden, since retention here belongs to the room. And
 *  `code` is required for the same reason in reverse — an upload with no code is
 *  a guaranteed 403. Both mistakes are compile errors instead of round trips. */
export interface PairRoomUploadOptions {
  purpose: "pair_room";
  /** The six digits of a live pairing code minted by THIS account. */
  code: string;
}

export type UploadOptions = RetainedUploadOptions | PairRoomUploadOptions;

/** Whether these options describe a pre-upload into a pairing room. Narrows the
 *  union for every branch that has to treat one differently. */
function isPairRoom(opts: UploadOptions): opts is PairRoomUploadOptions {
  return opts.purpose === "pair_room";
}

/** The retention/purpose query both upload paths share.
 *
 *  `purpose` is appended only when the caller asked for a non-default one, so a
 *  share upload's request is byte-for-byte what it was before this existed. A
 *  `device_task` upload additionally must be unlimited-until-TTL — the queue
 *  refuses a limited object (protocol §12) — and the server refuses the
 *  contradiction rather than rewriting it, so this never silently drops the
 *  caller's burn flag. */
function uploadQuery(opts: UploadOptions): string {
  // A pre-upload names its room and NOTHING else. Not "burnAfterRead=0&ttl=0",
  // which would happen to pass today: the server refuses any retention parameter
  // it can see rather than overriding it, and a query that carries the two
  // harmless-looking zeros is one server-side tightening away from a 400 on every
  // pre-upload. Retention here is the room's; the request should not mention it.
  if (isPairRoom(opts)) {
    if (!opts.code) throw new Error("pair-room upload without a pairing code");
    return `?purpose=pair_room&code=${encodeURIComponent(opts.code)}`;
  }
  const q = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}`;
  return opts.purpose && opts.purpose !== "share" ? `${q}&purpose=${encodeURIComponent(opts.purpose)}` : q;
}

/** An upload whose purpose and frame-0 document do not agree. Thrown before a
 *  byte is encrypted, because neither mistake is recoverable where it would
 *  otherwise be discovered: a `device_task` object carrying the shared manifest
 *  is refused by its own v2 receiver as `verify_failed`, after the whole
 *  ciphertext has been uploaded, queued and downloaded; a share carrying a v2
 *  manifest is a download page that cannot read its own file list. */
export class ManifestPurposeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestPurposeMismatchError";
  }
}

/** The frame-0 document this upload may seal, or `undefined` for the shared
 *  Stored-Wire manifest. Checked in BOTH directions, so neither purpose can end
 *  up carrying the other's document. */
function checkedManifest(opts: UploadOptions): Uint8Array | undefined {
  const sealed = isPairRoom(opts) ? undefined : opts.sealedManifest;
  const isDelivery = opts.purpose === "device_task";
  if (isDelivery && !sealed) {
    throw new ManifestPurposeMismatchError("a Device Inbox delivery must seal its own v2 manifest");
  }
  if (!isDelivery && sealed) {
    throw new ManifestPurposeMismatchError(`purpose ${opts.purpose ?? "share"} may not seal its own manifest`);
  }
  return sealed;
}

export interface StoredFileMeta {
  encManifest: string; // base64 (standard)
  size: number;
  burnAfterRead: boolean;
  expiresAt: number;
}

/** Non-ok upload response, carrying the HTTP status so the UI can map 413/429. */
export class UploadError extends Error {
  constructor(public status: number) {
    super(`upload failed: ${status}`);
    this.name = "UploadError";
  }
}

/** How a finalize this client sent ended, when it did not end in an object.
 *
 *  - `unconfirmed`: the object may or may not exist. The finalize, or a retry of
 *    it, may have reached the server and its answer was lost, unreadable, or
 *    one a server that predates finalize recovery gives (a text 409), and the
 *    bounded retries ran out. The upload may have been stored and debited.
 *  - `failed`: the server refused this upload at finalize; no object exists.
 *  - `expired` / `removed`: the object this upload produced existed and is gone.
 *
 *  None of them is retried by uploading again: a second upload of an object
 *  that may already exist is a second object, a second debit and second
 *  traffic, and only the caller can decide that is what the user wants. */
export type FinalizeOutcome = "unconfirmed" | "failed" | "expired" | "removed";

/** A resumable upload that reached finalize without producing an object this
 *  client can hand out. Never followed by the single-shot fallback. */
export class UploadFinalizeError extends Error {
  constructor(public outcome: FinalizeOutcome) {
    super(`upload finalize: ${outcome}`);
    this.name = "UploadFinalizeError";
  }
}

/** A stored-object identifier this client refuses to act on, whoever produced it.
 *
 *  Every such id is interpolated into something where a stray character changes
 *  the *meaning* of the string rather than its value: the resumable `uploadId`
 *  becomes a path segment of every PATCH, offset GET and finalize; the
 *  finalize/`/api/files` id becomes the key-map entry the decryption key is filed
 *  under and the `/d/<id>#k=<key>` link the user is handed; a download id becomes
 *  the path segment of `/api/files/<id>/meta` and `/blob`. So `../me` aims a
 *  request at an endpoint this client never meant to call, `a#b` orphans the key
 *  fragment, and a blank or duplicate-after-escaping id silently overwrites
 *  another upload's key.
 *
 *  Two populations reach the rule, and only one of them is a tripwire:
 *
 *  - **Outbound, server-issued.** An id the server minted for this account's own
 *    upload is `authx.NewID()` — 32 hex characters — so the check is a guard on a
 *    broken or substituted response, not a defence against the caller.
 *  - **Inbound, recipient-supplied.** An id that arrived in a `/d/<id>#k=<key>`
 *    link — from a sender, a page, a chat message — or in a direct call to
 *    `fetchMeta`/`downloadBlob`, both public and both taking a plain `string`.
 *    Whoever wrote the link chose it; nothing guarantees it is 32 hex or that it
 *    came through the router at all. Here the check IS the defence, which is why
 *    it sits at the boundary that builds the request.
 *
 *  Refused, never sanitised and never percent-encoded: escaping would let two
 *  distinct ids collapse onto one key-map entry (losing a key for good), and no
 *  encoding helps against a `.` or `..` that a server or proxy resolves for its
 *  own reasons. Refusing is the only defence that does not depend on who
 *  normalises the path.
 *
 *  Deliberately carries no field for the offending value and never puts it in
 *  the message: this reaches UI copy and logs, and a hostile id is exactly the
 *  string that must not be echoed back into either.
 *
 *  Matches native `StoredObjectID` (apps/RelayiumKit) character for character —
 *  the two clients speak to the same server and must refuse the same ids. */
export class InvalidStoredObjectIdError extends Error {
  constructor() {
    super("invalid stored object identifier");
    this.name = "InvalidStoredObjectIdError";
  }
}

/** The name this refusal had while it only covered upload responses. Kept as the
 *  same class, not a subclass or a second error: an existing
 *  `catch (e instanceof InvalidUploadIdError)` must go on catching every refusal,
 *  and must not start missing the ones that now come from a download id. */
export const InvalidUploadIdError = InvalidStoredObjectIdError;
export type InvalidUploadIdError = InvalidStoredObjectIdError;

/** Wide enough for any plausible future id format, narrow enough that every
 *  member is inert in a URL path, a query string and a link fragment. Every id
 *  the server actually issues is `authx.NewID()` — 32 hex characters — so
 *  nothing legitimate is anywhere near the edge of this.
 *
 *  `$` and not `\n$`-tolerant by accident: JavaScript's `$` without `m` matches
 *  only at the very end of the input, so `"a\n"` is refused. Perl and Python
 *  would accept it — this rule must not be ported by shape into either. */
const STORED_OBJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Return `id` unchanged if it is one inert token, else throw. Non-strings
 *  (a JSON `null`, number, object or array, or anything a JavaScript caller
 *  passes despite the `string` annotation) fail the same way a bad string does —
 *  neither `JSON.parse` nor an erased TypeScript type checks anything for us. */
function checkedStoredObjectId(id: unknown): string {
  if (typeof id !== "string" || !STORED_OBJECT_ID_RE.test(id)) throw new InvalidStoredObjectIdError();
  return id;
}

/** Which request of a stored download failed. `metadata` is `/api/files/<id>/meta`
 *  — including the lookup `downloadBlob` runs itself when given no `expectedBytes`
 *  — and `blob` is `/api/files/<id>/blob`. */
export type StoredDownloadPhase = "metadata" | "blob";

/** A stored-download request the server answered with a non-ok status, carrying
 *  that status and the request it belongs to.
 *
 *  Typed because one status means something entirely different from the rest:
 *  404 is "this link points at nothing any more" — the TTL lapsed, another
 *  receiver burned it, or the GC ran between the metadata read and the blob read.
 *  None of that has anything to do with the recipient's key or this file's
 *  integrity, which is what the download page says for an unclassified failure.
 *
 *  The status used to be legible only as text inside a plain Error message, so
 *  the page matched `/\b404\b/` on it. That both under- and over-fires: any
 *  rewording of the message silently turns a real 404 back into "wrong key or
 *  corrupt file", and a genuine decrypt error that happens to mention 404 (an
 *  offset, a byte count) gets excused as a dead link — the one case where the
 *  user should go check their key.
 *
 *  Only 404 carries that meaning. 403/429/503 keep whatever handling they had;
 *  they get a typed error purely so callers stop having to read messages. */
export class StoredDownloadHttpError extends Error {
  constructor(
    public status: number,
    public phase: StoredDownloadPhase,
  ) {
    super(`stored download ${phase} failed: ${status}`);
    this.name = "StoredDownloadHttpError";
  }
}

/** The download's network layer failed (offline, connection dropped mid-stream) —
 *  distinct from a decrypt/integrity failure, so the UI can offer a plain retry
 *  instead of the misleading "wrong key or corrupt file" message. */
export class DownloadNetworkError extends Error {
  constructor(public override cause?: unknown) {
    super("download network error");
    this.name = "DownloadNetworkError";
  }
}

/**
 * Stop here if the caller has cancelled.
 *
 * A `DOMException("aborted", "AbortError")` — the same shape `fetch` rejects
 * with when its own signal fires, and the same one the upload path below throws.
 * One shape, because the alternative is a caller having to recognise
 * "this was cancelled" differently depending on WHICH await noticed first: the
 * request, the stream read, or a check between two writes. A cancellation that
 * arrives looking like a network fault gets offered a retry; one that falls
 * through to a default gets read as a decrypt failure, which in the pre-upload
 * receiver marks every id permanently unretryable. Neither is survivable by a
 * caller that cannot tell what it is holding.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

/** Whether `e` is a cancellation rather than a fault — ours or `fetch`'s.
 *
 *  Matches on `name`, not on `instanceof DOMException`: an AbortError can come
 *  from this module, from `fetch`, or from a `ReadableStream` reader, and the
 *  last of those is not guaranteed to be the same DOMException constructor in
 *  every runtime this ships to. */
export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** Upload progress. The single-shot fallback (`uploadFile`) reports two sequential
 *  phases — in-browser encryption, then the network POST of the assembled blob —
 *  and `total` differs per phase (plaintext size vs. ciphertext blob size). The
 *  chunked path encrypts and uploads at the same time, so it stays in "uploading"
 *  throughout and counts server-confirmed ciphertext bytes against `cipherSize`. */
export interface UploadProgress {
  phase: "encrypting" | "uploading";
  sent: number;
  total: number;
  /**
   * Bytes for this upload have been handed to the network, and what the server
   * did with them is not yet known.
   *
   * Reported once, on the tick immediately before the first PATCH leaves. It is
   * the only thing that lets a caller tell the two failures apart: an upload
   * refused at init sent nothing and changed nothing on the server, while one
   * that failed after this point may have committed a prefix — and for a
   * pre-upload, committed bytes MOVE the pairing room's deadline. A caller that
   * cannot tell them apart has to either understate every failure (announcing a
   * dead code the server is still admitting joins on) or overstate every one.
   *
   * Deliberately not the "uploading" phase itself: that tick is emitted before
   * the first chunk is even encrypted, precisely so a progress bar appears at
   * once, and an encryption that fails before the first PATCH really did send
   * nothing.
   */
  onWire?: boolean;
  /**
   * Where the server says this upload's PAIRING ROOM is joinable until, in unix
   * seconds — absent for every other purpose, and absent from any server too old
   * to answer it.
   *
   * A pair-room upload extends its own room (and the code that names it) with
   * every committed chunk, so this is the only honest source for how long the
   * code on screen has left. Reported from every response that carries it: the
   * append's ack, and the resume probe that recovers a lost one.
   */
  expiresAt?: number;
}

/** Encrypt files in-browser and POST the ciphertext; returns the link parts. */
export async function uploadFile(
  files: File[],
  opts: UploadOptions,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  // Refused here, before a byte is encrypted: POST /api/files rejects
  // purpose=pair_room with 400 by design (a single-shot pre-upload commits once,
  // at the end, so one big enough to be worth doing is big enough to outlive its
  // own room). Sending the whole ciphertext to earn that 400 costs the user real
  // bytes and real time, and this path is also uploadFileResumable's fallback —
  // see the pair-room clause there.
  if (isPairRoom(opts)) throw new Error("pair-room uploads must use the resumable path");
  const sealed = checkedManifest(opts);
  const sk = await generateStoreKey();
  // A caller-sealed document replaces the shared manifest entirely — the
  // Stored-Wire one is not built at all, so a delivery's file names never even
  // reach the shared encoder.
  const encManifest = sealed
    ? await sealManifestBytes(sk.key, sealed)
    : await encryptManifest(sk.key, { files: files.map((f) => ({ name: f.name, size: f.size })) });

  const total = files.reduce((n, f) => n + f.size, 0);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, encManifest.length);
  const parts: BlobPart[] = [header, encManifest];
  let sent = 0;
  for await (const fr of encryptFiles(files, sk.key)) {
    // Honour a cancel mid-encryption (a large multi-file batch) instead of only
    // at the network boundary.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    parts.push(fr);
    sent += fr.length - 4 - 16; // frame = 4-byte len + (plaintext + 16-byte tag)
    onProgress?.({ phase: "encrypting", sent: Math.min(sent, total), total });
  }

  // XHR, not fetch: upload.onprogress gives real byte-level upload progress that
  // fetch cannot surface. The body is the same assembled ciphertext Blob.
  const { id, expiresAt } = await postWithProgress(
    "/api/files" + uploadQuery(opts),
    new Blob(parts),
    signal,
    (loaded, tot) => onProgress?.({ phase: "uploading", sent: loaded, total: tot }),
  );
  // The single-shot endpoint is a trust boundary of its own: on an older server
  // it is the *only* answer, and uploadFileResumable falls back to it. Checked
  // before an UploadResult exists, so no caller — direct or fallback — can be
  // handed one carrying an id this client would refuse to act on.
  return { id: checkedStoredObjectId(id), expiresAt, key: encodeKey(sk.raw) };
}

/** 允许回落到单发路径的最大密文体积。
 *
 *  uploadFile 会把整份密文攒成帧数组再 `new Blob(parts)` 复制一遍，峰值约 2× 密文。
 *  分片路径的峰值是 chunkSize + 一帧（约 8.6 MiB），与文件大小无关 —— 所以"分片失败
 *  就回落"这条既有退路，在单文件上限提到 1 GiB 之后，最坏情况是 ~2 GiB 峰值，手机
 *  标签页必崩。崩掉的标签页比一条错误提示糟得多：用户连"重试"都点不到。
 *
 *  64 MiB 密文 ≈ 128 MiB 峰值，正好是本分支之前就一直在跑的量级（旧上限 50 MiB
 *  明文实测峰值 136 MiB）。也就是说：本来就跑得动的尺寸，退路原样保留；只有这个
 *  分支新放开的大文件才拒绝回落。 */
const FALLBACK_MAX_CIPHER_BYTES = 64 << 20;

/** Resumable upload with a safety net: try the chunked flow, but fall back to
 *  the single-shot uploadFile if the chunked endpoints aren't usable — an older
 *  server without /api/uploads, a storage node without PATCH-append support, or
 *  chunk retries exhausted. A real user/quota error (413/429/401) or an abort is
 *  NOT masked: it propagates. This keeps the rollout from ever regressing an
 *  upload that the single POST would have completed.
 *
 *  The fallback ends where finalize begins. Up to the finalize request nothing
 *  this upload sent can have become an object; from it on, one may exist, and
 *  a single-shot re-send would be a second object, a second debit and a second
 *  upload's traffic for a file the user sent once. Every failure from there is
 *  reported as it is (UploadFinalizeError, UploadError), never retried by
 *  uploading again.
 *
 *  回落有体积闸门：见 FALLBACK_MAX_CIPHER_BYTES。密文超过它就把原始错误原样抛出，
 *  因为单发路径的 2× 峰值会直接把标签页打崩 —— 报错好过崩溃。 */
export async function uploadFileResumable(
  files: File[],
  opts: UploadOptions,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const stage: ChunkedStage = { finalizing: false };
  try {
    return await chunkedUpload(files, opts, onProgress, signal, stage);
  } catch (e) {
    if (signal?.aborted) throw e;
    // The finalize request has been sent: see the doc comment. Checked before
    // everything else below, so no later clause can reopen the fallback.
    if (stage.finalizing) throw e;
    // A pre-upload has no fallback at all. The single-shot route refuses
    // purpose=pair_room, so falling through would re-encrypt and re-send every
    // byte to earn a 400 — and, worse, would replace the status the caller has to
    // act on (409 the peer joined, 410 the room is over, 503 not offered here)
    // with a generic upload failure. Every refusal is reported exactly as the
    // server gave it.
    if (isPairRoom(opts)) throw e;
    // An identifier this client refused is a trust-boundary failure, not a
    // server too old to offer /api/uploads. Stated as its own clause rather
    // than left to the fact that it is not an UploadError, because what must
    // not happen is specific: falling through would re-send every byte down
    // the single-shot path in answer to a response that was already malformed,
    // and there is nothing to retry — the same id would be refused again.
    if (e instanceof InvalidStoredObjectIdError) throw e;
    // A purpose/manifest mismatch is this client refusing itself, not a server
    // too old to offer /api/uploads. The single-shot path applies the identical
    // check, so falling through would only reach the same refusal one layer
    // later — with the caller told the fallback failed instead.
    if (e instanceof ManifestPurposeMismatchError) throw e;
    if (e instanceof UploadError && (e.status === 413 || e.status === 429 || e.status === 401)) throw e;
    if (cipherSizeFor(files) > FALLBACK_MAX_CIPHER_BYTES) throw e;
    return uploadFile(files, opts, onProgress, signal);
  }
}

// 上一次分片上传中「已加密但尚未被服务端确认」的字节数峰值。只给内存回归测试
// 用：它是本次改动（边加密边上传，而不是先把整份密文攒在内存里）的唯一自动守卫。
let bufferPeak = 0;

/** Peak bytes held in the chunked upload's packing buffer during the last run.
 *  Exposed for the memory regression test. */
export function uploadBufferPeak(): number {
  return bufferPeak;
}

/** How far a chunked upload got, read by uploadFileResumable when it fails. */
interface ChunkedStage {
  /** Set immediately before the first finalize request is sent. */
  finalizing: boolean;
}

/** The chunked flow: init → PATCH each chunk (per-chunk retry re-syncing to the
 *  server's committed offset) → finalize. A transient reset loses only the
 *  current chunk, not the whole upload.
 *
 *  加密与上传是**交织**的：帧从 encryptFiles 一边产出一边填进一个固定容量的打包
 *  缓冲区，填满一个 chunk 就 PATCH 出去，服务端确认后立即丢弃。驻留内存约等于
 *  chunkSize + 一帧，与文件大小无关（旧实现把全部密文攒进数组再 new Blob，峰值
 *  约 2× 密文，1 GiB 上传在手机上必 OOM）。 */
async function chunkedUpload(
  files: File[],
  opts: UploadOptions,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
  stage: ChunkedStage = { finalizing: false },
): Promise<UploadResult> {
  const sealed = checkedManifest(opts);
  const sk = await generateStoreKey();
  // See `uploadFile`: a caller-sealed document replaces the shared manifest
  // rather than being merged into it.
  const encManifest = sealed
    ? await sealManifestBytes(sk.key, sealed)
    : await encryptManifest(sk.key, { files: files.map((f) => ({ name: f.name, size: f.size })) });

  // 密文总长可以在加密之前精确算出来 —— 流式之后没有 Blob 可以问 .size，而 init
  // 的 ?size= 需要它（服务端只拿它做提前拒绝，不入库、finalize 不校验）。
  const cipherSize = cipherSizeFor(files);

  // init: hand over the manifest header and the declared ciphertext size.
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, encManifest.length);
  const q = `${uploadQuery(opts)}&size=${cipherSize}`;
  const init = await uploadJSON("POST", "/api/uploads" + q, new Blob([header, encManifest]), signal);
  // The first thing done with the server's answer, and deliberately before a
  // single file byte is encrypted or sent — the encryptFiles generator below is
  // not even constructed yet. uploadId is interpolated into the URL of every
  // PATCH, offset GET and finalize, so an id of `../me` composes a request aimed
  // at an endpoint this upload never authorised. Checking here means those three
  // are only ever reached with an id that is one inert token.
  //
  // Refused, not escaped: see InvalidStoredObjectIdError.
  const uploadId = checkedStoredObjectId(init.uploadId);
  const chunkSize: number = init.chunkSize > 0 ? init.chunkSize : 8 << 20;

  // 打包缓冲：贪婪填到 >= chunkSize 就发。容量留出一整帧的余量，因为最后一帧可能
  // 跨过 chunkSize 的界 —— 上传块边界不需要对齐帧边界，服务端看到的只是不透明
  // 字节流。pending[0, filled) 同时也是**重放缓冲**：它必须保留到服务端确认为止，
  // 因为服务端会提交部分块，重发的起点可能落在块内部。
  const pending = new Uint8Array(chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD);
  let filled = 0; // 已加密未确认的字节数
  let chunkStart = 0; // pending[0] 对应的全局偏移
  let offset = 0; // 服务端已确认的偏移
  bufferPeak = 0;

  // Every server answer that carries a pair-room deadline, forwarded as it
  // arrives rather than kept until finalize: an upload that never gets there is
  // exactly the one whose caller needs it. `offset` is read at call time, so the
  // tick still reports the confirmed position it was published at.
  const noteDeadline = (expiresAt?: number) => {
    if (expiresAt !== undefined) onProgress?.({ phase: "uploading", sent: offset, total: cipherSize, expiresAt });
  };
  // Set once, on the tick before the first PATCH — see UploadProgress.onWire.
  let onWire = false;

  const gen = encryptFiles(files, sk.key);
  try {
    onProgress?.({ phase: "uploading", sent: 0, total: cipherSize });
    while (offset < cipherSize) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      while (filled < chunkSize) {
        const r = await gen.next();
        if (r.done) break;
        // Honour a cancel mid-encryption instead of only at the network boundary.
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        pending.set(r.value, filled);
        filled += r.value.length;
      }
      // 生成器已耗尽却还没喂满声明的 cipherSize —— 公式和实际产出对不上，与其发一个
      // 永远 finalize 不了的截断 blob，不如报错让上层回落到单发路径。
      if (filled === 0) throw new UploadError(0);
      if (filled > bufferPeak) bufferPeak = filled;

      if (!onWire) {
        // The last moment at which "nothing was sent" is still true. Announced
        // here rather than after the request, because the whole point is to
        // cover the request whose answer never comes back.
        onWire = true;
        onProgress?.({ phase: "uploading", sent: offset, total: cipherSize, onWire: true });
      }
      const received = await uploadChunk(uploadId, pending.subarray(0, filled), chunkStart, cipherSize, signal, noteDeadline);
      const consumed = received - chunkStart;
      // 服务端偏移倒退，或者跑到我们根本还没产出的字节之后：两种情况我们都无法再
      // 对齐流位置，继续发只会写出一份错位的密文。
      if (consumed < 0 || consumed > filled) throw new UploadError(0);
      if (consumed < filled) {
        // 部分提交：把没被确认的尾巴挪到缓冲区开头，下一轮从这里接着发。
        pending.copyWithin(0, consumed, filled);
      }
      filled -= consumed;
      chunkStart = received;
      offset = received;
      onProgress?.({ phase: "uploading", sent: offset, total: cipherSize });
    }
    // 主循环靠 offset >= cipherSize 收尾，所以这个守卫是**不对称**保护的另一半：
    //   cipherSizeFor 多报 → 生成器先耗尽 → 上面的 filled === 0 兜住；
    //   cipherSizeFor 少报 → 循环提前退出，剩下的帧永远发不出去，而我们会 finalize
    //                        一份被截断、永远解不开的密文，UI 还显示上传成功。
    // 所以 finalize 之前必须确认生成器真的耗尽了。这一次 next() 会再拉一帧，拿到了
    // 就直接丢弃 —— 此时已经决定回落到单发路径整份重传，这一帧没有用；生成器仍由
    // 下面的 finally 关掉。
    if (!(await gen.next()).done) throw new UploadError(0);
  } finally {
    // 抛错/取消路径上终止生成器，不留悬挂的加密工作。
    await gen.return(undefined).catch(() => {});
  }

  // finalize (small; retried so a flaky moment doesn't waste the whole upload).
  //
  // A PRE-UPLOAD additionally hands over its completion verifier — the sender's
  // half of the capability that lets the receiver, and only the receiver, end this
  // object's life once it has the file (docs/protocol/relayium-pair-room-v1.md).
  // It is derived from the same file key that encrypted the ciphertext, so the
  // server learns nothing it could decrypt with and nothing it could complete
  // with; it can only CHECK a completion somebody else performs.
  //
  // Sent only for a pair-room upload, because it is refused with 400 on any other
  // purpose: a share's life is its TTL and its download count, and there is
  // nothing about it for a receiver to end, and a pair-room finalize keeps
  // exactly the request and the answers it always had.
  //
  // Every other finalize opts in to finalize recovery (finalizeRecovering): its
  // retries are answered from the server's durable record of this upload, so a
  // lost answer comes back as the SAME object rather than as a 409 this client
  // could only guess at. The key that encrypted that object is still `sk`, in
  // this function's memory, so a recovered id is as usable as a first one.
  let fin: { id: unknown; expiresAt: number };
  if (isPairRoom(opts)) {
    const verifier = JSON.stringify({ completionVerifier: encodeKey(await completionVerifier(sk.raw)) });
    stage.finalizing = true;
    fin = await uploadJSON("POST", `/api/uploads/${uploadId}/finalize`, verifier, signal, true);
  } else {
    stage.finalizing = true;
    fin = await finalizeRecovering(uploadId, signal);
  }
  // A second server-chosen id, and not necessarily the one init issued: this is
  // the one the key gets filed under and the /d/<id> the user is handed.
  // Checked before an UploadResult exists.
  return { id: checkedStoredObjectId(fin.id), expiresAt: fin.expiresAt, key: encodeKey(sk.raw) };
}

/** Requests of one finalize that may reach the server without a usable answer —
 *  a network failure, a 5xx, a 2xx whose body cannot be read — before the
 *  outcome is reported `unconfirmed`. Each retry is a recovery read. */
const FINALIZE_ATTEMPTS = 4;
/** "Still being completed" answers followed before giving up as `unconfirmed`.
 *  With the server's Retry-After of 5 s this is about a minute. */
const FINALIZE_RUNNING_POLLS = 12;
const FINALIZE_RETRY_AFTER_DEFAULT_MS = 5_000;
const FINALIZE_RETRY_AFTER_MAX_MS = 30_000;

/** The wait a "running" answer asks for, bounded both ways: a missing or
 *  unreadable Retry-After is the server's default, and no answer can park the
 *  upload for longer than FINALIZE_RETRY_AFTER_MAX_MS. */
function finalizeRetryAfterMs(res: Response): number {
  const raw = res.headers.get("Retry-After");
  const secs = raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(secs)) return FINALIZE_RETRY_AFTER_DEFAULT_MS;
  return Math.min(Math.max(secs * 1000, 1000), FINALIZE_RETRY_AFTER_MAX_MS);
}

/** A finalize answer this client can act on: a 2xx object body that names an
 *  id and an expiry. `null` for anything else — unreadable, truncated, or
 *  missing either field — which is an answer this client did not get.
 *
 *  An id that IS present is returned whatever it holds, for the caller's
 *  checkedStoredObjectId to judge: a server naming an id this client refuses is
 *  a trust-boundary failure, refused once, not an answer to ask for again. */
function finalizedObject(body: unknown): { id: unknown; expiresAt: number } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as { id?: unknown; expiresAt?: unknown };
  if (b.id === undefined || typeof b.expiresAt !== "number" || !Number.isFinite(b.expiresAt)) return null;
  return { id: b.id, expiresAt: b.expiresAt };
}

/** Finalize a share or Device Inbox upload with `{"recoverFinalized":true}`.
 *
 *  Every request is the same opt-in, so the first one is an ordinary finalize
 *  and every repeat is answered from the server's record of this upload:
 *
 *    200 {id, expiresAt[, recovered]}      the object — first or recovered
 *    409 {"outcome":"running"} + Retry-After   another finalize is committing:
 *                                             wait and ask again (bounded)
 *    409 {"outcome":"failed"|"expired"|"removed"}  terminal, as that outcome
 *    409 text / any other 409               a server without recovery: unconfirmed
 *    network failure, 5xx, unreadable 2xx   may have committed: ask again
 *                                             (bounded), then unconfirmed
 *    any other status                       as UploadError(status) if no earlier
 *                                             request can have reached the
 *                                             server and none heard "running",
 *                                             else unconfirmed
 *
 *  It never uploads anything and never gives up into a guess: the only ids it
 *  returns are ones the server named for this upload. */
async function finalizeRecovering(uploadId: string, signal?: AbortSignal): Promise<{ id: unknown; expiresAt: number }> {
  const url = `/api/uploads/${uploadId}/finalize`;
  const body = JSON.stringify({ recoverFinalized: true });
  const abort = () => new DOMException("aborted", "AbortError");
  // Whether an earlier request may have reached the server. Until one has, a
  // definitive refusal is exactly that; after, it may be answering a finalize
  // that already committed.
  let mayHaveCommitted = false;
  let faults = 0;
  let polls = 0;
  const fault = async () => {
    mayHaveCommitted = true;
    if (++faults >= FINALIZE_ATTEMPTS) throw new UploadFinalizeError("unconfirmed");
    await abortableSleep(uploadBackoff(faults), signal);
  };
  for (;;) {
    if (signal?.aborted) throw abort();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "include",
        signal,
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      if (signal?.aborted) throw abort();
      await fault();
      continue;
    }
    if (res.ok) {
      let answer: unknown;
      try {
        answer = await res.json();
      } catch {
        if (signal?.aborted) throw abort();
        answer = undefined; // truncated or not JSON: the object may exist
      }
      const obj = finalizedObject(answer);
      if (obj) return obj;
      await fault();
      continue;
    }
    if (res.status === 409) {
      let outcome: unknown;
      try {
        const b = (await res.json()) as { error?: unknown; outcome?: unknown } | null;
        outcome = b?.error === "already_finalized" ? b.outcome : undefined;
      } catch {
        if (signal?.aborted) throw abort();
        outcome = undefined; // the legacy text 409
      }
      if (outcome === "failed" || outcome === "expired" || outcome === "removed") {
        throw new UploadFinalizeError(outcome);
      }
      // "running" is proof that a finalize of this upload is in flight and may
      // commit before the next request lands, so from here a refusal (401, 404,
      // ...) no longer shows that nothing was stored. Marked before waiting.
      if (outcome === "running") mayHaveCommitted = true;
      if (outcome === "running" && ++polls <= FINALIZE_RUNNING_POLLS) {
        await abortableSleep(finalizeRetryAfterMs(res), signal);
        continue;
      }
      throw new UploadFinalizeError("unconfirmed");
    }
    if (res.status >= 500) {
      await fault();
      continue;
    }
    if (mayHaveCommitted) throw new UploadFinalizeError("unconfirmed");
    throw new UploadError(res.status);
  }
}

/** PATCH `chunk`, which covers ciphertext bytes [start, start+chunk.length), and
 *  return the server's new committed offset. On a network error it re-syncs to
 *  the server's real offset — the server commits whatever bytes landed before the
 *  reset, so that offset can fall *inside* the chunk — and replays from there; a
 *  409 means the server was already ahead — take its offset. Non-2xx (413/429/401)
 *  is fatal.
 *
 *  `note` is handed the pair-room deadline of every answer that carries one —
 *  the ack, the 409, and the resume probe — so a caller hears it even on the
 *  attempts that end in a retry rather than a return. */
async function uploadChunk(
  uploadId: string,
  chunk: Uint8Array,
  start: number,
  total: number,
  signal?: AbortSignal,
  note?: (expiresAt?: number) => void,
): Promise<number> {
  const end = start + chunk.length;
  const maxAttempts = 5;
  let from = start;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api/uploads/${uploadId}`, {
        method: "PATCH",
        credentials: "include",
        signal,
        headers: { "Content-Range": `bytes ${from}-${end - 1}/${total}` },
        body: chunk.subarray(from - start) as Uint8Array<ArrayBuffer>,
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (attempt >= maxAttempts) throw new UploadError(0);
      from = await uploadOffset(uploadId, signal, note).catch(() => from);
      if (from >= end) return from;
      // 服务端偏移退到我们保留的字节之前 —— 那些字节已经丢了，重放不出来。
      if (from < start) throw new UploadError(0);
      await abortableSleep(uploadBackoff(attempt), signal);
      continue;
    }
    if (res.status === 409) {
      const ahead = await res.json(); // server ahead
      note?.(ahead.expiresAt);
      return ahead.received;
    }
    if (!res.ok) throw new UploadError(res.status);
    const acked = await res.json();
    note?.(acked.expiresAt);
    return acked.received;
  }
}

/** GET the server's committed offset for a resuming upload — and, for a
 *  pre-upload, the room deadline the append whose answer was lost had bought. */
async function uploadOffset(
  uploadId: string,
  signal?: AbortSignal,
  note?: (expiresAt?: number) => void,
): Promise<number> {
  const res = await fetch(`/api/uploads/${uploadId}`, { credentials: "include", signal });
  if (!res.ok) throw new UploadError(res.status);
  const out = await res.json();
  note?.(out.expiresAt);
  return out.received;
}

/** Credentialed JSON request; maps a non-2xx to UploadError(status). When
 *  retry is set, a network failure is retried a few times with backoff. */
async function uploadJSON(
  method: string,
  url: string,
  body: BodyInit | undefined,
  signal?: AbortSignal,
  retry = false,
): Promise<any> {
  const maxAttempts = retry ? 4 : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, credentials: "include", body, signal });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (attempt >= maxAttempts) throw new UploadError(0);
      await abortableSleep(uploadBackoff(attempt), signal);
      continue;
    }
    if (!res.ok) throw new UploadError(res.status);
    return res.json();
  }
}

function uploadBackoff(attempt: number): number {
  return Math.min(300 * 2 ** (attempt - 1), 5000);
}

/** `setTimeout` as an awaitable that a cancellation ends immediately, rejecting
 *  with the same AbortError every other await in this module speaks. Shared by
 *  the upload retry loop above and `downloadBlob`'s reconnect backoff below —
 *  a pause is the one place a cancelled transfer would otherwise sit idle for
 *  seconds after the user has left. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** POST a Blob with real upload-progress reporting and AbortSignal support.
 *  Rejects with UploadError(status) on a non-2xx response (status 0 on a network
 *  error) and with an AbortError DOMException when the signal aborts. */
function postWithProgress(
  url: string,
  body: Blob,
  signal: AbortSignal | undefined,
  onUpload: (loaded: number, total: number) => void,
): Promise<{ id: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onUpload(e.loaded, e.total); };
    }
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const r = JSON.parse(xhr.responseText) as { id: string; expiresAt: number };
          resolve({ id: r.id, expiresAt: r.expiresAt });
        } catch {
          reject(new UploadError(xhr.status)); // 2xx but unparseable body
        }
      } else {
        reject(new UploadError(xhr.status));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new UploadError(0)); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("aborted", "AbortError")); };
    xhr.send(body);
  });
}

/** Fetch a stored object's (encrypted) metadata.
 *
 *  Public, and its `id` is whatever the recipient's link said — so the check runs
 *  here, on the way in, with nothing awaited before it: a value Relayium could
 *  never have issued costs the network nothing and tells the server nothing about
 *  what was tried. */
export async function fetchMeta(id: string, signal?: AbortSignal): Promise<StoredFileMeta> {
  return fetchMetaChecked(checkedStoredObjectId(id), signal);
}

/** `fetchMeta` for an id that has ALREADY passed `checkedStoredObjectId`. Private
 *  precisely so that stays true — it exists only so `downloadBlob` can reuse the
 *  one value it checked at its own boundary, instead of re-running a check whose
 *  result is already known (which would read as the real defence while the real
 *  defence sat elsewhere). */
async function fetchMetaChecked(id: string, signal?: AbortSignal): Promise<StoredFileMeta> {
  // A caller that has already cancelled gets no request at all: the metadata
  // read is the FIRST thing a stored download does, so this is the cheapest
  // point at which "the room is over" can cost the server nothing.
  throwIfAborted(signal);
  let res: Response;
  try {
    res = await fetch(`/api/files/${encodeURIComponent(id)}/meta`, { signal });
  } catch (e) {
    // A cancelled request rejects here too, and it is not a network fault: the
    // caller pulled the plug, and telling it the server was unreachable would
    // put a retry in front of a user who has left the room.
    throwIfAborted(signal);
    // Offline, DNS failure, connection refused — the request never reached a
    // server, so there is no status to classify. The blob read has wrapped this
    // as DownloadNetworkError from the start; the metadata read let a bare
    // TypeError escape, and the download page has no way to tell that apart from
    // a decrypt failure. It then says "wrong key or corrupted file" — accusing
    // the recipient's key and this file, when not a byte was fetched and the key
    // was never used. Same wrapper here, so both reads fail the same way.
    throw new DownloadNetworkError(e);
  }
  if (!res.ok) throw new StoredDownloadHttpError(res.status, "metadata");
  return res.json();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Fetch and decrypt one stored object's manifest — the names and sizes it holds.
 *
 * The two halves of "what is in this object?" in one call, so a caller that has
 * an id and a key does not have to know that the manifest arrives base64 inside
 * the metadata document. Fails exactly as its parts do: a refused id costs no
 * request, an unreachable server raises DownloadNetworkError, a non-2xx raises
 * StoredDownloadHttpError, and a key that does not open the manifest throws from
 * decryptManifest — never a partial or guessed file list.
 */
export async function fetchStoredManifest(
  id: string,
  key: CryptoKey,
  signal?: AbortSignal,
): Promise<StoredManifest> {
  const meta = await fetchMetaChecked(checkedStoredObjectId(id), signal);
  return decryptManifest(key, base64ToBytes(meta.encManifest));
}

/** Expected total plaintext length, from the (encrypted) manifest's file sizes.
 *  Used to detect a stream truncated on a frame boundary, which a bare frame
 *  reassembler cannot distinguish from a clean end. */
async function expectedPlaintextBytes(id: string, key: CryptoKey, signal?: AbortSignal): Promise<number> {
  const meta = await fetchMetaChecked(id, signal); // only ever called with downloadBlob's checked id
  const manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
  return manifest.files.reduce((n, f) => n + f.size, 0);
}

/** Where one `downloadBlob` call is in its own recovery: `waiting` is the
 *  backoff pause, `resuming` the continuation request, `streaming` the moment a
 *  verified tail starts landing.
 *
 *  Reported rather than inferred from a gap in `onProgress`: a stalled
 *  connection and a reconnect look identical from outside — no progress in
 *  either — and that difference is what the user is owed. `attempt`/`max` are
 *  the call's GLOBAL budget, so a page showing them cannot promise more tries
 *  than remain. */
export type DownloadRecoveryPhase = "waiting" | "resuming" | "streaming";

export interface DownloadRecovery {
  phase: DownloadRecoveryPhase;
  /** 1-based, monotonic for the life of the call. */
  attempt: number;
  max: number;
  /** Ciphertext bytes safely consumed — diagnostics, never a completion claim. */
  at: number;
}

export interface DownloadBlobOptions {
  onRecovery?: (r: DownloadRecovery) => void;
}

/** Reconnects ONE download may spend. Global to the call and deliberately not
 *  reset by progress: a path that drops every few megabytes would otherwise earn
 *  fresh budget with every megabyte it did deliver, and a big file behind it
 *  would reconnect for as long as the user stayed. */
const RESUME_ATTEMPTS = 4;

/** Delay before the Nth (1-based) attempt: 0.5s doubling to a 4s cap, ~7.5s of
 *  waiting across the whole budget — short enough that the sink stays live
 *  underneath (the service-worker stream's keepalive is 10s) and the page is not
 *  saying "reconnecting" for a minute. */
function resumeBackoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

/** One header, from a real `Response` or anything shaped like one. A response
 *  with no headers at all must read as "said nothing about ranges" — which
 *  disables resume and leaves the old single-GET behaviour exactly as it was —
 *  never as a TypeError thrown mid-download. */
function header(res: Response, name: string): string | null {
  const h = (res as { headers?: Headers }).headers;
  return h?.get(name) ?? null;
}

/** A header as a byte count, or null for anything else. Strict because this
 *  number decides where a resumed request starts and what a complete body is:
 *  `"12, 12"` (a duplicated header), `"1e3"`, a float, a sign or anything past
 *  2^53 is "no trustworthy length", not a number JavaScript happens to coerce. */
function byteCount(v: string | null): number | null {
  if (v === null) return null;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Whether the bytes we read are the bytes the length headers describe. A
 *  non-identity `Content-Encoding` means `fetch` decoded them, so `Content-Length`
 *  counts different bytes and a `Range` would name a different coordinate system.
 *  Relayium's own server never encodes ciphertext, but an intermediary — a proxy,
 *  a VPN client, exactly the population this resume exists for — may. */
function identityBody(res: Response): boolean {
  const e = header(res, "Content-Encoding");
  return e === null || e.trim().toLowerCase() === "identity";
}

/** The object's ciphertext length if THIS response makes continuing it
 *  verifiable, else null. All three conditions come from the response in hand:
 *
 *  - **200**, because a tail is only ever appended to a body that started at 0;
 *  - **`Accept-Ranges: bytes`**, which on this server also separates an
 *    unlimited object from a limited/burn one — those never advertise it, and a
 *    second GET for one SPENDS a download the recipient never asked for. The
 *    header is therefore two checks at once: "this object supports Range" and
 *    "a second GET consumes no download SLOT". Slot only — the server meters
 *    the bytes each request actually egresses against the owner either way, so
 *    a continuation is not free bandwidth. It requests only the missing tail
 *    instead of fetching the whole object again;
 *  - **a trustworthy `Content-Length`**, without which a body that ended early
 *    cannot be told from a complete one. */
function resumableTotal(res: Response): number | null {
  if (res.status !== 200) return null;
  if ((header(res, "Accept-Ranges") ?? "").trim().toLowerCase() !== "bytes") return null;
  if (!identityBody(res)) return null;
  const total = byteCount(header(res, "Content-Length"));
  return total !== null && total > 0 ? total : null;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/** Whether `res` is exactly the tail this download is missing: a 206 starting at
 *  `start` and ending at the last byte of the SAME `total` the first response
 *  advertised, parsed rather than pattern-matched.
 *
 *  Each rejection is a body that must not be appended to plaintext already on
 *  the user's disk: a **200** is the whole object again (an old server, a
 *  limited object, a cache) and would duplicate everything saved; a **different
 *  start** is a tail from elsewhere in the file; a **changed total** is a
 *  different object wearing the same id; a **malformed or re-encoded** response
 *  cannot be verified at all. The frame chain would catch most of it afterwards
 *  — but afterwards is after the sink took bytes. This runs before the body is
 *  read. */
function continuesAt(res: Response, start: number, total: number): boolean {
  if (res.status !== 206) return false;
  if (!identityBody(res)) return false;
  const m = CONTENT_RANGE.exec((header(res, "Content-Range") ?? "").trim());
  if (!m) return false;
  if (byteCount(m[1]) !== start || byteCount(m[3]) !== total || byteCount(m[2]) !== total - 1) return false;
  return byteCount(header(res, "Content-Length")) === total - start;
}

/** Let go of a response body this download will never read — a spent-token 403,
 *  a refused status, a 206 that failed verification. Awaited so the connection is
 *  actually released before the caller sees the outcome, and its own failure
 *  swallowed so it can never replace that outcome. */
async function discard(res: Response): Promise<void> {
  await Promise.resolve(res.body?.cancel?.()).catch(() => {});
}

/** Stream the ciphertext, decrypt chunk-by-chunk, and hand plaintext to onChunk.
 *  The decrypted total is checked against `expectedBytes` (defaulting to the
 *  manifest's summed file sizes) so a truncated download fails instead of being
 *  reported as a complete file.
 *
 *  Public, and its own trust boundary rather than a caller's: `expectedBytes`
 *  lets a caller skip the metadata lookup entirely, so nothing upstream can be
 *  relied on to have looked at `id` first.
 *
 *  ## Interruptions
 *
 *  A dropped connection is continued IN PLACE — same decryptor, same partial
 *  frame, same sink — instead of becoming a failure the user restarts from zero.
 *  A 256 MB link behind a proxy that severs the stream at 118 MB was
 *  unfinishable before: every retry began at byte 0 and met the same wall. What
 *  makes continuing safe:
 *
 *  - **One decryptor.** The AEAD chain is sequential (nonce = frame index) and
 *    may be holding half a frame when the connection dies; a second decryptor
 *    would restart the sequence and drop that half.
 *  - **The offset is ciphertext this call consumed** — counted only once a
 *    network chunk has been fed to the decryptor AND every frame it yielded came
 *    back from the sink. Uncounted bytes are re-delivered by the continuation;
 *    double-counted ones would splice a gap into a file that still passed its
 *    own length check.
 *  - **Only transport interruption is retried**: a failed read, a fetch that
 *    rejects, or an EOF verifiably short of the advertised length. Decrypt
 *    failures, sink failures, cancellation and HTTP statuses are not — two of
 *    them would be actively wrong to repeat.
 *  - **The first request is never replayed**, and no `Range` is sent until a 200
 *    advertised `Accept-Ranges: bytes` — which on this server also means the
 *    object is unlimited, so the extra GET cannot spend a burn/limited download
 *    slot. It is not exempt from metering: the owner is charged for the bytes
 *    every request egresses, which is exactly why the continuation asks for the
 *    tail and nothing already consumed.
 *  - **Nothing is appended before verification**: the 206 must continue at the
 *    exact offset within the same total (`continuesAt`), and no body may deliver
 *    more than that total leaves.
 *  - **The budget is global** and progress never refills it.
 *
 *  Exhausting it — or being interrupted where none of this is verifiable — ends
 *  in DownloadNetworkError: the honest "the network stopped this", never a
 *  completion and never the decrypt failure it is not. `StoreDecryptor.end` is
 *  unchanged and remains the only thing that decides a download succeeded.
 *
 *  `signal` cancels the whole thing, and it is the ONLY way to stop a download
 *  that has started streaming: once the body is live, every remaining chunk is
 *  read, decrypted and handed to `onChunk` by the loop below with no await the
 *  caller can interpose a check on. So the check lives at each point a
 *  cancellation can be observed — before a request, around a read that may
 *  resolve after the signal fired, between two plaintext deliveries, and inside
 *  the backoff, which ends immediately rather than making a user who has left
 *  wait out a reconnect. */
export async function downloadBlob(
  id: string,
  key: CryptoKey,
  onChunk: (pt: Uint8Array) => Promise<void>,
  onProgress?: (received: number) => void,
  expectedBytes?: number,
  signal?: AbortSignal,
  opts?: DownloadBlobOptions,
): Promise<void> {
  // First statement, before the metadata lookup, the blob request and any
  // onChunk/onProgress callback: a refused id must cost zero requests and must
  // never hand a caller a byte or a progress tick it would have to un-report.
  const checked = checkedStoredObjectId(id);
  throwIfAborted(signal);
  const expected = expectedBytes ?? (await expectedPlaintextBytes(checked, key, signal));
  const url = `/api/files/${encodeURIComponent(checked)}/blob`;
  let res: Response;
  // A direct-download 302 hands us a one-shot token, so a request the browser
  // itself replayed (a retried idle connection, say) comes back 403 from the
  // storage node. Nothing has streamed yet, so ask central again for a fresh
  // token — bounded to one extra attempt, since a persistent 403 is a real
  // failure rather than something to spin on.
  for (let attempt = 0; ; attempt++) {
    // The replay is a SECOND request: a room that ended during the first must
    // not be the reason central mints another token.
    throwIfAborted(signal);
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      throwIfAborted(signal); // cancelled, not a transport fault — see fetchMetaChecked
      throw new DownloadNetworkError(e); // offline / DNS / connection refused
    }
    if (res.status !== 403 || attempt > 0) break;
    await discard(res); // the refused body is never read; release it before asking again
  }
  // A response that arrives after the cancellation is not news about the
  // transfer any more, whatever its status.
  throwIfAborted(signal);
  if (!res.ok) {
    await discard(res);
    throw new StoredDownloadHttpError(res.status, "blob");
  }
  if (!res.body) throw new Error("streaming not supported");
  // Decided ONCE, from the response that started this download, and never
  // re-read from a later one: a continuation that changes the terms is what
  // `continuesAt` exists to refuse.
  const total = resumableTotal(res);
  let body: ReadableStream<Uint8Array> = res.body;
  const decryptor = new StoreDecryptor(key);
  let received = 0; // plaintext delivered to the sink
  // Ciphertext fed to the decryptor, drained, and seen through the sink. This is
  // where a continuation must start, so it moves at exactly one place below.
  let consumed = 0;
  let reconnects = 0;
  for (;;) {
    // The fault this body ended with, kept as the cause a failed recovery
    // ultimately reports: the original transport failure, not "the retries ran
    // out". `undefined` means the body ended cleanly.
    let interrupted: unknown;
    let stopped = false;
    let ended = false; // the reader reported done — nothing left to release
    const reader = body.getReader();
    try {
      for (;;) {
        throwIfAborted(signal);
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read(); // a mid-stream drop rejects here — network, not decrypt
        } catch (e) {
          throwIfAborted(signal); // our own abort tearing the stream down
          interrupted = e;
          stopped = true;
          break;
        }
        // Re-checked AFTER the read: the case that matters is the read in flight
        // WHEN the signal fired, resolving afterwards with a chunk whose
        // plaintext is about to reach the user's disk.
        throwIfAborted(signal);
        const { done, value } = chunk;
        if (done) {
          ended = true;
          // The only short end provable here: fewer bytes than the first
          // response advertised. Without that length the stream is left to the
          // authenticated end-of-stream check, which is where a truncation on a
          // frame boundary has always been caught.
          if (total !== null && consumed < total) {
            interrupted = new Error(`ciphertext stream ended at ${consumed} of ${total} bytes`);
            stopped = true;
          }
          break;
        }
        // Before the decryptor, before the sink: a body longer than the length
        // its own headers advertise is a response nothing here can verify, and
        // the authenticated frame chain cannot stand in for that check — an
        // overrun made of otherwise-valid frames decrypts perfectly. Refusing at
        // the boundary keeps `consumed <= total`, which is what makes a clean
        // EOF at `total` mean "complete" rather than "at least complete".
        if (total !== null && consumed + value.length > total) {
          throw new DownloadNetworkError(
            new Error(`ciphertext stream overran its advertised ${total} bytes`),
          );
        }
        for await (const pt of decryptor.push(value)) {
          // One network chunk can carry several frames, so several deliveries —
          // each an await into the caller's sink, and each a place the signal can
          // fire between.
          throwIfAborted(signal);
          await onChunk(pt);
          received += pt.length;
          // Re-checked AFTER the delivery, the longest await here: a cancellation
          // landing inside it resumes to a caller that has torn its surface down,
          // and the progress tick would be a bigger number pushed at a transfer
          // that is over.
          throwIfAborted(signal);
          onProgress?.(received);
        }
        // Only here: the decryptor has taken ALL of these bytes — including the
        // part of a frame it is still holding — and every frame they completed
        // has come back from the sink. Anything that threw above (tamper, a
        // failed write, a cancellation) leaves the chunk uncounted, which is
        // right twice over: none of those are resumed, and a chunk credited
        // without being consumed would start a continuation past bytes the
        // decryptor never saw.
        consumed += value.length;
      }
    } finally {
      // Every exit that leaves bytes in this body: cancellation, a fault, a
      // failed read whose stream is being replaced. A body left open keeps its
      // connection and buffers alive and, on a real one, goes on downloading
      // into nothing. A reader that reached `done` is skipped — there is nothing
      // to release, and cancelling a finished stream is a claim about it we
      // should not make.
      //
      // AWAITED, so "the caller was told" and "the connection is really gone"
      // are not two moments with an unbounded gap between them (a caller that
      // leaves and rejoins could otherwise be streaming twice), and its own
      // failure swallowed so cleanup can never REPLACE the cancellation or fault
      // this run is actually about — an errored reader rejects `cancel()` with
      // the very error we are propagating.
      if (!ended) await Promise.resolve(reader.cancel?.()).catch(() => {});
    }
    if (!stopped) break; // clean EOF at the advertised length, or one nothing here can dispute
    // Not one byte reaches the sink between here and a verified continuation.
    // Each condition is a reason this interruption cannot be continued safely,
    // and all of them end the download as what it is — the network stopped it:
    //   • no verifiable length / `Accept-Ranges` (which also means the object may
    //     be limited or burn-after-read, where a second GET spends a download);
    //   • nothing consumed — that is replaying the first request, not continuing
    //     it, and `bytes=0-` is answered with a 200 anyway;
    //   • already at the advertised end, so there is no tail to ask for.
    if (total === null || consumed === 0 || consumed >= total) {
      throw new DownloadNetworkError(interrupted);
    }
    // The tail's body, not the response: it is the only thing the next round
    // needs, and capturing it where `continuesAt` accepted it keeps "verified"
    // and "read" from drifting apart.
    let tail: ReadableStream<Uint8Array> | null = null;
    // Reconnect, retrying the REQUEST itself within the same budget. A fetch that
    // rejects is the same interruption we are recovering from — the network is
    // still down — so it costs one attempt and waits again, instead of ending a
    // download that had three tries left. The offset never moves: nothing was
    // consumed by an attempt that never produced a body.
    while (tail === null) {
      if (reconnects >= RESUME_ATTEMPTS) throw new DownloadNetworkError(interrupted);
      // Before the first word of "reconnecting": a cancellation that arrived with
      // the interruption must not put a recovery state in front of a user who has
      // left, nor spend a backoff nobody is waiting out.
      throwIfAborted(signal);
      reconnects++;
      const state = { attempt: reconnects, max: RESUME_ATTEMPTS, at: consumed };
      opts?.onRecovery?.({ phase: "waiting", ...state });
      await abortableSleep(resumeBackoff(reconnects), signal); // rejects the moment the signal fires
      throwIfAborted(signal);
      opts?.onRecovery?.({ phase: "resuming", ...state });
      let r: Response;
      try {
        r = await fetch(url, { signal, headers: { Range: `bytes=${consumed}-` } });
      } catch {
        throwIfAborted(signal);
        continue; // still unreachable — spend another attempt at the same offset
      }
      throwIfAborted(signal);
      // A status is reported as itself: the object being gone (404) or a limit
      // coming down (429) means something specific to the user, and burying it in
      // "the download was interrupted" would send them to retry a link that no
      // longer exists. Never retried here — the budget is for dropped
      // connections, not for statuses.
      if (!r.ok) {
        await discard(r);
        throw new StoredDownloadHttpError(r.status, "blob");
      }
      if (!r.body || !continuesAt(r, consumed, total)) {
        await discard(r);
        throw new DownloadNetworkError(interrupted);
      }
      tail = r.body;
    }
    body = tail;
    // Verified and about to be read: the page can stop saying "reconnecting"
    // without waiting for the first frame of it to clear the sink.
    opts?.onRecovery?.({ phase: "streaming", attempt: reconnects, max: RESUME_ATTEMPTS, at: consumed });
  }
  // end() throws on trailing bytes or a length shortfall — an incomplete file
  // must surface as an error, never as a successful download. Unchanged by the
  // reconnects above, deliberately: however many responses the ciphertext
  // arrived in, THIS decides it is complete and authentic.
  for await (const pt of decryptor.end(expected)) {
    throwIfAborted(signal);
    await onChunk(pt);
    received += pt.length;
    throwIfAborted(signal);
    onProgress?.(received);
  }
}

/** Build the shareable download link; key goes only in the fragment. */
export function buildDownloadLink(origin: string, id: string, key: string): string {
  return `${origin}${DOWNLOAD_PREFIX}${id}#k=${key}`;
}

/** Extract the base64url key from a location hash like "#k=...". "" if none. */
export function parseDownloadKey(hash: string): string {
  const m = /^#k=([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1] : "";
}

/** Import a base64url key string into a CryptoKey for decryption. */
export async function keyFromFragment(k: string): Promise<CryptoKey> {
  return importStoreKey(decodeKey(k));
}

/** A proof is 32 bytes, exactly — see store-crypto's `completionProof` and
 *  docs/protocol/relayium-pair-room-v1.md §7.1. A shorter value is not a weaker
 *  credential, it is a malformed one, and the server says so with a 400. */
const COMPLETION_PROOF_BYTES = 32;

/**
 * What a completion attempt settled as. Four outcomes because a caller deciding
 * whether to try again has four genuinely different situations to be in:
 *
 * `completed` — 204. The object is gone; and, identically, there was nothing to
 *   complete (already done, never existed, not a pair-room object). The server
 *   conflates those four on purpose, so that an unauthenticated endpoint is not
 *   an existence oracle, and a caller must conflate them too: in every one of
 *   them there is nothing left to do.
 * `unsupported` — 409. A live pair-room object whose sender predates the
 *   capability, so it carries no verifier at all. Its own outcome because no
 *   proof this receiver can ever derive will work on it: retrying is a loop with
 *   a known end, and calling it a failure would be false as well.
 * `refused` — the server declined, permanently: a wrong proof (403), a
 *   malformed body (400), a route that is not there (an older deployment, or one
 *   with pre-upload off), or any other answer this contract does not define. All
 *   terminal, and none of them a completion.
 * `retry` — nothing was decided: the network failed, the server erred (5xx), or
 *   the per-IP budget is momentarily spent (429). The object is untouched, so a
 *   later attempt is safe — and it is the caller's business how many to make.
 *
 * A CANCELLATION is not in this list, deliberately: it REJECTS with the same
 * AbortError every other call here raises. A caller whose room has ended must
 * stop, and folding that into `retry` would put it back in a queue.
 */
export type CompletionOutcome = "completed" | "unsupported" | "refused" | "retry";

/**
 * The receiver saying "I have this file, you can let it go".
 *
 * POST /api/files/{id}/complete with the proof in the BODY, per
 * docs/protocol/relayium-pair-room-v1.md §7.3. The body is the whole point of the
 * shape: this value is a bearer capability to DELETE an object, and a URL — path
 * or query — is written down by every proxy and access log between here and the
 * server. Nothing here logs one either, and no error this raises carries one.
 *
 * Never called on the strength of bytes having been fetched. Completion is
 * something a receiver SAYS, after its save target has actually taken delivery;
 * this function only performs the saying.
 *
 * Returns rather than throws for every answer the server can give, because
 * "should I try again?" is the only question its caller has and a thrown status
 * makes that a matter of re-classifying an exception. It still THROWS for the
 * two things that are not answers: an id or a proof this client should never
 * have sent, and a cancellation.
 */
export async function completeStoredObject(
  id: string,
  proof: Uint8Array,
  signal?: AbortSignal,
): Promise<CompletionOutcome> {
  // Both checks before the request, and both raising rather than returning: a
  // value Relayium could never have produced costs the network nothing, tells
  // the server nothing about what was tried, and does not spend the per-IP
  // budget that a real completion will need.
  const checked = checkedStoredObjectId(id);
  if (proof.length !== COMPLETION_PROOF_BYTES) {
    throw new Error(`completion proof must be ${COMPLETION_PROOF_BYTES} bytes`);
  }
  // A caller whose room is already over gets no request — and, just as
  // importantly, no `completed` it could record against a room that has ended.
  throwIfAborted(signal);
  let res: Response;
  try {
    res = await fetch(`/api/files/${encodeURIComponent(checked)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof: encodeKey(proof) }),
      signal,
    });
  } catch {
    // A cancelled request rejects here too, and it is not a network fault: the
    // caller pulled the plug. Telling it "retry" would queue an attempt for a
    // room that no longer exists.
    throwIfAborted(signal);
    return "retry";
  }
  if (res.status === 204) return "completed";
  if (res.status === 409) return "unsupported";
  // 429 is a budget that refills and 5xx is a server that may recover; both
  // leave the object exactly where it was, so both are worth another attempt.
  if (res.status === 429 || res.status >= 500) return "retry";
  // Everything else is terminal, INCLUDING a 2xx that is not 204. An answer this
  // contract does not define is most likely not this endpoint at all — a proxy,
  // or an index.html from a deployment where the route is not mounted — and
  // reading one as success would record a completion that never happened.
  return "refused";
}
