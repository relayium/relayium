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
