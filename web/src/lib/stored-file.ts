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

/** Upload progress. The single-shot fallback (`uploadFile`) reports two sequential
 *  phases — in-browser encryption, then the network POST of the assembled blob —
 *  and `total` differs per phase (plaintext size vs. ciphertext blob size). The
 *  chunked path encrypts and uploads at the same time, so it stays in "uploading"
 *  throughout and counts server-confirmed ciphertext bytes against `cipherSize`. */
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
 *  retries exhausted. A real user/quota error (413/429/401) or an abort is NOT
 *  masked: it propagates. This keeps the rollout from ever regressing an upload
 *  that the single POST would have completed.
 *
 *  回落有体积闸门：见 FALLBACK_MAX_CIPHER_BYTES。密文超过它就把原始错误原样抛出，
 *  因为单发路径的 2× 峰值会直接把标签页打崩 —— 报错好过崩溃。 */
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
  opts: { burnAfterRead: boolean; ttl: number },
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const sk = await generateStoreKey();
  const manifest: StoredManifest = { files: files.map((f) => ({ name: f.name, size: f.size })) };
  const encManifest = await encryptManifest(sk.key, manifest);

  // 密文总长可以在加密之前精确算出来 —— 流式之后没有 Blob 可以问 .size，而 init
  // 的 ?size= 需要它（服务端只拿它做提前拒绝，不入库、finalize 不校验）。
  const cipherSize = cipherSizeFor(files);

  // init: hand over the manifest header and the declared ciphertext size.
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, encManifest.length);
  const q = `?burnAfterRead=${opts.burnAfterRead ? 1 : 0}&ttl=${opts.ttl}&size=${cipherSize}`;
  const init = await uploadJSON("POST", "/api/uploads" + q, new Blob([header, encManifest]), signal);
  const uploadId: string = init.uploadId;
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

      const received = await uploadChunk(uploadId, pending.subarray(0, filled), chunkStart, cipherSize, signal);
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
  const fin = await uploadJSON("POST", `/api/uploads/${uploadId}/finalize`, undefined, signal, true);
  return { id: fin.id, expiresAt: fin.expiresAt, key: encodeKey(sk.raw) };
}

/** PATCH `chunk`, which covers ciphertext bytes [start, start+chunk.length), and
 *  return the server's new committed offset. On a network error it re-syncs to
 *  the server's real offset — the server commits whatever bytes landed before the
 *  reset, so that offset can fall *inside* the chunk — and replays from there; a
 *  409 means the server was already ahead — take its offset. Non-2xx (413/429/401)
 *  is fatal. */
async function uploadChunk(
  uploadId: string,
  chunk: Uint8Array,
  start: number,
  total: number,
  signal?: AbortSignal,
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
      from = await uploadOffset(uploadId, signal).catch(() => from);
      if (from >= end) return from;
      // 服务端偏移退到我们保留的字节之前 —— 那些字节已经丢了，重放不出来。
      if (from < start) throw new UploadError(0);
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
  // A direct-download 302 hands us a one-shot token, so a request the browser
  // itself replayed (a retried idle connection, say) comes back 403 from the
  // storage node. Nothing has been streamed at that point, so just ask central
  // again — it mints a fresh token. Bounded to one extra attempt: a persistent
  // 403 is a real failure, not something to spin on.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`/api/files/${encodeURIComponent(id)}/blob`);
    } catch (e) {
      throw new DownloadNetworkError(e); // fetch rejected — offline / DNS / connection refused
    }
    if (res.status !== 403 || attempt > 0) break;
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
