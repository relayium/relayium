import { describe, it, expect, vi, afterEach } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import {
  uploadFile,
  uploadFileResumable,
  fetchMeta,
  buildDownloadLink,
  parseDownloadKey,
  downloadBlob,
  keyFromFragment,
  uploadBufferPeak,
  UploadError,
} from "./stored-file";
import {
  generateStoreKey,
  encryptFiles,
  encryptManifest,
  cipherSizeFor,
  StoreDecryptor,
  STORE_CHUNK_SIZE,
} from "./store-crypto";

// Concatenate Uint8Array parts into a single buffer.
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

afterEach(() => vi.unstubAllGlobals());

// A forced full GC, so a memory measurement reads live bytes instead of whatever
// V8 has not swept yet. Vitest runs without --expose-gc, so unlock it in-process.
function exposeGc(): (() => void) | undefined {
  try {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc") as () => void;
  } catch {
    return undefined;
  }
}

// A minimal XMLHttpRequest double for the upload path — uploadFile POSTs via XHR
// (not fetch) so it can report real upload progress. Captures the sent body and
// open() args, and settles onload/onerror on a microtask from the given config.
interface XHRConfig { status: number; response: string; network: boolean }
function installFakeXHR(cfg: XHRConfig) {
  const captured = { body: null as Blob | null, url: "", method: "", withCredentials: false };
  class FakeXHR {
    withCredentials = false;
    status = 0;
    responseText = "";
    upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(method: string, url: string) { captured.method = method; captured.url = url; }
    send(body: Blob) {
      captured.body = body;
      captured.withCredentials = this.withCredentials;
      queueMicrotask(() => {
        if (cfg.network) { this.onerror?.(); return; }
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
        this.status = cfg.status;
        this.responseText = cfg.response;
        this.onload?.();
      });
    }
    abort() { this.onabort?.(); }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return captured;
}

describe("buildDownloadLink", () => {
  it("puts id in the path and key in the fragment", () => {
    expect(buildDownloadLink("https://relayium.app", "abc", "KEY")).toBe(
      "https://relayium.app/d/abc#k=KEY",
    );
  });
});

describe("parseDownloadKey", () => {
  it("extracts a base64url key from #k=", () => {
    expect(parseDownloadKey("#k=AbC-_123")).toBe("AbC-_123");
  });
  it("returns empty for missing or malformed fragments", () => {
    expect(parseDownloadKey("")).toBe("");
    expect(parseDownloadKey("#t=abc")).toBe("");
    expect(parseDownloadKey("#k=")).toBe("");
  });
});

describe("uploadFile", () => {
  it("POSTs to /api/files with query + credentials and returns id/expiresAt/key", async () => {
    const cap = installFakeXHR({ status: 200, response: JSON.stringify({ id: "file42", expiresAt: 999 }), network: false });
    const file = new File([new Uint8Array([1, 2, 3])], "secret.txt");
    const out = await uploadFile([file], { burnAfterRead: true, ttl: 3600 });
    expect(out.id).toBe("file42");
    expect(out.expiresAt).toBe(999);
    expect(out.key.length).toBeGreaterThan(0);
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("/api/files?burnAfterRead=1&ttl=3600");
    expect(cap.withCredentials).toBe(true);
    expect(cap.body).toBeInstanceOf(Blob);
  });

  it("throws UploadError with the HTTP status on failure", async () => {
    installFakeXHR({ status: 413, response: "", network: false });
    const file = new File([new Uint8Array([1])], "x");
    await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toMatchObject({
      status: 413,
    });
    await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(UploadError);
  });

  it("throws UploadError(0) on a network error", async () => {
    installFakeXHR({ status: 0, response: "", network: true });
    const file = new File([new Uint8Array([1])], "x");
    await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(UploadError);
  });

  it("reports the encrypting phase then the uploading phase", async () => {
    installFakeXHR({ status: 200, response: JSON.stringify({ id: "x", expiresAt: 0 }), network: false });
    const file = new File([new Uint8Array(100)], "data.bin");
    const phases: string[] = [];
    await uploadFile([file], { burnAfterRead: false, ttl: 0 }, (p) => {
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    });
    expect(phases).toEqual(["encrypting", "uploading"]);
  });
});

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await (body as Blob).arrayBuffer());
}

// A fetch double for the resumable upload endpoints. init hands back a chunkSize,
// PATCH appends by offset (409 on a gap, idempotent ack on an overshoot — this
// mirrors uploads_resumable.go), GET reports the offset, finalize returns
// id/expiresAt. It keeps every committed byte so a test can decrypt the assembled
// ciphertext and prove the stream was reassembled correctly.
//   failPatches:    the first N PATCH fetches reject (network error), nothing committed.
//   partialPatches: the first N PATCH fetches commit *half* the body and then reject
//                   — the real server does exactly this (`sess.received = newSize`
//                   even on error), leaving the committed offset inside the chunk.
function installFakeUploadFetch(opts?: { chunkSize?: number; failPatches?: number; partialPatches?: number }) {
  // patchBytes = 实际发出的 PATCH body 字节总数；staleBytes = 其中落在服务端**已经
  // 确认过**的偏移上、被幂等 ack 掉一个字节都没写进去的部分。两者一起是「重放缓冲
  // 有没有退化成整块重发」的直接度量：正确实现续传时先 GET 到真实偏移、只补那一截，
  // staleBytes 恒为 0；退化成从块起点整块重发就会把已确认的半个块再发一遍。
  const state = { received: 0, patches: 0, patchBytes: 0, staleBytes: 0, emptyPatches: 0, finalized: false, committed: [] as Uint8Array[] };
  const chunkSize = opts?.chunkSize ?? 8;
  let failsLeft = opts?.failPatches ?? 0;
  let partialsLeft = opts?.partialPatches ?? 0;
  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize });
    if (method === "POST" && url.endsWith("/finalize")) {
      state.finalized = true;
      return json({ id: "id1", expiresAt: 123 });
    }
    if (method === "GET" && url === "/api/uploads/u1") return json({ received: state.received });
    if (method === "PATCH" && url === "/api/uploads/u1") {
      if (failsLeft > 0) {
        failsLeft--;
        throw new TypeError("network");
      }
      state.patches++;
      const cr = (init!.headers as Record<string, string>)["Content-Range"];
      const start = Number(/bytes (\d+)-/.exec(cr)![1]);
      const buf = await toBytes(init!.body);
      state.patchBytes += buf.length; // 计在分支之前：被幂等 ack 掉的重发同样耗带宽
      // 空 PATCH 是客户端 bug（没有字节可发却还在发），真实服务端也不接受。记下来
      // 并当成致命错误，免得对端一路 ack 0 字节把客户端拖进死循环。
      if (buf.length === 0) {
        state.emptyPatches++;
        return json({}, 500);
      }
      if (start > state.received) return json({ received: state.received }, 409);
      if (start < state.received) {
        // stale start: ack, write nothing. 已确认的字节又被发了一遍 = 纯浪费带宽。
        state.staleBytes += Math.min(buf.length, state.received - start);
        return json({ received: state.received });
      }
      if (partialsLeft > 0 && buf.length > 1) {
        partialsLeft--;
        const half = Math.floor(buf.length / 2);
        state.committed.push(buf.slice(0, half));
        state.received += half;
        throw new TypeError("network"); // connection reset after a partial write
      }
      state.committed.push(buf.slice());
      state.received += buf.length;
      return json({ received: state.received });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

// Decrypt everything the fake server committed and return the plaintext.
async function decryptCommitted(state: { committed: Uint8Array[] }, key: string): Promise<Uint8Array> {
  const dec = new StoreDecryptor(await keyFromFragment(key));
  const out: Uint8Array[] = [];
  for await (const pt of dec.push(concat(state.committed))) out.push(pt);
  for await (const pt of dec.end()) out.push(pt);
  return concat(out);
}

// A plaintext fixture that spans several 192 KiB store chunks, so the ciphertext
// is several frames and really has to be packed into more than one upload chunk.
// 客户端在同一个绝对偏移上必须永远发出同一个字节。任何冲突都说明它把缓冲区里
// 错误位置的字节当成了流的这一段。返回第一个冲突的偏移，没有冲突返回 -1。
function firstInconsistentOffset(sent: { start: number; bytes: Uint8Array }[]): number {
  const seen = new Map<number, number>();
  for (const s of sent) {
    for (let i = 0; i < s.bytes.length; i++) {
      const off = s.start + i;
      const prev = seen.get(off);
      if (prev === undefined) seen.set(off, s.bytes[i]);
      else if (prev !== s.bytes[i]) return off;
    }
  }
  return -1;
}

function multiChunkFixture(chunks = 3): { file: File; bytes: Uint8Array } {
  const bytes = new Uint8Array(STORE_CHUNK_SIZE * (chunks - 1) + 1234);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  return { file: new File([bytes], "f.bin"), bytes };
}

describe("uploadFileResumable", () => {
  it("uploads in chunks (init → PATCH×N → finalize) and returns id/key", async () => {
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024 });
    const { file, bytes } = multiChunkFixture(3);
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("id1");
    expect(out.expiresAt).toBe(123);
    expect(out.key).toBeTruthy();
    expect(state.finalized).toBe(true);
    expect(state.patches).toBeGreaterThan(1); // ciphertext split across several chunks
    // The declared ?size= must match what actually arrived, and the assembled
    // ciphertext must decrypt back to the original bytes.
    expect(state.received).toBe(cipherSizeFor([file]));
    expect(await decryptCommitted(state, out.key)).toEqual(bytes);
  });

  it("declares the exact ciphertext size to init", async () => {
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024 });
    const { file } = multiChunkFixture(2);
    await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    const initCall = (fetch as unknown as { mock: { calls: any[][] } }).mock.calls.find((c) =>
      String(c[0]).startsWith("/api/uploads?"),
    )!;
    expect(String(initCall[0])).toContain(`size=${cipherSizeFor([file])}`);
    expect(state.received).toBe(cipherSizeFor([file]));
  });

  it("resumes after a mid-upload network error", async () => {
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024, failPatches: 1 });
    const { file, bytes } = multiChunkFixture(3);
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("id1");
    expect(state.finalized).toBe(true);
    expect(state.received).toBe(cipherSizeFor([file]));
    expect(await decryptCommitted(state, out.key)).toEqual(bytes);
  });

  it("resumes when the server's committed offset falls inside the chunk", async () => {
    // The server commits whatever landed before the reset, so the offset it
    // reports can be mid-chunk. Streaming means those bytes are no longer
    // re-sliceable from a Blob — the replay buffer has to serve them.
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024, partialPatches: 2 });
    const { file, bytes } = multiChunkFixture(3);
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(state.finalized).toBe(true);
    // 直接断言（放在最前面，别让下面那条间接启发式先炸掉把它遮住）：重放只补服务端
    // 确认之后的那一截。退化成「从块起点整块重发」时 received/解密两条断言照样通过
    // （服务端对 start < received 是幂等 ack，只是白费带宽），所以必须单独盯住实际
    // 发出的字节。
    expect(state.staleBytes).toBe(0); // 已确认的字节一个都不该重发
    // 总量上界：1.0× 是密文本身，多出来的是两次模拟重置时在途丢掉的半个块（真实网络
    // 里也一样收不回来）。整块重发会再多出两个半块，把比值顶到 1.8× 以上。
    expect(state.patchBytes).toBeLessThan(cipherSizeFor([file]) * 1.5);
    // A partial commit really happened at an offset that is not a chunk boundary.
    expect(state.committed.length).toBeGreaterThan(state.patches - 2);
    expect(state.received).toBe(cipherSizeFor([file]));
    expect(await decryptCommitted(state, out.key)).toEqual(bytes);
  });

  it("keeps a single uploading phase — encryption is interleaved, not a phase", async () => {
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024 });
    const { file } = multiChunkFixture(3);
    const phases: string[] = [];
    const sent: number[] = [];
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 }, (p) => {
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      sent.push(p.sent);
      expect(p.total).toBe(cipherSizeFor([file]));
    });
    expect(out.id).toBe("id1");
    expect(phases).toEqual(["uploading"]);
    // Progress counts server-confirmed bytes: monotonic, ending at the full size.
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
    expect(sent[sent.length - 1]).toBe(state.received);
  });

  it("keeps the packing buffer bounded regardless of file size", async () => {
    // 本任务的核心交付：旧实现把全部密文攒进数组再 new Blob，峰值 ≈ 2× 密文。
    // 现在驻留的只有「已加密未确认」的那一段，上界是 chunkSize + 一帧。
    const chunkSize = 256 * 1024;
    const state = installFakeUploadFetch({ chunkSize });
    const bytes = new Uint8Array(STORE_CHUNK_SIZE * 40); // 7.5 MiB，远大于 chunkSize
    const file = new File([bytes], "big.bin");
    await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(state.received).toBe(cipherSizeFor([file]));
    expect(uploadBufferPeak()).toBeLessThanOrEqual(chunkSize + STORE_CHUNK_SIZE + 20);
    expect(uploadBufferPeak()).toBeLessThan(state.received / 4); // 与文件大小无关
  });

  it("falls back to the single POST when /api/uploads is unavailable", async () => {
    // An old server 404s the init endpoint...
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    // ...so the flow falls back to the single-shot XHR POST /api/files.
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const file = new File([new Uint8Array(40)], "f.bin");
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("fid");
    expect(captured.url).toContain("/api/files");
  });

  it("falls back mid-upload with a complete, decryptable single-shot body", async () => {
    // 上一条是在 init 就 404，生成器根本没启动过。这一条才是真正的中途回落：第一个
    // PATCH 成功、第二个 500。回落会**重新加密一遍** —— 如果哪天实现复用了已经被
    // 消费掉一半的生成器，单发 body 会缺掉前面的帧，服务端照收不误，只有下载时才炸。
    // 所以直接把 XHR 的 body 解密出来逐字节比对，而不是只看 id。
    let received = 0;
    let patches = 0;
    let finalized = false;
    const json = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize: 100 * 1024 });
        if (method === "POST" && url.endsWith("/finalize")) {
          finalized = true;
          return json({ id: "id1", expiresAt: 1 });
        }
        if (method === "GET") return json({ received });
        patches++;
        if (patches > 1) return json({}, 500); // 中途翻车，非 413/429/401 → 回落
        received += (await toBytes(init!.body)).length;
        return json({ received });
      }),
    );
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const { file, bytes } = multiChunkFixture(3);

    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("fid");
    expect(patches).toBe(2);
    expect(finalized).toBe(false);
    // body = uint32BE(len(encManifest)) ‖ encManifest ‖ 帧流；帧流必须是完整的原文。
    const body = new Uint8Array(await captured.body!.arrayBuffer());
    const manifestLen = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
    const dec = new StoreDecryptor(await keyFromFragment(out.key));
    const parts: Uint8Array[] = [];
    for await (const pt of dec.push(body.subarray(4 + manifestLen))) parts.push(pt);
    for await (const pt of dec.end()) parts.push(pt);
    expect(concat(parts)).toEqual(bytes);
  });

  it("refuses to fall back to the single POST for a large file", async () => {
    // 单发路径把整份密文攒起来再 new Blob 复制一遍，峰值约 2× 密文。1 GiB 文件回落
    // ≈ 2 GiB 峰值 = 手机标签页直接崩，用户连重试按钮都点不到。所以密文超过阈值时
    // 必须把原始错误抛出去，而不是"好心"回落。
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    // 只伪造 size：cipherSizeFor 只读它，于是不用真的分配几百 MiB 就能走到阈值判断。
    const big = new File([new Uint8Array(40)], "big.bin");
    Object.defineProperty(big, "size", { value: 512 << 20 });

    await expect(uploadFileResumable([big], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(
      UploadError,
    );
    // 关键断言：单发请求根本没发出去。回落发生的话这里会是 "/api/files?..."。
    expect(captured.url).toBe("");
    expect(captured.body).toBeNull();
  });

  it("still falls back for a small file (the size gate must not kill the safety net)", async () => {
    // 上一条的对照组：同样的失败信号，小文件必须继续走既有的回落退路。
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const small = new File([new Uint8Array(4096)], "small.bin");

    const out = await uploadFileResumable([small], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("fid");
    expect(captured.url).toContain("/api/files");
  });

  it("gives up instead of replaying from an offset behind the buffered bytes", async () => {
    // 网络错误后服务端把已确认偏移退到我们保留的字节之前（会话丢失/被重建）。那些
    // 字节已经不在重放缓冲里了：硬发只会把缓冲区里错误位置的字节当成流的这一段发
    // 出去（chunk.subarray(负数) 是从**尾部**取），静默写出一份错位的密文。
    const sent: { start: number; bytes: Uint8Array }[] = [];
    let received = 0;
    let finalized = false;
    let rewound = false;
    const json = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize: 100 * 1024 });
        if (method === "POST" && url.endsWith("/finalize")) {
          finalized = true;
          return json({ id: "id1", expiresAt: 1 });
        }
        if (method === "GET") return json({ received });
        const cr = (init!.headers as Record<string, string>)["Content-Range"];
        const start = Number(/bytes (\d+)-/.exec(cr)![1]);
        const buf = await toBytes(init!.body);
        sent.push({ start, bytes: buf.slice() });
        if (!rewound && start > 0) {
          rewound = true;
          received = 0; // 连接重置，会话连同已收字节一起没了
          throw new TypeError("network");
        }
        received = start + buf.length;
        return json({ received });
      }),
    );
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const { file } = multiChunkFixture(3);

    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    // 直接断言：同一个绝对偏移上，客户端从头到尾只发出过同一个字节。
    expect(firstInconsistentOffset(sent)).toBe(-1);
    // 而且是干净回落到单发 POST，不是硬着头皮 finalize 一份错位的密文。
    expect(out.id).toBe("fid");
    expect(captured.url).toContain("/api/files");
    expect(finalized).toBe(false);
  });

  it("aborts instead of PATCHing nothing when the declared size overshoots", async () => {
    // 一个 .size 撒谎（大于真实内容）的 File —— 文件在上传途中被截断就是这样。
    // cipherSizeFor 按 size 算，实际产出却更少，于是生成器耗尽时 offset 还没到
    // cipherSize。没有守卫的话循环会一直 PATCH 空 body、服务端一直 ack 同一个偏移，
    // 谁也不前进。
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024 });
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const file = new File([new Uint8Array(1234)], "shrunk.bin");
    Object.defineProperty(file, "size", { value: STORE_CHUNK_SIZE * 3 });

    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("fid"); // 干净回落到单发 POST
    expect(state.finalized).toBe(false);
    expect(state.emptyPatches).toBe(0); // 一个空 PATCH 都不该发出去
  });

  it("refuses to finalize when the declared size undershoots the ciphertext", async () => {
    // 反过来：.size 小于真实内容，于是 cipherSizeFor **少报**。主循环靠
    // offset >= cipherSize 收尾，会在生成器还压着后面文件的帧时提前退出 ——
    // 那就 finalize 了一份被截断、永远解不开的密文，而 UI 显示上传成功。
    // 这是唯一一条会**静默损坏数据**的失败模式，必须在 finalize 之前挡住。
    const state = installFakeUploadFetch({ chunkSize: 100 * 1024 });
    const captured = installFakeXHR({ status: 200, response: JSON.stringify({ id: "fid", expiresAt: 9 }), network: false });
    const liar = new File([new Uint8Array(STORE_CHUNK_SIZE)], "liar.bin");
    Object.defineProperty(liar, "size", { value: 1 }); // 声明 1 字节，实际吐出一整帧
    const tail = new File([new Uint8Array(1234)], "tail.bin"); // 它的帧会被落下

    const out = await uploadFileResumable([liar, tail], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("fid"); // 干净回落到单发 POST
    expect(state.finalized).toBe(false); // ← 守卫没了的话这里是 true，且密文解不开
    expect(captured.url).toContain("/api/files");
  });

  it("does not retain the ciphertext — resident bytes stay far below the file size", async () => {
    // 上一条测的是我们自己记的计数器；这条测的是**真实驻留**。旧实现（把每一帧都
    // push 进数组再 new Blob）在这里的 delta 会随文件线性增长，计数器却看不见。
    // 实测（128 MiB 输入，Node 25 / jsdom）：流式 ≈ 31 MiB，攒全部密文 ≈ 149 MiB；
    // 64 MiB 输入时流式仍是 ≈ 31 MiB（与文件大小无关），攒密文降到 ≈ 81 MiB。
    const forceGc = exposeGc();
    expect(forceGc, "需要 gc() 才能读出真实驻留（v8.setFlagsFromString 失败了）").toBeTypeOf("function");
    const arrayBufferBytes = () => {
      forceGc!(); // twice: V8 releases external (ArrayBuffer) memory a sweep late
      forceGc!();
      return process.memoryUsage().arrayBuffers;
    };

    const chunkSize = 8 << 20;
    let peak = 0;
    let received = 0;
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize });
        if (method === "POST" && url.endsWith("/finalize")) return json({ id: "id1", expiresAt: 1 });
        if (method === "PATCH") {
          received += (init!.body as Uint8Array).length;
          peak = Math.max(peak, arrayBufferBytes()); // 密文在途时采样
          return json({ received });
        }
        return json({ received });
      }),
    );

    // 明文必须一直被引用着：如果只让 File 持有它，它在基线之后才被回收，那 128 MiB
    // 的释放会正好抵消掉「攒全部密文」的 128 MiB 增长，测试就永远发现不了回归。
    const plaintext = new Uint8Array(128 << 20);
    const file = new File([plaintext], "big.bin");
    const base = arrayBufferBytes(); // 基线已包含明文与 File 自身持有的副本
    await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(received).toBe(cipherSizeFor([file]));
    expect(plaintext.length).toBe(128 << 20); // 别让它在采样之前变成垃圾
    const residentMiB = (peak - base) / (1 << 20);
    expect(residentMiB, `peak resident ${residentMiB.toFixed(1)} MiB over baseline`).toBeLessThan(64);
  }, 120_000);

  it("throws UploadError on a fatal chunk status (e.g. 413)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?"))
        return { ok: true, status: 200, json: async () => ({ uploadId: "u1", chunkSize: 8 }) };
      if (method === "PATCH") return { ok: false, status: 413, json: async () => ({}) };
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", fetchMock);
    // Several frames' worth, so an un-terminated generator would keep encrypting.
    const { file } = multiChunkFixture(4);
    let slices = 0;
    const realSlice = file.slice.bind(file);
    file.slice = ((...a: Parameters<Blob["slice"]>) => {
      slices++;
      return realSlice(...a);
    }) as Blob["slice"];

    await expect(uploadFileResumable([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(
      UploadError,
    );
    // 注意这条断言证明不了「生成器被 gen.return() 关掉了」：async generator 是拉取式
    // 的，没人调 .next() 它本来就不会继续,所以有没有 gen.return() 这里的结果恒等
    // （删掉整个 finally 全部测试照过）。它只证明抛错路径上没有人在背后继续拉帧。
    const after = slices;
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(slices).toBe(after);
  });
});

describe("fetchMeta", () => {
  it("GETs /api/files/<id>/meta and parses the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ encManifest: "AAAA", size: 10, burnAfterRead: false, expiresAt: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const meta = await fetchMeta("abc");
    expect(meta.size).toBe(10);
    expect(fetchMock).toHaveBeenCalledWith("/api/files/abc/meta");
  });
  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchMeta("gone")).rejects.toThrow("404");
  });
});

describe("downloadBlob", () => {
  it("streams ciphertext, decrypts it, and yields original bytes to onChunk", async () => {
    // Build real ciphertext via store-crypto.
    const sk = await generateStoreKey();
    const original = new Uint8Array(200);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const file = new File([original], "data.bin");

    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const body = concat(frames);

    // Deliver the body split at an arbitrary boundary to exercise frame reassembly.
    const split = Math.floor(body.length / 3);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.slice(0, split));
        controller.enqueue(body.slice(split));
        controller.close();
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, body: stream }),
    );

    const chunks: Uint8Array[] = [];
    const progressValues: number[] = [];
    await downloadBlob(
      "test-id",
      sk.key,
      async (pt) => {
        chunks.push(pt);
      },
      (received) => {
        progressValues.push(received);
      },
      original.length, // expected plaintext length (skips the manifest fetch)
    );

    expect(concat(chunks)).toEqual(original);
    // onProgress must have been called at least once with the total plaintext length.
    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[progressValues.length - 1]).toBe(original.length);
  });

  it("throws on a non-ok response", async () => {
    const sk = await generateStoreKey();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      downloadBlob("gone", sk.key, async () => {}, undefined, 0),
    ).rejects.toThrow("403");
  });

  it("throws when the ciphertext stream is truncated on a frame boundary", async () => {
    // Two full chunks; dropping the second frame entirely leaves a stream that
    // ends cleanly on a frame boundary yet is short of the expected length.
    const sk = await generateStoreKey();
    const original = new Uint8Array(400 * 1024); // 3 chunks at 192 KiB
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const file = new File([original], "data.bin");

    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const truncated = concat(frames.slice(0, frames.length - 1)); // drop last frame

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(truncated);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: stream }));

    await expect(
      downloadBlob("test-id", sk.key, async () => {}, undefined, original.length),
    ).rejects.toThrow(/truncated|mismatch/);
  });

  it("derives the expected length from the manifest when none is passed", async () => {
    const sk = await generateStoreKey();
    const original = new Uint8Array(200);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const file = new File([original], "data.bin");

    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const body = concat(frames);
    const encManifest = await encryptManifest(sk.key, {
      files: [{ name: "data.bin", size: original.length }],
    });

    // Route by URL: /meta returns the encrypted manifest, /blob the frame stream.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/meta")) {
          return { ok: true, json: async () => ({ encManifest: bytesToBase64(encManifest), size: body.length, burnAfterRead: false, expiresAt: 0 }) };
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(body); controller.close(); },
        });
        return { ok: true, body: stream };
      }),
    );

    const chunks: Uint8Array[] = [];
    await downloadBlob("test-id", sk.key, async (pt) => { chunks.push(pt); });
    expect(concat(chunks)).toEqual(original);
  });
});

describe("uploadFile — body wire format", () => {
  it("prefixes the blob with uint32BE(encManifest length) then the manifest ciphertext then the frame stream", async () => {
    const cap = installFakeXHR({ status: 200, response: JSON.stringify({ id: "x", expiresAt: 0 }), network: false });

    const fileBytes = new Uint8Array([10, 20, 30, 40, 50]); // 5 bytes
    const file = new File([fileBytes], "data.bin");
    await uploadFile([file], { burnAfterRead: false, ttl: 0 });

    expect(cap.body).toBeInstanceOf(Blob);
    const buf = await cap.body!.arrayBuffer();
    const view = new DataView(buf);

    // First 4 bytes: uint32BE of the encrypted-manifest ciphertext length.
    const manifestLen = view.getUint32(0);
    // The manifest is AES-256-GCM encrypted JSON; minimum size is 16-byte GCM tag.
    expect(manifestLen).toBeGreaterThan(16);

    // Immediately after the manifest comes the frame stream.
    // Each frame: uint32BE(ct_len) || ct, where ct_len = plaintext + 16 (GCM tag).
    const frameStart = 4 + manifestLen;
    const frameCipherLen = view.getUint32(frameStart);
    expect(frameCipherLen).toBe(fileBytes.length + 16); // 5 plaintext bytes + 16-byte tag

    // Total blob size must be exactly: 4 + manifestLen + 4 + frameCipherLen.
    expect(buf.byteLength).toBe(4 + manifestLen + 4 + frameCipherLen);
  });
});
