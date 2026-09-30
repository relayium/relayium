import { beforeEach, describe, expect, it } from "vitest";
import { rememberUploadKey, uploadKey, forgetUploadKey, pruneUploadKeys, forgetAllUploadKeys } from "./upload-keys";

describe("upload-keys", () => {
  beforeEach(() => localStorage.clear());

  it("remembers and recovers a key by id", () => {
    rememberUploadKey("id1", "keyA");
    expect(uploadKey("id1")).toBe("keyA");
    expect(uploadKey("missing")).toBeUndefined();
  });

  it("ignores empty id or key", () => {
    rememberUploadKey("", "k");
    rememberUploadKey("id", "");
    expect(uploadKey("")).toBeUndefined();
    expect(uploadKey("id")).toBeUndefined();
  });

  it("overwrites an existing id", () => {
    rememberUploadKey("id1", "keyA");
    rememberUploadKey("id1", "keyB");
    expect(uploadKey("id1")).toBe("keyB");
  });

  it("forgets a single key", () => {
    rememberUploadKey("id1", "keyA");
    rememberUploadKey("id2", "keyB");
    forgetUploadKey("id1");
    expect(uploadKey("id1")).toBeUndefined();
    expect(uploadKey("id2")).toBe("keyB");
  });

  it("prunes keys not in the live set", () => {
    rememberUploadKey("id1", "keyA");
    rememberUploadKey("id2", "keyB");
    rememberUploadKey("id3", "keyC");
    pruneUploadKeys(["id2"]);
    expect(uploadKey("id1")).toBeUndefined();
    expect(uploadKey("id2")).toBe("keyB");
    expect(uploadKey("id3")).toBeUndefined();
  });

  it("survives malformed storage", () => {
    localStorage.setItem("relayium.uploadKeys.v1", "not json");
    expect(uploadKey("id1")).toBeUndefined();
    rememberUploadKey("id1", "keyA"); // recovers by overwriting
    expect(uploadKey("id1")).toBe("keyA");
  });

  // Audit nit (2026-09-28): an unparsable map was replaced by {id1: keyA},
  // destroying every other key in it — and each of those is the only copy.
  it("moves an unreadable map aside instead of overwriting it", () => {
    const corrupt = '{"old1":"keyOld1","old2":"keyOld2"'; // truncated write
    localStorage.setItem("relayium.uploadKeys.v1", corrupt);
    rememberUploadKey("id1", "keyA");
    expect(uploadKey("id1")).toBe("keyA");
    expect(localStorage.getItem("relayium.uploadKeys.v1.corrupt"), "old keys lost").toBe(corrupt);
  });

  it("refuses to write when an earlier, different backup already occupies the slot", () => {
    localStorage.setItem("relayium.uploadKeys.v1.corrupt", "first corruption");
    localStorage.setItem("relayium.uploadKeys.v1", "second corruption");
    rememberUploadKey("id1", "keyA");
    expect(localStorage.getItem("relayium.uploadKeys.v1")).toBe("second corruption");
    expect(localStorage.getItem("relayium.uploadKeys.v1.corrupt")).toBe("first corruption");
    pruneUploadKeys([]);
    forgetUploadKey("x");
    expect(localStorage.getItem("relayium.uploadKeys.v1")).toBe("second corruption");
  });

  it("drops only malformed entries and keeps the good ones", () => {
    localStorage.setItem("relayium.uploadKeys.v1", JSON.stringify({ good: "k1", bad: 42 }));
    rememberUploadKey("id1", "keyA");
    expect(JSON.parse(localStorage.getItem("relayium.uploadKeys.v1")!)).toEqual({ good: "k1", id1: "keyA" });
  });

  it("clears the backup on logout too — it holds key material", () => {
    localStorage.setItem("relayium.uploadKeys.v1", "not json");
    rememberUploadKey("id1", "keyA");
    forgetAllUploadKeys();
    expect(localStorage.getItem("relayium.uploadKeys.v1")).toBeNull();
    expect(localStorage.getItem("relayium.uploadKeys.v1.corrupt")).toBeNull();
  });
});
