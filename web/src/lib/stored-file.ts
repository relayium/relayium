// API wrappers for the zero-knowledge stored-transfer mode. All encryption
// happens here/in store-crypto; the server only ever receives ciphertext.
import {
  generateStoreKey,
  importStoreKey,
  encryptManifest,
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

/** Encrypt files in-browser and POST the ciphertext; returns the link parts. */
export async function uploadFile(
  files: File[],
  opts: { burnAfterRead: boolean; ttl: number },
  onProgress?: (sent: number, total: number) => void,
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
    parts.push(fr);
    sent += fr.length - 4 - 16; // frame = 4-byte len + (plaintext + 16-byte tag)
    onProgress?.(Math.min(sent, total), total);
  }

  const query = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}`;
  const res = await fetch("/api/files" + query, {
    method: "POST",
    credentials: "include",
    body: new Blob(parts),
  });
  if (!res.ok) throw new UploadError(res.status);
  const { id, expiresAt } = (await res.json()) as { id: string; expiresAt: number };
  return { id, expiresAt, key: encodeKey(sk.raw) };
}

export async function fetchMeta(id: string): Promise<StoredFileMeta> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/meta`);
  if (!res.ok) throw new Error(`meta failed: ${res.status}`);
  return res.json();
}

/** Stream the ciphertext, decrypt chunk-by-chunk, and hand plaintext to onChunk. */
export async function downloadBlob(
  id: string,
  key: CryptoKey,
  onChunk: (pt: Uint8Array) => Promise<void>,
  onProgress?: (received: number) => void,
): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/blob`);
  if (!res.ok) throw new Error(`blob failed: ${res.status}`);
  if (!res.body) throw new Error("streaming not supported");
  const decryptor = new StoreDecryptor(key);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for await (const pt of decryptor.push(value)) {
      await onChunk(pt);
      received += pt.length;
      onProgress?.(received);
    }
  }
  for await (const pt of decryptor.end()) {
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
