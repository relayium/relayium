import { describe, it, expect } from "vitest";
import { outbox, setOutbox, takeOutbox, clearOutbox, addToOutbox, removeFromOutbox } from "./outbox.svelte";

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
