import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadFile,
  fetchMeta,
  buildDownloadLink,
  parseDownloadKey,
  UploadError,
} from "./stored-file";

afterEach(() => vi.unstubAllGlobals());

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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "file42", expiresAt: 999 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "secret.txt");
    const out = await uploadFile([file], { burnAfterRead: true, ttl: 3600 });
    expect(out.id).toBe("file42");
    expect(out.expiresAt).toBe(999);
    expect(out.key.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/files?burnAfterRead=1&ttl=3600");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.body).toBeInstanceOf(Blob);
  });

  it("throws UploadError with the HTTP status on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413 }));
    const file = new File([new Uint8Array([1])], "x");
    await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toMatchObject({
      status: 413,
    });
    await expect(uploadFile([file], { burnAfterRead: false, ttl: 0 })).rejects.toBeInstanceOf(UploadError);
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
