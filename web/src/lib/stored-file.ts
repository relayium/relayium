// API wrappers for the zero-knowledge stored-transfer mode. All encryption
// happens here/in store-crypto; the server only ever receives ciphertext.
import {
  generateStoreKey,
  importStoreKey,
  encryptManifest,
  decryptManifest,
  encryptFiles,
  decodeKey,
  encodeKey,
  StoreDecryptor,
  type StoredManifest,
} from "./store-crypto";
import { DOWNLOAD_PREFIX } from "./transfer-link";

export interface UploadResult {
  id: string;
  expiresAt: number;
  key: string; // base64url, belongs in the URL fragment only
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

/** The download's network layer failed (offline, connection dropped mid-stream) —
 *  distinct from a decrypt/integrity failure, so the UI can offer a plain retry
 *  instead of the misleading "wrong key or corrupt file" message. */
export class DownloadNetworkError extends Error {
  constructor(public override cause?: unknown) {
    super("download network error");
    this.name = "DownloadNetworkError";
  }
}

/** Upload progress, split into the two sequential phases so the UI can show real
 *  bytes for each: in-browser encryption, then the network POST of the ciphertext.
 *  `total` differs per phase (plaintext size vs. ciphertext blob size). */
export interface UploadProgress {
  phase: "encrypting" | "uploading";
  sent: number;
  total: number;
}

/** Encrypt files in-browser and POST the ciphertext; returns the link parts. */
export async function uploadFile(
  files: File[],
  opts: { burnAfterRead: boolean; ttl: number },
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const sk = await generateStoreKey();
  const manifest: StoredManifest = { files: files.map((f) => ({ name: f.name, size: f.size })) };
  const encManifest = await encryptManifest(sk.key, manifest);

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
  const query = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}`;
  const { id, expiresAt } = await postWithProgress(
    "/api/files" + query,
    new Blob(parts),
    signal,
    (loaded, tot) => onProgress?.({ phase: "uploading", sent: loaded, total: tot }),
  );
  return { id, expiresAt, key: encodeKey(sk.raw) };
}

/** Resumable upload with a safety net: try the chunked flow, but fall back to
 *  the single-shot uploadFile if the chunked endpoints aren't usable — an older
 *  server without /api/uploads, a storage node without PATCH-append support, or
 *  retries exhausted. A real user/quota error (413/429/401) or an abort is NOT
 *  masked: it propagates. This keeps the rollout from ever regressing an upload
 *  that the single POST would have completed. */
export async function uploadFileResumable(
  files: File[],
  opts: { burnAfterRead: boolean; ttl: number },
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  try {
    return await chunkedUpload(files, opts, onProgress, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof UploadError && (e.status === 413 || e.status === 429 || e.status === 401)) throw e;
    return uploadFile(files, opts, onProgress, signal);
  }
}

/** The chunked flow: init → PATCH each chunk (per-chunk retry re-syncing to the
 *  server's committed offset) → finalize. A transient reset loses only the
 *  current chunk, not the whole upload. */
async function chunkedUpload(
  files: File[],
  opts: { burnAfterRead: boolean; ttl: number },
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const sk = await generateStoreKey();
  const manifest: StoredManifest = { files: files.map((f) => ({ name: f.name, size: f.size })) };
  const encManifest = await encryptManifest(sk.key, manifest);

  const total = files.reduce((n, f) => n + f.size, 0);
  const frames: Uint8Array[] = [];
  let enc = 0;
  for await (const fr of encryptFiles(files, sk.key)) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    frames.push(fr);
    enc += fr.length - 4 - 16; // frame = 4-byte len + (plaintext + 16-byte tag)
    onProgress?.({ phase: "encrypting", sent: Math.min(enc, total), total });
  }
  const cipherBlob = new Blob(frames as BlobPart[]);
  const cipherSize = cipherBlob.size;

  // init: hand over the manifest header and the declared ciphertext size.
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, encManifest.length);
  const q = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}&size=${cipherSize}`;
  const init = await uploadJSON("POST", "/api/uploads" + q, new Blob([header, encManifest]), signal);
  const uploadId: string = init.uploadId;
  const chunkSize: number = init.chunkSize > 0 ? init.chunkSize : 8 << 20;

  // Append chunks, resuming from the server's committed offset on failure.
  let offset = 0;
  onProgress?.({ phase: "uploading", sent: 0, total: cipherSize });
  while (offset < cipherSize) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(offset + chunkSize, cipherSize);
    offset = await uploadChunk(uploadId, cipherBlob, offset, end, cipherSize, signal);
    onProgress?.({ phase: "uploading", sent: offset, total: cipherSize });
  }

  // finalize (small; retried so a flaky moment doesn't waste the whole upload).
  const fin = await uploadJSON("POST", `/api/uploads/${uploadId}/finalize`, undefined, signal, true);
  return { id: fin.id, expiresAt: fin.expiresAt, key: encodeKey(sk.raw) };
}

/** PATCH cipherBlob[start:end], returning the server's new committed offset. On
 *  a network error it re-syncs to the server's real offset (some of the chunk
 *  may have committed before the reset) and retries; a 409 means the server was
 *  already ahead — take its offset. Non-2xx (413/429/401) is fatal. */
async function uploadChunk(
  uploadId: string,
  blob: Blob,
  start: number,
  end: number,
  total: number,
  signal?: AbortSignal,
): Promise<number> {
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
        body: blob.slice(from, end),
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (attempt >= maxAttempts) throw new UploadError(0);
      from = await uploadOffset(uploadId, signal).catch(() => from);
      if (from >= end) return from;
      await uploadSleep(uploadBackoff(attempt), signal);
      continue;
    }
    if (res.status === 409) return (await res.json()).received; // server ahead
    if (!res.ok) throw new UploadError(res.status);
    return (await res.json()).received;
  }
}

/** GET the server's committed offset for a resuming upload. */
async function uploadOffset(uploadId: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`/api/uploads/${uploadId}`, { credentials: "include", signal });
  if (!res.ok) throw new UploadError(res.status);
  return (await res.json()).received;
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
      await uploadSleep(uploadBackoff(attempt), signal);
      continue;
    }
    if (!res.ok) throw new UploadError(res.status);
    return res.json();
  }
}

function uploadBackoff(attempt: number): number {
  return Math.min(300 * 2 ** (attempt - 1), 5000);
}

function uploadSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function fetchMeta(id: string): Promise<StoredFileMeta> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/meta`);
  if (!res.ok) throw new Error(`meta failed: ${res.status}`);
  return res.json();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Expected total plaintext length, from the (encrypted) manifest's file sizes.
 *  Used to detect a stream truncated on a frame boundary, which a bare frame
 *  reassembler cannot distinguish from a clean end. */
async function expectedPlaintextBytes(id: string, key: CryptoKey): Promise<number> {
  const meta = await fetchMeta(id);
  const manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
  return manifest.files.reduce((n, f) => n + f.size, 0);
}

/** Stream the ciphertext, decrypt chunk-by-chunk, and hand plaintext to onChunk.
 *  The decrypted total is checked against `expectedBytes` (defaulting to the
 *  manifest's summed file sizes) so a truncated download fails instead of being
 *  reported as a complete file. */
export async function downloadBlob(
  id: string,
  key: CryptoKey,
  onChunk: (pt: Uint8Array) => Promise<void>,
  onProgress?: (received: number) => void,
  expectedBytes?: number,
): Promise<void> {
  const expected = expectedBytes ?? (await expectedPlaintextBytes(id, key));
  let res: Response;
  try {
    res = await fetch(`/api/files/${encodeURIComponent(id)}/blob`);
  } catch (e) {
    throw new DownloadNetworkError(e); // fetch rejected — offline / DNS / connection refused
  }
  if (!res.ok) throw new Error(`blob failed: ${res.status}`);
  if (!res.body) throw new Error("streaming not supported");
  const decryptor = new StoreDecryptor(key);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read(); // a mid-stream drop rejects here — a network fault, not a decrypt fault
    } catch (e) {
      throw new DownloadNetworkError(e);
    }
    const { done, value } = chunk;
    if (done) break;
    for await (const pt of decryptor.push(value)) {
      await onChunk(pt);
      received += pt.length;
      onProgress?.(received);
    }
  }
  // end() throws on trailing bytes or a length shortfall — an incomplete file
  // must surface as an error, never as a successful download.
  for await (const pt of decryptor.end(expected)) {
    await onChunk(pt);
    received += pt.length;
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
