import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadFile,
  uploadFileResumable,
  fetchMeta,
  buildDownloadLink,
  parseDownloadKey,
  downloadBlob,
  UploadError,
} from "./stored-file";
import { generateStoreKey, encryptFiles, encryptManifest } from "./store-crypto";

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

// A fetch double for the resumable upload endpoints. init hands back a small
// chunkSize (forcing multiple chunks), PATCH appends by offset (409 on a gap),
// GET reports the offset, finalize returns id/expiresAt. failPatches makes the
// first N PATCH fetches reject (network error) before letting them through.
function installFakeUploadFetch(opts?: { chunkSize?: number; failPatches?: number }) {
  const state = { received: 0, patches: 0, finalized: false };
  const chunkSize = opts?.chunkSize ?? 8;
  let failsLeft = opts?.failPatches ?? 0;
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
      if (start > state.received) return json({ received: state.received }, 409);
      const buf = new Uint8Array(await (init!.body as Blob).arrayBuffer());
      if (start === state.received) state.received += buf.length;
      return json({ received: state.received });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

describe("uploadFileResumable", () => {
  it("uploads in chunks (init → PATCH×N → finalize) and returns id/key", async () => {
    const state = installFakeUploadFetch({ chunkSize: 8 });
    const file = new File([new Uint8Array(40).fill(7)], "f.bin");
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("id1");
    expect(out.expiresAt).toBe(123);
    expect(out.key).toBeTruthy();
    expect(state.finalized).toBe(true);
    expect(state.patches).toBeGreaterThan(1); // ciphertext split across several chunks
    expect(state.received).toBeGreaterThan(0);
  });

  it("resumes after a mid-upload network error", async () => {
    const state = installFakeUploadFetch({ chunkSize: 8, failPatches: 1 });
    const file = new File([new Uint8Array(40).fill(3)], "f.bin");
    const out = await uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
    expect(out.id).toBe("id1");
    expect(state.finalized).toBe(true);
  });

  it("throws UploadError on a fatal chunk status (e.g. 413)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?"))
        return { ok: true, status: 200, json: async () => ({ uploadId: "u1", chunkSize: 8 }) };
      if (method === "PATCH") return { ok: false, status: 413, json: async () => ({}) };
      throw new Error("unexpected");
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array(40)], "f.bin");
    await expect(uploadFileResumable([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(
      UploadError,
    );
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
