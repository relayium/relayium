import { beforeEach, describe, expect, it } from "vitest";
import { rememberUploadKey, uploadKey, forgetUploadKey, pruneUploadKeys } from "./upload-keys";

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
});
