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
  preuploadDeadline,
  preuploadUnconfirmed,
  preuploadSenderReady,
  type PreuploadDeadline,
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
  /** What the Nth successful finalize (1-based) answers as `expiresAt` — the
   *  room's deadline as the SERVER now sees it. Defaults to a fixed value in
   *  the distant past, which is what every case that is not about the deadline
   *  wants: recorded, but never later than a live mint. */
  finalizeExpiry?: (n: number) => number;
  /** What the Nth PATCH ack (1-based) reports as `expiresAt` — the room's join
   *  deadline as the server now sees it. Returning undefined (and the default,
   *  which is no function at all) says nothing, which is what an ordinary upload
   *  gets and what any server too old to answer it does. */
  patchExpiry?: (n: number) => number | undefined;
  /** What the resume probe (GET) reports as `expiresAt`. */
  statusExpiry?: () => number;
  /** The first N PATCH fetches reject outright — a lost answer, not a status. */
  failPatches?: number;
  /** The resume probe rejects too, so the lost answer stays lost. */
  failStatus?: boolean;
  /** Called on every PATCH, so a test can move the queue mid-upload. */
  onPatch?: (n: number) => void;
  /** Called while the Nth finalize (1-based) is in flight, so a test can move
   *  the ROOM in the one window an abort cannot close: the upload is finished
   *  as far as the server is concerned, and its answer is on its way back. */
  onFinalize?: (n: number) => void;
}

function installFakeServer(opts: FakeOpts = {}) {
  const state = { inits: [] as string[], patches: 0, finalized: 0, maxInFlight: 0, inFlight: 0, probes: 0 };
  let sessions = 0;
  let patchFailsLeft = opts.failPatches ?? 0;
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
      opts.onFinalize?.(state.finalized);
      return json({ id: `obj-${id}`, expiresAt: opts.finalizeExpiry?.(state.finalized) ?? 123 });
    }
    if (method === "GET") {
      state.probes++;
      if (opts.failStatus) throw new TypeError("network");
      const body: Record<string, unknown> = { received: received.get(id) ?? 0 };
      if (opts.statusExpiry) body.expiresAt = opts.statusExpiry();
      return json(body);
    }
    if (patchFailsLeft > 0) {
      patchFailsLeft--;
      throw new TypeError("network");
    }
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
    const ack: Record<string, unknown> = { received: n };
    const exp = opts.patchExpiry?.(state.patches);
    if (exp !== undefined) ack.expiresAt = exp;
    return json(ack);
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

/** Run the driver to a standstill with the capability gate passed explicitly.
 *  The build's own gate is now ON (see the last test in this file); passing it
 *  here keeps every case in this file independent of that announcement. */
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

  it("re-uploads into the new room a file the old room had already finished", async () => {
    // The case the guard above cannot reach, because there the upload was still
    // in flight when the room changed. An upload that COMPLETED is worse: the
    // entry is `uploaded`, so no lane is looking at it any more — the live link
    // skips it and the driver has nothing staged to pick up — while its ref
    // still names ciphertext bound to a room the new code cannot reach. Handed
    // over as it stands, the new peer fetches a 404; not handed over, the file
    // simply never arrives. So the room boundary returns it to the live-link
    // lane, exactly as a failed upload is returned, and the new room uploads it
    // again under its own code.
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await run(); // room A
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u1"]);

    resetPreupload(); // the re-mint boundary
    expect(outboxState(0), "an old room's object is still the outbox's answer").toBe("staged");
    expect(uploadedRefs(), "the old room's refs are still on offer to the new peer").toEqual([]);

    await run("100200"); // room B
    expect(server.inits[1]).toContain("code=100200");
    expect(outboxState(0)).toBe("uploaded");
    // Only the new room's object, and it is a genuinely new one.
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u2"]);
  });

  it("is stranded by a SECOND boundary that lands after its own driver started", async () => {
    // Executed proof of why exactly ONE owner may cross this boundary on a
    // re-mint, and why that owner is the sender.
    //
    // A re-mint is code→code, and on that one roomCode change TWO effects wake:
    // CodePairing's, which calls startPreupload(newCode), and App's room-binding
    // effect. CodePairing.send() has already crossed the boundary synchronously
    // (resetPreupload() before enterRoom), and startPreupload owns the other
    // half — being handed a different code runs leaveRoom itself. So a reset
    // from the second effect has nothing left to release, and if the child ran
    // first it lands INSIDE the new room's first upload: this is what happens.
    const server = installFakeServer({ onPatch: (n) => { if (n === 1) resetPreupload(); } });
    addToOutbox([bigPf("a.bin")]);
    await run("100200");

    // The new room's own upload, aborted by the new room's own reset.
    expect(server.finalized).toBe(0);
    expect(outboxState(0)).toBe("staged");
    expect(uploadedRefs()).toEqual([]);
    // And the driver is gone with the room it was blanked out of: a live code
    // with a staged file uploaded nothing, and only an explicit new call can
    // revive it — which no caller makes, because CodePairing's effect has
    // already run for this roomCode and only wakes if the queue changes.
    expect(server.inits).toHaveLength(1);
    await run("100200");
    expect(server.inits).toHaveLength(2); // had to be started over from nothing
    expect(outboxState(0)).toBe("uploaded");
  });

  it("returns a finished upload to the live link when the code changes under a running pass", async () => {
    // Same boundary reached the other way: nobody calls reset(), the driver is
    // simply told about a different room. Whichever entry point notices first,
    // what the old room uploaded stops being an answer.
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await run();
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u1"]);

    await run("100200");
    expect(server.inits[1]).toContain("code=100200");
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u2"]);
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

// ── the deadline the room is actually on ────────────────────────────────────
//
// The pairing code's on-screen countdown runs from the MINT, and pre-upload
// moves the real deadline: every committed byte pushes the room's join window
// out, and a successful finalize is the server telling this client exactly
// where it landed. That answer is the only authoritative deadline a client ever
// receives without asking (there is no polling and no endpoint for it), so it
// is what the room has to expose.
describe("the deadline a finished pre-upload reports", () => {
  const NOW = () => Math.floor(Date.now() / 1000);

  it("exposes the room's deadline from a successful finalize", async () => {
    const at = NOW() + 300;
    installFakeServer({ finalizeExpiry: () => at });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadDeadline()).toEqual({ code: CODE, expiresAt: at });
  });

  it("has no deadline to report before anything has finished", async () => {
    installFakeServer({ finalizeStatus: 410 });
    addToOutbox([pf("a.bin")]);
    await run();
    // Bytes moved and the room really did extend while they did — but nothing
    // told this client where to, so there is nothing to report. Inventing one
    // here is exactly the fabricated countdown the surface must not show.
    expect(preuploadDeadline()).toBeNull();
  });

  it("moves it out as each later file extends the room, and never back", async () => {
    const base = NOW();
    // The second file lands the room's final window; the third answers with an
    // EARLIER instant than the one already known (a clock that stepped back, a
    // response served from behind). An extension may only ever push out.
    installFakeServer({ finalizeExpiry: (n) => base + [300, 600, 120][n - 1] });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadDeadline()?.expiresAt).toBe(base + 300);

    addToOutbox([pf("b.bin")]);
    await run();
    expect(preuploadDeadline()?.expiresAt).toBe(base + 600);

    addToOutbox([pf("c.bin")]);
    await run();
    expect(preuploadDeadline()?.expiresAt).toBe(base + 600);
  });

  it("does not report a joined room's never-expires answer as a code deadline", async () => {
    // A room somebody has joined has NO expiry at all, and the server says so
    // with math.MaxInt64. The CODE is a different clock: it is extended to the
    // JOIN deadline and never to never (§2), so taking this number would put a
    // 292-billion-year countdown on screen. The last real deadline stands.
    const at = NOW() + 300;
    installFakeServer({ finalizeExpiry: (n) => (n === 1 ? at : 9.223372036854776e18) });
    addToOutbox([pf("a.bin")]);
    await run();
    addToOutbox([pf("b.bin")]);
    await run();
    expect(preuploadDeadline()?.expiresAt).toBe(at);
  });

  it("keeps a real deadline even when this browser's clock is hours behind the server's", async () => {
    // The filter above exists to reject one thing — a joined room's "never" —
    // and it used to do it by comparing against `Date.now() + MAX_JOINABLE`.
    // That reads the server's answer through the BROWSER's clock, and the two
    // are unrelated: a device whose clock is slow, or was set by hand, or came
    // back from a dead battery, is behind by hours and is otherwise working
    // perfectly. Every honest deadline it is sent then looks impossible.
    //
    // What it costs is precisely what this whole feature buys. Discarding the
    // answer leaves the room with no deadline recorded at all, so the card falls
    // back to the mint's five minutes and announces a dead code — while the
    // server's registry goes on admitting the receiver, and the sender is
    // offered a button to burn the rendezvous their files are already in.
    const skew = 9 * 3600; // this browser is nine hours behind the server
    const at = NOW() + skew + 300;
    installFakeServer({ finalizeExpiry: () => at });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadDeadline()).toEqual({ code: CODE, expiresAt: at });
  });

  it("drops it the moment the server says the room is over", async () => {
    // A 410 is the authority, and it outranks every deadline this client was
    // ever given: the window an earlier file bought can still be in the future
    // when the room is voided early (an operator, a deleted account), and a card
    // counting that window down would go on offering a rendezvous whose
    // ciphertext the server has already deleted.
    installFakeServer({ finalizeExpiry: () => NOW() + 300 });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadDeadline()?.expiresAt).toBeGreaterThan(NOW());

    installFakeServer({ finalizeStatus: 410 });
    addToOutbox([pf("b.bin")]);
    await run();
    expect(preuploadNotice()).toBe("expired");
    expect(preuploadDeadline()).toBeNull();
  });

  it("forgets it with the room it belonged to", async () => {
    installFakeServer({ finalizeExpiry: () => NOW() + 300 });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadDeadline()).not.toBeNull();

    resetPreupload();
    // A deadline is one room's fact. Carried across the boundary it would keep
    // a fresh code's card alive on the strength of a code that no longer exists.
    expect(preuploadDeadline()).toBeNull();
  });

  it("never lets a room the user has left set the new room's deadline", async () => {
    // Room A's upload lands AFTER the code changed — the same landing that must
    // not file a key, and the one window an abort cannot close, because the
    // bytes are already in and the answer is on its way back. Its deadline is
    // worth even less than its key: it is the window of digits nobody can join
    // with any more, and here it is the LATER of the two, so a driver that
    // merely took the maximum would pin the new room's card open on it.
    const base = NOW();
    const atNewRoomsFirstByte: (PreuploadDeadline | null)[] = [];
    installFakeServer({
      onFinalize: (n) => { if (n === 1) startPreupload("100200", true); },
      // Room A's file is re-uploaded into room B, so PATCH 2 is the new room's
      // first byte — and the only place the answer is legible. Asserted at the
      // END alone it is invisible: room B's own finalize overwrites whatever
      // room A left, and the stale window would be on screen only in between.
      onPatch: (n) => { if (n === 2) atNewRoomsFirstByte.push(preuploadDeadline()); },
      finalizeExpiry: (n) => base + (n === 1 ? 900 : 300),
    });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(atNewRoomsFirstByte).toEqual([null]);
    expect(preuploadDeadline()).toEqual({ code: "100200", expiresAt: base + 300 });
  });

  it("names the room every progress report belongs to", async () => {
    // Same reason, one state earlier: "an upload is in flight" is only a reason
    // to hold a card open if it is in flight for THAT card's room.
    const seen = new Set<string>();
    installFakeServer({ onPatch: () => { const p = preuploadProgress(); if (p) seen.add(p.code); } });
    addToOutbox([bigPf("a.bin")]);
    await run();
    expect([...seen]).toEqual([CODE]);
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
  it("is ON now that this build can both hand the keys over and receive them", async () => {
    // The gate is this build's own `preupload/1` announcement, and that is not a
    // coincidence dressed up as a rule: the announcement means "I can send frame
    // kind 12", and frame kind 12 is the only way an uploaded object's key ever
    // reaches the receiver. It stayed false for a whole checkpoint because
    // uploading what this client could not hand off is strictly worse than not
    // uploading — the receiver joins, gets no key, and the objects sit in
    // storage until the room's deadline deletes them.
    expect(preuploadSenderReady()).toBe(true);
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await startPreupload(CODE); // the real gate, not the test's override
    expect(server.inits).toHaveLength(1);
    expect(outboxState(0)).toBe("uploaded");
  });

  it("refuses to run at all when the announcement is withdrawn", async () => {
    // The gate is one expression, so withdrawing the capability must stop the
    // uploader too — not leave it producing ciphertext with no way to hand over
    // the keys that open it.
    const server = installFakeServer();
    addToOutbox([pf("a.bin")]);
    await startPreupload(CODE, false);
    expect(server.inits).toHaveLength(0);
    expect(outboxState(0)).toBe("staged");
  });
});

// ── the window a pre-upload leaves behind when it does NOT finish ───────────
//
// Finalize used to be the only response that ever named the room's deadline, so
// a batch that failed after committing chunks left this module with nothing —
// and the card above it fell back to the MINT, counted that down, and announced
// a dead code while the room was still admitting the very receiver the bytes had
// been uploaded for, offering to burn it and mint another.
//
// Two things close that. The append and the resume probe now carry the deadline
// (server side: pairroom_deadline_report_test.go), so the common failure has an
// authoritative answer. And the failure that has none — bytes went up, every
// response was lost — is recorded as exactly that: a room whose window this
// client cannot confirm, which is not the same as a room that is over.
describe("what a failed pre-upload knows about the room's window", () => {
  const NOW = () => Math.floor(Date.now() / 1000);

  it("records the deadline an append reports, without waiting for finalize", async () => {
    const at = NOW() + 300;
    // The upload dies at finalize, which is precisely the case that used to
    // learn nothing at all: chunks had already extended the room, and the only
    // response that named the new window was the one that never came.
    installFakeServer({ patchExpiry: () => at, finalizeStatus: 500 });
    addToOutbox([bigPf("a.bin")]);
    await run();

    expect(outboxState(0), "the file is back on the live link").toBe("staged");
    expect(preuploadDeadline()).toEqual({ code: CODE, expiresAt: at });
    // Doubt survives ALONGSIDE it, and correctly: finalize moves the room too
    // (it records the last byte and re-syncs the code), so a 500 there is one
    // more extension this client was not told the size of. What the deadline
    // buys is a floor to count to; what it does not buy is the right to call
    // the code dead at the end of it.
    expect(preuploadUnconfirmed()).toBe(CODE);
  });

  it("recovers it from the resume probe when an append's answer is lost", async () => {
    // Bytes went up, the ack did not come back — and the probe the client sends
    // to re-sync its offset is carrying the same answer. The ambiguity closes on
    // the first request that succeeds, without waiting for the end.
    const at = NOW() + 420;
    const server = installFakeServer({ failPatches: 1, statusExpiry: () => at });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(server.probes, "the recovery path really ran").toBeGreaterThan(0);
    expect(outboxState(0)).toBe("uploaded");
    expect(preuploadDeadline()).toEqual({ code: CODE, expiresAt: at });
    expect(preuploadUnconfirmed()).toBe("");
  });

  it("marks the window unconfirmed when bytes went up and no answer came back", async () => {
    // THE case. The append may have committed and moved the room; the response
    // and the probe behind it are both gone. There is no number to show and no
    // right to call the code dead — only the fact that this client cannot say.
    installFakeServer({ failPatches: 99, failStatus: true });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(preuploadDeadline(), "nothing authoritative was ever heard").toBeNull();
    expect(preuploadUnconfirmed()).toBe(CODE);
  }, 20_000);

  it("marks it on a status the server answered but that says nothing about the room", async () => {
    // A 500 is an answer, and it is not an answer about the deadline: the append
    // path commits its bytes and extends the room in one transaction, and can
    // still fail afterwards (uploads_resumable.go). Bytes crossed; the window
    // they bought is unknown.
    installFakeServer({ patchStatus: 500 });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(preuploadUnconfirmed()).toBe(CODE);
  });

  it("leaves the window alone when nothing ever reached the wire", async () => {
    // The control. A deployment that does not offer pre-upload refuses at init:
    // no room was opened, no byte was sent, nothing moved — and the mint's own
    // window is still the whole truth. A fix that simply never trusts the mint
    // again passes every case above and fails this one.
    installFakeServer({ initStatus: { 1: 503 } });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(preuploadUnconfirmed()).toBe("");
    expect(preuploadDeadline()).toBeNull();
  });

  it("clears it once a later upload's own deadline lands", async () => {
    // The ambiguous attempt is subsumed: a deadline the server hands back LATER
    // is measured from a byte committed later, so it is at or past anything the
    // lost one could have bought. Certainty replaces doubt rather than joining it.
    //
    // The doubt is made by an abort mid-upload — the user removed the file while
    // its bytes were going up — because that is the one ambiguous ending the
    // driver keeps going after, so the next file's answer really does arrive
    // into a room already in doubt.
    const at = NOW() + 300;
    installFakeServer({
      onPatch: (n) => { if (n === 1) removeFromOutbox(0); },
      patchExpiry: (n) => (n === 1 ? undefined : at),
    });
    addToOutbox([bigPf("gone.bin"), pf("b.bin")]);
    await run();

    expect(outboxState(0), "the second file really did upload").toBe("uploaded");
    expect(preuploadUnconfirmed()).toBe("");
    expect(preuploadDeadline()).toEqual({ code: CODE, expiresAt: at });
  });

  it("takes the server's 410 over a window it could not confirm", async () => {
    installFakeServer({
      onPatch: (n) => { if (n === 1) removeFromOutbox(0); },
      finalizeStatus: 410,
    });
    addToOutbox([bigPf("gone.bin"), pf("b.bin")]);
    await run();

    expect(preuploadNotice()).toBe("expired");
    // The room is over on the server's own word. There is nothing left to be
    // unsure about, and a card that stayed vague here would go on offering a
    // rendezvous whose ciphertext has already been deleted.
    expect(preuploadUnconfirmed()).toBe("");
  });

  it("forgets it with the room it belonged to", async () => {
    installFakeServer({ patchStatus: 500 });
    addToOutbox([pf("a.bin")]);
    await run();
    expect(preuploadUnconfirmed()).toBe(CODE);

    resetPreupload();
    expect(preuploadUnconfirmed()).toBe("");
  });

  it("never lets a room the user has left mark the new room unconfirmed", async () => {
    // Same rule as the deadline's: doubt is one room's fact too. Room A's upload
    // fails after the code has already changed, and the digits on screen now
    // have nothing to do with it.
    installFakeServer({
      patchStatus: 500,
      onPatch: () => startPreupload("100200", true),
    });
    addToOutbox([pf("a.bin")]);
    await run();

    expect(preuploadUnconfirmed()).not.toBe("100200");
  });
});
