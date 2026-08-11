import { describe, it, expect } from "vitest";
import { flushSync } from "svelte";
import { trackEffect, trackDerived } from "./effect-probe.svelte";
import {
  outbox,
  stagedCount,
  stagedFiles,
  liveLinkCount,
  uploadedFingerprint,
  liveLinkFiles,
  releaseUploaded,
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
  outboxToken,
  outboxIndexOf,
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

  // An index is only an answer to "where is this file NOW". A pre-upload takes
  // minutes and the user can add or remove files while it runs, so the index the
  // uploader started with is not the index it must mark on completion.
  it("hands out a handle that survives the queue moving underneath it", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    const b = outboxToken(1);
    expect(b).toBeTruthy();
    removeFromOutbox(0); // b.bin is now index 0
    expect(outboxIndexOf(b)).toBe(0);
    addToOutbox([pf("c.bin")]);
    expect(outboxIndexOf(b)).toBe(0);
  });

  it("reports a handle whose entry is gone rather than pointing at its successor", () => {
    // The failure this prevents: an upload finishes, its entry was removed
    // mid-flight, and markUploaded lands on whatever file slid into that index —
    // filing one file's key under another file's row.
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    const a = outboxToken(0);
    removeFromOutbox(0);
    expect(outboxIndexOf(a)).toBe(-1);
    expect(outbox().map((p) => p.file.name)).toEqual(["b.bin"]);
  });

  it("never reuses a handle across a replace or a clear", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    const first = outboxToken(0);
    setOutbox([pf("a.bin")]);
    expect(outboxToken(0)).not.toBe(first);
    expect(outboxIndexOf(first)).toBe(-1);
    const second = outboxToken(0);
    clearOutbox();
    expect(outboxIndexOf(second)).toBe(-1);
    addToOutbox([pf("a.bin")]);
    expect(outboxToken(0)).not.toBe(second);
  });

  it("answers an out-of-range index and an unknown handle without inventing one", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    expect(outboxToken(5)).toBe("");
    expect(outboxToken(-1)).toBe("");
    expect(outboxIndexOf("")).toBe(-1);
    expect(outboxIndexOf("nope")).toBe(-1);
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

/** A stored reference shaped like the real one: a 32-byte key is 43 base64url
 *  characters. Module-scoped so the sections below share it. */
const storedRef = (id: string) => ({ id, key: "k".repeat(43) });

// ── What the live link is still responsible for ─────────────────────────────
//
// Everything here is about ONE distinction: `outbox().length` answers "is the
// queue non-empty", and the send decision needs "is there anything for the live
// link". Once pre-upload can park an entry in `uploading` or `uploaded`, those
// are different questions, and every bug in this section comes from asking the
// first one.
describe("the staged subset", () => {
  it("counts only what takeOutbox would drain", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin"), pf("c.bin")]);
    markUploading(0);
    markUploading(1);
    markUploaded(1, storedRef("obj-b"));
    expect(outbox()).toHaveLength(3);
    expect(stagedCount()).toBe(1);
    expect(stagedFiles().map((p) => p.file.name)).toEqual(["c.bin"]);
    // The contract that makes it usable as a precondition: what it describes is
    // exactly what the drain returns.
    const described = stagedFiles().map((p) => p.file.name);
    expect(takeOutbox().map((p) => p.file.name)).toEqual(described);
  });

  it("is zero while the only entry is uploading, even though the queue is not empty", () => {
    // The empty-batch bug, stated directly. The old precondition
    // (`outbox().length`) passed here, the drain returned [], and the peer was
    // offered a transfer with no files in it.
    clearOutbox();
    addToOutbox([pf("solo.bin")]);
    markUploading(0);
    expect(outbox()).toHaveLength(1);
    expect(stagedCount()).toBe(0);
    expect(stagedFiles()).toEqual([]);
    expect(takeOutbox()).toEqual([]);
  });
});

describe("returning pre-uploaded entries to the live link", () => {
  it("moves every uploaded entry back to staged and reports how many", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin"), pf("c.bin")]);
    for (const i of [0, 1]) { markUploading(i); markUploaded(i, storedRef(`obj-${i}`)); }
    markUploading(2); // still in flight — its bytes are still moving
    expect(releaseUploaded()).toBe(2);
    expect([outboxState(0), outboxState(1), outboxState(2)]).toEqual(["staged", "staged", "uploading"]);
    // The refs go with them: an entry back on the live link has no stored object
    // to hand a key for.
    expect(uploadedRefs()).toEqual([]);
    expect(stagedCount()).toBe(2);
  });

  it("is a no-op, and reports it, when nothing was uploaded", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    expect(releaseUploaded()).toBe(0);
    expect(outboxState(0)).toBe("staged");
  });

  it("keeps each entry's handle, so an upload in flight is not stranded by it", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    const token = outboxToken(0);
    markUploading(0);
    markUploaded(0, storedRef("obj-a"));
    releaseUploaded();
    expect(outboxToken(0)).toBe(token);
    expect(outboxIndexOf(token)).toBe(0);
  });
});

// ── The reactivity that decides whether a released file moves ───────────────
//
// `failUpload` rewrites the STATE array and never touches the file list. Whether
// a reader notices therefore depends on which array it read — and the reader in
// question is App's auto-send effect, whose failure mode is a file that goes
// over neither transport. Executed with a real effect rather than asserted from
// the source, because the source reads identically either way.
describe("a state change with no change to the file list", () => {
  it("wakes a reader of stagedCount when a failed upload returns to the lane", () => {
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploading(0);
    const probe = trackEffect(() => stagedCount());
    flushSync();
    expect(probe.values.at(-1)).toBe(0);

    // The room expired mid-upload (or the upload broke) AFTER the peer joined.
    failUpload(0);
    flushSync();
    expect(probe.values.at(-1)).toBe(1);
    probe.stop();
  });

  it("does NOT wake a reader of outbox().length — the bug this replaced", () => {
    // Kept as an executed control, not a comment: it is the whole reason the
    // precondition had to change. If this ever starts passing on its own, the
    // two readers have become equivalent and this section can go.
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploading(0);
    const probe = trackEffect(() => outbox().length);
    flushSync();
    const before = probe.values.length;

    failUpload(0);
    flushSync();
    expect(probe.values.length).toBe(before); // never re-ran; the file is stranded
    probe.stop();
  });

  it("wakes a reader of uploadedRefs when an upload lands on an already-open link", () => {
    // The other half of the same mechanism: an upload still in flight when the
    // peer joined is allowed to finish, so a NEW stored object appears minutes
    // after the first key handoff. Without this the receiver is never told.
    clearOutbox();
    addToOutbox([pf("a.bin")]);
    markUploading(0);
    const probe = trackEffect(() => uploadedRefs().map((r) => r.id).join(","));
    flushSync();
    expect(probe.values.at(-1)).toBe("");

    markUploaded(0, storedRef("obj-late"));
    flushSync();
    expect(probe.values.at(-1)).toBe("obj-late");
    probe.stop();
  });
});

// ── What the live link owes ONE peer ────────────────────────────────────────
//
// `stagedCount()` answers "what would takeOutbox() return right now". That is
// the right question only for a peer that can be handed keys. For a peer that
// cannot — an older Web build, a native client, the CLI, none of which announce
// `preupload/1` — the already-uploaded entries are ALSO the live link's job,
// because their keys can never be delivered and nothing else will ever drain
// them. Asking the peer-independent question at a peer-specific gate is how a
// fully-uploaded batch reaches an old peer as silence.
describe("the live link's share of the queue, for one peer", () => {
  it("counts uploaded entries only for a peer that cannot be handed keys", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    markUploading(0);
    markUploaded(0, storedRef("obj-a"));
    // Peer speaks preupload/1: the uploaded entry is its own lane's business.
    expect(liveLinkCount(true)).toBe(1);
    expect(liveLinkFiles(true).map((p) => p.file.name)).toEqual(["b.bin"]);
    // Peer does not: nobody else will ever deliver it.
    expect(liveLinkCount(false)).toBe(2);
    expect(liveLinkFiles(false).map((p) => p.file.name)).toEqual(["a.bin", "b.bin"]);
  });

  it("still refuses to describe a batch that is only in flight", () => {
    // An `uploading` entry belongs to NEITHER answer: its bytes are moving, and
    // the protocol lets an upload that was in flight when the peer joined finish.
    // Counting it would hand the peer a batch with no files in it.
    clearOutbox();
    addToOutbox([pf("solo.bin")]);
    markUploading(0);
    expect(liveLinkCount(true)).toBe(0);
    expect(liveLinkCount(false)).toBe(0);
    expect(takeOutbox()).toEqual([]);
  });

  it("is non-zero for an old peer whose whole batch is already uploaded", () => {
    // The reachability bug, stated directly. Every gate read `stagedCount()`,
    // which is 0 here, so the drain that performs the fallback was never
    // reached and the files went over neither transport.
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    for (const i of [0, 1]) { markUploading(i); markUploaded(i, storedRef(`obj-${i}`)); }
    expect(stagedCount()).toBe(0);
    expect(liveLinkCount(false)).toBe(2);
    expect(liveLinkCount(true)).toBe(0);
  });

  it("wakes a reader when the last upload lands and the peer cannot take keys", () => {
    // The second, later edge: the peer is ALREADY here and already known not to
    // speak preupload/1 when an upload that was in flight completes. Nothing
    // about the file list changes, so only a reader of the per-entry state
    // re-runs — and if it does not, that file is stranded exactly as if the
    // fallback did not exist.
    clearOutbox();
    addToOutbox([pf("late.bin")]);
    markUploading(0);
    const probe = trackEffect(() => liveLinkCount(false));
    flushSync();
    expect(probe.values.at(-1)).toBe(0);

    markUploaded(0, storedRef("obj-late"));
    flushSync();
    expect(probe.values.at(-1)).toBe(1);
    probe.stop();
  });

  it("hands each released entry to the live link exactly once", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    for (const i of [0, 1]) { markUploading(i); markUploaded(i, storedRef(`obj-${i}`)); }

    releaseUploaded();
    expect(takeOutbox().map((p) => p.file.name)).toEqual(["a.bin", "b.bin"]);
    // Drained means gone: a second pass for the same peer (a re-render, a second
    // reachable-peer edge) must not produce the same files again.
    expect(releaseUploaded()).toBe(0);
    expect(takeOutbox()).toEqual([]);
    expect(liveLinkCount(false)).toBe(0);
    expect(outbox()).toEqual([]);
  });
});

// ── How often the whole set is re-handed over ───────────────────────────────
//
// The sender re-sends the COMPLETE current set on every (re)established link and
// whenever a new object lands, and the receiver dedupes by id — so an extra
// re-send is harmless but not free: one seal and one DataChannel frame each. The
// reader in App sits behind a $derived, and whether that derived SETTLES is the
// whole difference between "once per new object" and "once per unrelated state
// transition", which over an N-file batch is O(N²) frames saying nothing new.
describe("the uploaded-set fingerprint", () => {
  it("settles, so an unrelated state change does not re-hand the whole set", () => {
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    markUploading(0);
    markUploaded(0, storedRef("obj-a"));
    const probe = trackDerived(() => uploadedFingerprint());
    flushSync();
    const runs = probe.values.length;

    // Three transitions that all rewrite the state array and none of which
    // change which objects are uploaded.
    addToOutbox([pf("c.bin")]);
    markUploading(1);
    flushSync();
    expect(probe.values.length).toBe(runs);

    // And exactly one wake-up when a genuinely new object appears.
    markUploaded(1, storedRef("obj-b"));
    flushSync();
    expect(probe.values.length).toBe(runs + 1);
    expect(probe.values.at(-1)).toBe("obj-a,obj-b,");
    probe.stop();
  });

  it("is what uploadedRefs() cannot be — an executed control", () => {
    // A derived over uploadedRefs() allocates a fresh array every call, so it is
    // never equal to its previous value and wakes its reader on every unrelated
    // transition. Kept as a running test rather than a comment: it is the exact
    // reason the fingerprint exists, and if it ever stops holding, the two are
    // interchangeable and this section can go.
    clearOutbox();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    markUploading(0);
    markUploaded(0, storedRef("obj-a"));
    const probe = trackDerived(() => uploadedRefs());
    flushSync();
    const runs = probe.values.length;

    addToOutbox([pf("c.bin")]);
    flushSync();
    expect(probe.values.length).toBeGreaterThan(runs); // woke for nothing
    probe.stop();
  });
});
