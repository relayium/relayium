import { describe, it, expect } from "vitest";
import {
  outbox,
  setOutbox,
  takeOutbox,
  clearOutbox,
  addToOutbox,
  removeFromOutbox,
  outboxState,
  markUploading,
  markUploaded,
  failUpload,
  uploadedRefs,
} from "./outbox.svelte";

// lastModified is pinned rather than left to default to Date.now(): it is part of
// the dedupe identity, and two helper calls a millisecond apart would otherwise
// look like two different files.
const pf = (name: string, body = "x") => ({ file: new File([body], name, { lastModified: 0 }) });

describe("outbox", () => {
  it("starts empty and holds what was set", () => {
    clearOutbox();
    expect(outbox()).toEqual([]);
    const files = [pf("a.txt"), pf("b.txt")];
    setOutbox(files);
    expect(outbox()).toEqual(files);
  });
  it("take drains atomically", () => {
    const files = [pf("a.txt")];
    setOutbox(files);
    expect(takeOutbox()).toEqual(files);
    expect(outbox()).toEqual([]);
    expect(takeOutbox()).toEqual([]);
  });
  it("clear empties", () => {
    setOutbox([pf("a.txt")]);
    clearOutbox();
    expect(outbox()).toEqual([]);
  });
});

describe("staging inside a room", () => {
  it("appends instead of replacing, so a second pick adds to the batch", () => {
    clearOutbox();
    const first = pf("a.txt");
    addToOutbox([first]);
    const second = pf("b.txt");
    addToOutbox([second]);
    expect(outbox().map((p) => p.file.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("adds onto a batch that arrived from the share sheet", () => {
    // setOutbox stays a replace (share-target / files-first supersede); staging
    // on top of what it left must not clobber it.
    setOutbox([pf("shared.bin")]);
    addToOutbox([pf("picked.bin")]);
    expect(outbox().map((p) => p.file.name)).toEqual(["shared.bin", "picked.bin"]);
  });

  it("ignores a re-pick of the same file rather than queueing it twice", () => {
    clearOutbox();
    addToOutbox([pf("a.txt")]);
    addToOutbox([pf("a.txt")]); // distinct File object, identical identity
    expect(outbox()).toHaveLength(1);
  });

  it("dedupes within one call too", () => {
    clearOutbox();
    addToOutbox([pf("a.txt"), pf("a.txt")]);
    expect(outbox()).toHaveLength(1);
  });

  it("keeps same-named files whose size differs", () => {
    clearOutbox();
    addToOutbox([pf("a.txt", "x")]);
    addToOutbox([pf("a.txt", "much longer body")]);
    expect(outbox()).toHaveLength(2);
  });

  it("removes one entry by index and leaves the order of the rest", () => {
    clearOutbox();
    addToOutbox([pf("a.txt"), pf("b.txt"), pf("c.txt")]);
    removeFromOutbox(1);
    expect(outbox().map((p) => p.file.name)).toEqual(["a.txt", "c.txt"]);
  });

  it("treats an out-of-range remove as a no-op", () => {
    clearOutbox();
    addToOutbox([pf("a.txt")]);
    removeFromOutbox(5);
    removeFromOutbox(-1);
    expect(outbox().map((p) => p.file.name)).toEqual(["a.txt"]);
  });
});

// The seam between the two transports. A file that was pre-uploaded against the
// pairing code must NOT also go over the live link when the peer arrives: that
// is one transfer sent twice, billed twice, and written to the receiver's disk
// from two sources.
describe("per-entry transport state", () => {
  const ref = (id: string) => ({ id, key: "k".repeat(43) });

  it("starts every entry staged, however it arrived", () => {
    clearOutbox();
    setOutbox([pf("shared.bin")]);
    addToOutbox([pf("picked.bin")]);
    expect([outboxState(0), outboxState(1)]).toEqual(["staged", "staged"]);
    expect(uploadedRefs()).toEqual([]);
  });

  it("drains only the staged entries and leaves uploaded ones behind", () => {
    clearOutbox();
    addToOutbox([pf("up.bin"), pf("live.bin"), pf("going.bin")]);
    markUploading(0);
    markUploaded(0, ref("obj-up"));
    markUploading(2);

    expect(takeOutbox().map((p) => p.file.name)).toEqual(["live.bin"]);
    // The uploaded and in-flight entries stay queued, in order, with their state.
    expect(outbox().map((p) => p.file.name)).toEqual(["up.bin", "going.bin"]);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "uploading"]);
    // ...and a second drain cannot pick them up either.
    expect(takeOutbox()).toEqual([]);
    expect(outbox()).toHaveLength(2);
  });

  it("still drains everything when nothing was pre-uploaded", () => {
    clearOutbox();
    const files = [pf("a.txt"), pf("b.txt")];
    setOutbox(files);
    expect(takeOutbox()).toEqual(files);
    expect(outbox()).toEqual([]);
  });

  it("exposes uploaded entries as the handoff set, in queue order", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    markUploading(1);
    markUploaded(1, ref("obj-b"));
    markUploading(0);
    markUploaded(0, ref("obj-a"));
    expect(uploadedRefs()).toEqual([ref("obj-a"), ref("obj-b")]);
  });

  it("returns a failed upload to the live-link path instead of stranding it", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploading(0);
    failUpload(0);
    expect(outboxState(0)).toBe("staged");
    expect(takeOutbox().map((p) => p.file.name)).toEqual(["a.bin"]);
  });

  it("ignores state changes that would resurrect a stale upload", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploaded(0, ref("never-started")); // was never uploading
    expect(outboxState(0)).toBe("staged");
    markUploading(0);
    markUploaded(0, ref("real"));
    markUploading(0); // already uploaded: cannot go backwards
    failUpload(0); // likewise
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs()).toEqual([ref("real")]);
    markUploading(9); // out of range
    expect(outbox()).toHaveLength(1);
  });

  it("keeps state aligned with the queue when an entry is removed", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin"), pf("c.bin")]);
    markUploading(1);
    markUploaded(1, ref("obj-b"));
    removeFromOutbox(0);
    expect(outbox().map((p) => p.file.name)).toEqual(["b.bin", "c.bin"]);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "staged"]);
    expect(uploadedRefs()).toEqual([ref("obj-b")]);
  });

  it("resets state when the queue is replaced or cleared", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploading(0);
    markUploaded(0, ref("obj-a"));
    setOutbox([pf("fresh.bin")]);
    expect(outboxState(0)).toBe("staged");
    expect(uploadedRefs()).toEqual([]);
    markUploading(0);
    clearOutbox();
    expect(uploadedRefs()).toEqual([]);
    expect(outboxState(0)).toBe("staged");
  });
});
