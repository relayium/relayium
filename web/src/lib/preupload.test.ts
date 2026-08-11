// The sender half of pre-upload: what actually drives ciphertext up against a
// pairing code while its room waits, and what it does with each of the room
// lifecycle's four refusals.
//
// Driven against a fake SERVER rather than a fake uploader: the statuses are the
// whole subject (409 stop, 410 fall back, 403/503 stay quiet), and a stubbed
// upload function would let this file pass while the real request carried the
// wrong query or swallowed the status.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startPreupload,
  holdPreupload,
  resetPreupload,
  preuploadNotice,
  preuploadProgress,
  preuploadSenderReady,
} from "./preupload.svelte";
import {
  outbox,
  outboxState,
  outboxToken,
  addToOutbox,
  removeFromOutbox,
  clearOutbox,
  takeOutbox,
  uploadedRefs,
} from "./outbox.svelte";

const CODE = "483920";

const pf = (name: string, bytes = 8) => ({
  file: new File([new Uint8Array(bytes)], name, { lastModified: 0 }),
});

/** A file whose ciphertext spans several store frames, so its upload takes more
 *  than one PATCH and a test can act while it is in flight. */
const bigPf = (name: string) => pf(name, 300 * 1024);

interface FakeOpts {
  /** Status to answer the Nth init (1-based) with, instead of opening a session. */
  initStatus?: Record<number, number>;
  /** Status to answer a PATCH with, once `patchAfter` of them have been served. */
  patchStatus?: number;
  patchAfter?: number;
  finalizeStatus?: number;
  /** Called on every PATCH, so a test can move the queue mid-upload. */
  onPatch?: (n: number) => void;
}

function installFakeServer(opts: FakeOpts = {}) {
  const state = { inits: [] as string[], patches: 0, finalized: 0, maxInFlight: 0, inFlight: 0 };
  let sessions = 0;
  const received = new Map<string, number>();
  const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.startsWith("/api/uploads?")) {
      state.inits.push(url);
      const forced = opts.initStatus?.[state.inits.length];
      if (forced) return json({}, forced);
      const id = `u${++sessions}`;
      received.set(id, 0);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      return json({ uploadId: id, chunkSize: 1024 });
    }
    const m = /^\/api\/uploads\/(u\d+)(\/finalize)?$/.exec(url);
    if (!m) throw new Error(`unexpected ${method} ${url}`);
    const id = m[1];
    if (m[2]) {
      state.inFlight--;
      if (opts.finalizeStatus) return json({}, opts.finalizeStatus);
      state.finalized++;
      return json({ id: `obj-${id}`, expiresAt: 123 });
    }
    if (method === "GET") return json({ received: received.get(id) ?? 0 });
    state.patches++;
    opts.onPatch?.(state.patches);
    if (opts.patchStatus && state.patches > (opts.patchAfter ?? 0)) {
      state.inFlight--;
      return json({}, opts.patchStatus);
    }
    const body = new Uint8Array(await (init!.body as Blob | Uint8Array as Blob).arrayBuffer?.() ??
      (init!.body as Uint8Array));
    const n = (received.get(id) ?? 0) + (body as Uint8Array).length;
    received.set(id, n);
    return json({ received: n });
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

/** Run the driver to a standstill with the capability gate forced on — this
 *  build cannot hand the keys over yet (see the last test in this file), which
 *  is the ONLY reason the gate exists. */
const run = (code = CODE) => startPreupload(code, true);

beforeEach(() => {
  clearOutbox();
  resetPreupload();
});

afterEach(() => {
  resetPreupload();
  clearOutbox();
  vi.unstubAllGlobals();
});

describe("driving staged files up against the pairing code", () => {
  it("uploads one object per file, one at a time, and records each key", async () => {
    const server = installFakeServer();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await run();

    expect(server.inits).toHaveLength(2);
    for (const url of server.inits) expect(url).toContain(`code=${CODE}`);
    expect(server.maxInFlight).toBe(1); // never two open sessions for one room
    expect(server.finalized).toBe(2);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "uploaded"]);
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u1", "obj-u2"]);
    for (const r of uploadedRefs()) expect(r.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing is left for the live link, and nothing was sent twice.
    expect(takeOutbox()).toEqual([]);
  });

  it("picks up a file staged while an earlier one was still uploading", async () => {
    const server = installFakeServer({ onPatch: (n) => { if (n === 1) addToOutbox([pf("late.bin")]); } });
    addToOutbox([bigPf("first.bin")]);
    await run();
    expect(server.inits).toHaveLength(2);
    expect(outbox().map((p) => p.file.name)).toEqual(["first.bin", "late.bin"]);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "uploaded"]);
  });

  it("reports progress against the entry it belongs to, and clears it at the end", async () => {
    const seen: { token: string; sent: number; total: number }[] = [];
    const server = installFakeServer({ onPatch: () => { const p = preuploadProgress(); if (p) seen.push(p); } });
    addToOutbox([bigPf("a.bin")]);
    const token = outboxToken(0);
    await run();
    expect(server.patches).toBeGreaterThan(1);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(p.token).toBe(token);
      expect(p.total).toBeGreaterThan(0);
      expect(p.sent).toBeLessThanOrEqual(p.total);
    }
    expect(preuploadProgress()).toBeNull();
  });

  it("does not run a second driver for the same room", async () => {
    const server = installFakeServer();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await Promise.all([run(), run()]);
    expect(server.inits).toHaveLength(2); // two files, not four
    expect(server.maxInFlight).toBe(1);
  });

  it("starts working for a new room even while the old room's pass is winding down", async () => {
    // The room can change mid-pass: minting a fresh code resets the driver and
    // then immediately asks it to work for the new one. A guard that handed the
    // caller the OLD pass — which is about to notice its room is gone and stop —
    // would leave the new room with no driver at all, and nothing would start it
    // again until the user happened to stage another file.
    const server = installFakeServer();
    addToOutbox([bigPf("a.bin"), pf("b.bin")]);
    const first = run();
    resetPreupload(); // aborts the upload in flight, as a re-mint does
    await run("100200");
    await first;

    expect(server.inits.filter((u) => u.includes("code=100200"))).not.toHaveLength(0);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "uploaded"]);
  });

  it("never files a key from a room the user has already left", async () => {
    // An upload that lands after the room changed belongs to the OLD room: its
    // ciphertext dies on that room's deadline, so filing its key against the
    // entry would promise the new peer a fetch that 404s. The entry goes back to
    // staged — and is then legitimately uploaded again, into the new room.
    const server = installFakeServer({ onPatch: (n) => { if (n === 1) startPreupload("100200", true); } });
    addToOutbox([bigPf("a.bin")]);
    await run();

    expect(server.inits[0]).toContain(`code=${CODE}`);
    expect(server.inits[1]).toContain("code=100200");
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u2"]); // never obj-u1
    expect(outboxState(0)).toBe("uploaded");
  });

  it("refuses to start without a code, rather than uploading into nothing", async () => {
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await startPreupload("", true);
    expect(server.inits).toHaveLength(0);
    expect(outboxState(0)).toBe("staged");
  });
});

describe("409 — the other device already joined", () => {
  it("starts no further upload and leaves the rest for the live link", async () => {
    const server = installFakeServer({ initStatus: { 2: 409 } });
    addToOutbox([pf("a.bin"), pf("b.bin"), pf("c.bin")]);
    await run();

    expect(server.inits).toHaveLength(2); // a.bin, then the refused b.bin — never c.bin
    expect(outboxState(0)).toBe("uploaded");
    // The refused file is NOT stranded in `uploading`: the live link is the
    // answer to "the peer is already here".
    expect([outboxState(1), outboxState(2)]).toEqual(["staged", "staged"]);
    expect(takeOutbox().map((p) => p.file.name)).toEqual(["b.bin", "c.bin"]);
    // Nothing to explain: this is the ordinary path, and the transfer starts by
    // itself over the link.
    expect(preuploadNotice()).toBe("");
  });

  it("lets an upload already in flight finish when the join is observed locally", async () => {
    // The protocol allows exactly this: only a NEW init is refused with 409, and
    // aborting the running one would throw away bytes the sender has already paid
    // for and already billed.
    const server = installFakeServer({ onPatch: (n) => { if (n === 1) holdPreupload(CODE); } });
    addToOutbox([bigPf("running.bin"), pf("next.bin")]);
    await run();

    expect(server.inits).toHaveLength(1);
    expect(server.finalized).toBe(1);
    expect(outboxState(0)).toBe("uploaded");
    expect(outboxState(1)).toBe("staged");
  });

  it("keeps the join's hold across a restart of the same room", async () => {
    // The waiting surface unmounts on join and can come back (an ended link
    // returns the user to it). Re-entering the SAME room must not start
    // uploading again: the room is joined for good, and every init would be a
    // 409 the sender already knows the answer to.
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await run();
    holdPreupload(CODE);
    addToOutbox([pf("b.bin")]);
    await run();
    expect(server.inits).toHaveLength(1);
    expect(outboxState(1)).toBe("staged");
  });

  it("lets a NEW code start uploading again after a previous room's join", async () => {
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    holdPreupload(CODE);
    await run("100200");
    expect(server.inits).toHaveLength(1);
    expect(outboxState(0)).toBe("uploaded");
  });

  it("ignores a hold that names a different room", async () => {
    // The surface for one room can be torn down after the next room's has
    // started — an unscoped hold would then stop a driver that has nothing to do
    // with the join that caused it, and no later call would clear it, because
    // the room is already the active one.
    const server = installFakeServer();
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    const first = run();
    holdPreupload("100200"); // a stale surface for some other code
    await first;
    expect(server.inits).toHaveLength(2);
    expect([outboxState(0), outboxState(1)]).toEqual(["uploaded", "uploaded"]);
  });
});

describe("410 — the room's deadline passed while uploading", () => {
  const expectReturnedToLiveLink = (server: { inits: string[] }) => {
    expect(outboxState(0)).toBe("staged");
    expect(takeOutbox().map((p) => p.file.name)).toEqual(["a.bin", "b.bin"]);
    expect(server.inits).toHaveLength(1); // the room is over: nothing else is tried
    expect(preuploadNotice()).toBe("expired");
  };

  it("returns the file to the live-link lane when a PATCH is refused", async () => {
    const server = installFakeServer({ patchStatus: 410, patchAfter: 1 });
    addToOutbox([bigPf("a.bin"), pf("b.bin")]);
    await run();
    expectReturnedToLiveLink(server);
  });

  it("returns the file to the live-link lane when finalize is refused", async () => {
    const server = installFakeServer({ finalizeStatus: 410 });
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await run();
    expectReturnedToLiveLink(server);
  });

  it("treats the 404 of an upload the void already reclaimed the same way", async () => {
    // Once the room's void has claimed the session and dropped its blob there is
    // no upload left to speak about, so the server says 404 rather than 410. It
    // is the same terminal fact for this file.
    const server = installFakeServer({ patchStatus: 404, patchAfter: 1 });
    addToOutbox([bigPf("a.bin"), pf("b.bin")]);
    await run();
    expectReturnedToLiveLink(server);
  });

  it("clears the explanation when a fresh code starts uploading again", async () => {
    installFakeServer({ finalizeStatus: 410 });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadNotice()).toBe("expired");

    resetPreupload();
    installFakeServer();
    await run("100200");
    expect(preuploadNotice()).toBe("");
    expect(outboxState(0)).toBe("uploaded");
  });
});

describe("refusals the user must not be told a story about", () => {
  it("stays silent and leaves everything staged when the deployment offers no pre-upload", async () => {
    const server = installFakeServer({ initStatus: { 1: 503 } });
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await run();
    expect(server.inits).toHaveLength(1); // asked once, took the answer
    expect([outboxState(0), outboxState(1)]).toEqual(["staged", "staged"]);
    expect(preuploadNotice()).toBe("");
    expect(takeOutbox()).toHaveLength(2); // the live link is untouched
  });

  it("stays silent when the code is not live or not ours (403)", async () => {
    // 403 is also what a code minted on another instance answers, and that code
    // is perfectly joinable — so "your code expired" would be a lie.
    const server = installFakeServer({ initStatus: { 1: 403 } });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(server.inits).toHaveLength(1);
    expect(outboxState(0)).toBe("staged");
    expect(preuploadNotice()).toBe("");
  });

  it("stays silent and stops when the account is out of quota (429)", async () => {
    const server = installFakeServer({ initStatus: { 1: 429 } });
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await run();
    expect(server.inits).toHaveLength(1);
    expect([outboxState(0), outboxState(1)]).toEqual(["staged", "staged"]);
    expect(preuploadNotice()).toBe("");
  });

  it("returns the file to the live link and stops after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    addToOutbox([pf("a.bin"), pf("b.bin")]);
    await run();
    expect([outboxState(0), outboxState(1)]).toEqual(["staged", "staged"]);
    expect(preuploadNotice()).toBe("");
    expect(takeOutbox()).toHaveLength(2);
  });
});

describe("the queue moving underneath a running upload", () => {
  it("abandons an upload whose file the user removed, without filing its key elsewhere", async () => {
    // The bug this pins: markUploaded by the index the upload STARTED with, after
    // that index came to hold a different file — one file's stored key filed
    // under another file's row, and the removed file's bytes paid for nothing.
    const server = installFakeServer({ onPatch: (n) => { if (n === 1) removeFromOutbox(0); } });
    addToOutbox([bigPf("removed.bin"), pf("kept.bin")]);
    await run();

    expect(outbox().map((p) => p.file.name)).toEqual(["kept.bin"]);
    expect(outboxState(0)).toBe("uploaded");
    // Exactly one object exists: the removed file's upload was abandoned, not
    // finalized and filed against its successor.
    expect(uploadedRefs()).toHaveLength(1);
    expect(server.finalized).toBe(1);
  });

  it("completes an upload whose entry slid to a different index", async () => {
    // The concrete stranding this prevents. Remove a file that sits BEFORE the
    // uploading one and every later index shifts down by one. A driver that
    // marked completion by the index it started from would address an entry that
    // is merely `staged`, the outbox would refuse the transition, and the file
    // that really did upload would sit in `uploading` for good — drained by
    // neither the live link (takeOutbox skips it) nor the handoff (it has no
    // stored ref). One file, lost from both lanes, with no error anywhere.
    // first.bin uploads on PATCH 1; moves.bin is in flight from PATCH 2 on, and
    // that is when the entry ahead of it disappears.
    installFakeServer({ onPatch: (n) => { if (n === 2) removeFromOutbox(0); } });
    addToOutbox([pf("first.bin"), bigPf("moves.bin")]);
    await run();

    expect(outbox().map((p) => p.file.name)).toEqual(["moves.bin"]);
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs()).toHaveLength(1);
    expect(takeOutbox()).toEqual([]);
  });

  it("cannot have the live link take the file it is uploading", async () => {
    // The join drains the outbox over the live link (App's auto-send effect).
    // The file whose ciphertext is in flight must not be in that drain — that is
    // one transfer sent twice, billed twice, and written to the receiver's disk
    // from two sources — and it must not be lost from both lanes either.
    let drained: string[] = [];
    installFakeServer({
      onPatch: (n) => {
        if (n !== 1) return;
        holdPreupload(CODE); // the peer joined
        drained = takeOutbox().map((p) => p.file.name);
      },
    });
    addToOutbox([bigPf("inflight.bin"), pf("live.bin")]);
    await run();

    expect(drained).toEqual(["live.bin"]);
    expect(outbox().map((p) => p.file.name)).toEqual(["inflight.bin"]);
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs()).toHaveLength(1);
    expect(takeOutbox()).toEqual([]); // and a second drain still cannot reach it
  });

  it("survives the whole queue being cleared mid-upload", async () => {
    installFakeServer({ onPatch: (n) => { if (n === 1) clearOutbox(); } });
    addToOutbox([bigPf("a.bin")]);
    await expect(run()).resolves.toBeUndefined();
    expect(outbox()).toEqual([]);
    expect(uploadedRefs()).toEqual([]);
  });
});

describe("files a stored object cannot carry faithfully", () => {
  it("leaves a folder's files on the live link and pre-uploads the flat ones", async () => {
    // The stored manifest carries names and sizes only — there is no field for a
    // relative path — so a pre-uploaded folder would arrive flattened, while the
    // live link reproduces it. Slower and right beats faster and wrong; the rest
    // of the batch is unaffected.
    const server = installFakeServer();
    addToOutbox([
      { file: new File([new Uint8Array(8)], "a.txt", { lastModified: 0 }), path: "docs/a.txt" },
      pf("flat.bin"),
    ]);
    await run();

    expect(server.inits).toHaveLength(1);
    expect([outboxState(0), outboxState(1)]).toEqual(["staged", "uploaded"]);
    expect(takeOutbox().map((p) => p.file.name)).toEqual(["a.txt"]);
  });

  it("does not spin on a folder entry it decided to skip", async () => {
    const server = installFakeServer();
    addToOutbox([
      { file: new File([new Uint8Array(8)], "a.txt", { lastModified: 0 }), path: "docs/a.txt" },
    ]);
    await run();
    expect(server.inits).toHaveLength(0);
    expect(outboxState(0)).toBe("staged");
  });
});

describe("the capability gate", () => {
  it("is OFF in this build, because the sender cannot hand the keys over yet", async () => {
    // Pre-uploading what this client cannot then hand off is worse than not
    // pre-uploading: the receiver joins, gets no key for those objects, and the
    // files sit in storage until the room's deadline deletes them. The gate is
    // this build's own `preupload/1` announcement, so the checkpoint that wires
    // frame kind 10 turns the sender on by announcing it — and nothing else can.
    expect(preuploadSenderReady()).toBe(false);
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await startPreupload(CODE); // the real gate, not the test's override
    expect(server.inits).toHaveLength(0);
    expect(outboxState(0)).toBe("staged");
  });
});
