// The ordering this module exists for, executed rather than described.
//
// Reproduced in a real browser first (Chromium, RELAYIUM_ENABLE_PREUPLOAD=true):
// an authenticated sender minted a code, staged one file, and finalized it as a
// pair-room object BEFORE anybody joined. A fresh anonymous CURRENT build then
// joined and announced the ordinary current capabilities. The receiver was shown
// the ordinary live file card, wrote the 42 plaintext bytes, and both sides said
// Sent/Received — no `/meta`, no `/blob`, no completion, and the finalized object
// still sitting in storage with no delete intent against it.
//
// Nothing was flaky about that. The roster frame and the capability hello are two
// different messages and the roster always wins: `onPeers` sets the peer list and
// broadcasts OUR capabilities in one synchronous handler, while the peer's hello
// is produced by the peer's own `onPeers` and has to cross peer → server → us. So
// the send gate — which runs in the effect flush that same roster change
// schedules — has always asked its question one round trip too early, and a
// boolean `peerSupportsPreupload` answered `undefined` as "no".
//
// These tests drive the REAL stores (outbox, peer-caps) through a REAL Svelte
// effect standing in for App's auto-send effect, and step the sequence frame by
// frame in the order the browser produced it. A source-text guard could not have
// caught this: every expression involved was exactly the one it was supposed to
// be, and the bug was entirely in when the answer was available.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushSync } from "svelte";
import { trackEffect } from "./effect-probe.svelte";
import {
  CAPS_SETTLE_MS,
  drainFor,
  handoffLane,
  handoffOwed,
  liveLinkFor,
  noteRosterPeers,
  notePeerCaps,
  peerTakesKeys,
  pendingCountFor,
  pendingFilesFor,
  resetHandoffLanes,
} from "./handoff-lane.svelte";
import { CAP_LINK, CAP_PREUPLOAD, CAP_TEXT, recordPeerCaps, resetPeerCaps, retainPeers } from "./peer-caps.svelte";
import {
  addToOutbox,
  clearOutbox,
  markUploaded,
  markUploading,
  outbox,
  outboxState,
  setOutbox,
  uploadedRefs,
} from "./outbox.svelte";
import type { PickedFile } from "./drag";

const PEER = "peer-joined";
/** 32 zero bytes, base64url and unpadded — what the stored-wire key encoding
 *  accepts and what a finalize really hands back. */
const KEY = "A".repeat(43);

const pf = (name: string): PickedFile => ({ file: new File(["x"], name, { lastModified: 0 }) });
const names = (list: readonly PickedFile[]): string[] => list.map((p) => p.file.name);

/** What a current build announces, and what the anonymous Chromium joiner in the
 *  reproduction actually sent. */
const CURRENT_CAPS = { caps: [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] };
/** An older Web build, the Swift client or the CLI: `text/1` and nothing else. */
const LEGACY_CAPS = { caps: [CAP_TEXT] };

/** Stage one file and carry it all the way to a finalized pair-room object, which
 *  is the state the sender is in when the peer joins. */
function stageAndFinalize(name = "browser-proof.txt"): void {
  setOutbox([pf(name)]);
  markUploading(0);
  markUploaded(0, { id: `obj-${name}`, key: KEY });
}

const running: (() => void)[] = [];

/**
 * App's auto-send effect, reduced to the two statements this bug lives in.
 *
 * A real `$effect` over the real stores, so "the gate reopened when the upload
 * finished" and "the gate never opened at all" are observed the way the app
 * observes them, not asserted about a function call. Draining from inside the
 * effect is what App does too.
 *
 * Started only once the roster names the peer, because that is when App's effect
 * first has one to ask about: its gate sits behind `visiblePeers.length === 1`,
 * and `noteRosterPeers` is called from that same roster handler. Asking about a
 * peer no roster ever named is a different question, and it has its own test.
 */
function autoSend(peerId = PEER) {
  const batches: PickedFile[][] = [];
  const probe = trackEffect(() => {
    const owed = liveLinkFor(peerId);
    if (owed > 0) batches.push(drainFor(peerId));
    return owed;
  });
  running.push(probe.stop);
  return { batches, gate: probe.values };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearOutbox();
  resetPeerCaps();
  resetHandoffLanes();
});
afterEach(() => {
  // Every probe, including the ones belonging to a test that failed before its
  // own teardown. A live effect root left subscribed to these module stores
  // drains the NEXT test's queue out from under it, which turns one real failure
  // into a page of unrelated ones.
  for (const stop of running.splice(0)) stop();
  vi.useRealTimers();
});

describe("the reproduced sequence: a current peer joins before its hello", () => {
  it("does not release or re-send a finalized object while the lane is undecided", () => {
    stageAndFinalize();
    expect(uploadedRefs()).toHaveLength(1);

    // ── the roster frame. App sets `peers`, then broadcasts ITS caps. It has
    //    learned nothing about the joiner; the joiner's hello is still in flight.
    //    This one handler is also what first gives the auto-send effect a peer.
    noteRosterPeers([PEER]);
    retainPeers([PEER]);
    const run = autoSend();
    flushSync();

    expect(handoffLane(PEER)).toBe("wait");
    // The gate is the whole fix. On afc70cae it read 1 here, drained, and the
    // release inside the drain threw the keys away.
    expect(liveLinkFor(PEER)).toBe(0);
    expect(run.batches).toEqual([]);
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs()).toEqual([{ id: "obj-browser-proof.txt", key: KEY }]);

    // ── one round trip later: the hello lands.
    expect(recordPeerCaps(PEER, CURRENT_CAPS)).toBe(true);
    notePeerCaps(PEER);
    flushSync();

    expect(handoffLane(PEER)).toBe("keys");
    // Still nothing for the live link — these entries are the handoff's, and the
    // ref that names them is intact for it to seal.
    expect(liveLinkFor(PEER)).toBe(0);
    expect(run.batches).toEqual([]);
    expect(uploadedRefs()).toEqual([{ id: "obj-browser-proof.txt", key: KEY }]);
    expect(outbox()).toHaveLength(1);  });

  it("hands the batch over exactly once when the hello beats the gate", () => {
    stageAndFinalize();
    // Caps first is the other order the same two frames can arrive in — a peer
    // already in the room when this page joined, or simply a fast relay.
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    noteRosterPeers([PEER]);

    const run = autoSend();
    flushSync();
    expect(handoffLane(PEER)).toBe("keys");
    expect(run.batches).toEqual([]);
    expect(uploadedRefs()).toHaveLength(1);  });
});

describe("a peer that cannot be handed keys still gets its files", () => {
  it("releases to the live lane the moment an older peer announces", () => {
    stageAndFinalize("legacy.txt");
    noteRosterPeers([PEER]);
    const run = autoSend();
    flushSync();
    expect(run.batches).toEqual([]);

    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    flushSync();

    expect(handoffLane(PEER)).toBe("live");
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].map((p) => p.file.name)).toEqual(["legacy.txt"]);
    // Released and drained: nothing is left parked in a state no lane owns.
    expect(uploadedRefs()).toEqual([]);
    expect(outbox()).toEqual([]);  });

  it("never sends a peer that announced nothing an unparseable frame kind", () => {
    // The lane is optimistic; the FRAME gate is not. `peerSupportsPreupload` is
    // what mixed-file-session asks before emitting kind 12, and an undecided
    // lane must never be read as consent to emit one.
    stageAndFinalize();
    noteRosterPeers([PEER]);
    expect(handoffLane(PEER)).toBe("wait");
    expect(peerTakesKeys(PEER)).toBe(true);
    // Deliberately re-read through peer-caps, the gate the emitter uses.
    expect(recordPeerCaps(PEER, { caps: "not-an-array" })).toBe(false);
    expect(handoffLane(PEER)).toBe("wait");
  });

  it("falls back on a bounded protocol event, not on waiting forever", () => {
    stageAndFinalize("silent.txt");
    noteRosterPeers([PEER]);
    const run = autoSend();
    flushSync();
    expect(run.batches).toEqual([]);

    // A peer that announces nothing at all cannot be told apart from one whose
    // hello is late, so the window is what ends the wait. It is the link
    // request's own timeout, reused — not a number invented here.
    vi.advanceTimersByTime(CAPS_SETTLE_MS - 1);
    flushSync();
    expect(handoffLane(PEER)).toBe("wait");
    expect(run.batches).toEqual([]);

    vi.advanceTimersByTime(1);
    flushSync();
    expect(handoffLane(PEER)).toBe("live");
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].map((p) => p.file.name)).toEqual(["silent.txt"]);
    expect(uploadedRefs()).toEqual([]);  });

  it("does not make a peer that left the roster wait out that window", () => {
    stageAndFinalize();
    noteRosterPeers([PEER]);
    expect(handoffLane(PEER)).toBe("wait");
    // Nothing more is coming from a page that has gone, and a peer that never
    // announced holds no link either — so there is no answer being thrown away.
    noteRosterPeers([]);
    expect(handoffLane(PEER)).toBe("live");
  });
});

describe("the batch is never split, drained empty, or sent twice", () => {
  it("holds a mixed batch together until the lane is decided", () => {
    setOutbox([pf("uploaded.txt"), pf("staged.txt")]);
    markUploading(0);
    markUploaded(0, { id: "obj-1", key: KEY });

    noteRosterPeers([PEER]);
    const run = autoSend();
    flushSync();
    // The staged half alone would open a legacy transfer, make the peer busy for
    // new intent, and strand the uploaded half with no link to hand keys over.
    expect(liveLinkFor(PEER)).toBe(0);
    expect(pendingFilesFor(PEER, true)).toEqual([]);
    expect(run.batches).toEqual([]);

    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    flushSync();
    // Decided: the staged file is the live link's, the uploaded one is the
    // handoff's, and each is claimed exactly once.
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].map((p) => p.file.name)).toEqual(["staged.txt"]);
    expect(uploadedRefs()).toEqual([{ id: "obj-1", key: KEY }]);
    expect(outbox().map((p) => p.file.name)).toEqual(["uploaded.txt"]);  });

  it("leaves a batch with nothing uploaded behaving exactly as it always did", () => {
    // Every LAN queue, and every code room before its first finalize. The wait
    // state must be invisible to them: same gate, same number, same instant.
    setOutbox([pf("a.txt")]);
    noteRosterPeers([PEER]);
    const run = autoSend();
    flushSync();
    expect(handoffLane(PEER)).toBe("wait");
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].map((p) => p.file.name)).toEqual(["a.txt"]);
    // And it does not fire a second time on the empty queue it left behind.
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    flushSync();
    expect(run.batches).toHaveLength(1);  });

  it("reopens the gate for an upload that finishes after a legacy peer joined", () => {
    // The protocol lets an upload already in flight at the join finish (§3), and
    // completing it moves the entry OUT of staged — so a gate on the staged count
    // would see the number go DOWN and stay shut for a peer already known not to
    // speak the handoff.
    setOutbox([pf("inflight.txt")]);
    markUploading(0);
    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    noteRosterPeers([PEER]);

    const run = autoSend();
    flushSync();
    // In flight: its bytes are moving and it belongs to neither lane yet.
    expect(liveLinkFor(PEER)).toBe(0);
    expect(run.batches).toEqual([]);

    markUploaded(0, { id: "obj-late", key: KEY });
    flushSync();
    expect(run.batches).toHaveLength(1);
    expect(run.batches[0].map((p) => p.file.name)).toEqual(["inflight.txt"]);
    expect(uploadedRefs()).toEqual([]);  });

  it("keeps a capable peer's entries when its roster entry is pruned mid-transfer", () => {
    // A peer's signalling socket can drop while its DataChannel keeps carrying
    // files — the reason `linkAuthoritative` exists in peer-workspace. The roster
    // empties, `retainPeers` drops the announcement, and reading only the pruned
    // announcement would say "this peer never announced" about a peer that
    // announced and is still connected.
    stageAndFinalize();
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    expect(handoffLane(PEER)).toBe("keys");

    retainPeers([]);
    noteRosterPeers([]);
    expect(handoffLane(PEER)).toBe("keys");
    expect(liveLinkFor(PEER)).toBe(0);
    expect(uploadedRefs()).toHaveLength(1);
  });

  it("gives a reconnecting peer, which the server renames, its own fresh window", () => {
    stageAndFinalize();
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    expect(handoffLane(PEER)).toBe("live");

    // A reconnect is a new peer id, so nothing about the old one is inherited.
    retainPeers(["peer-2"]);
    noteRosterPeers(["peer-2"]);
    expect(handoffLane("peer-2")).toBe("wait");
    expect(liveLinkFor("peer-2")).toBe(0);
  });
});

describe("room boundaries", () => {
  it("carries no window or memo from one room into the next", () => {
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    expect(handoffLane(PEER)).toBe("keys");

    resetPeerCaps();
    resetHandoffLanes();
    // Nothing is expected from a peer this room has never seen.
    expect(handoffLane(PEER)).toBe("live");
  });

  it("cannot leave a timer behind that reopens a decision in the next room", () => {
    noteRosterPeers([PEER]);
    resetPeerCaps();
    resetHandoffLanes();
    noteRosterPeers([PEER]);
    // The first room's window would have closed at exactly this point.
    vi.advanceTimersByTime(CAPS_SETTLE_MS - 1);
    expect(handoffLane(PEER)).toBe("wait");
  });
});

describe("what the KEY handoff is owed, which no live-lane count can see", () => {
  it("reports a fully pre-uploaded batch as owed to a peer that can take keys", () => {
    // The state every ordinary code room ends up in: everything finalized before
    // anybody joined. `liveLinkFor` is 0 here and correctly so — the live lane
    // owes nothing — which is exactly why a second question is needed. Without
    // it the sender has nothing to act on at all: no link is built, no frame is
    // emitted, and the batch is silence with the ciphertext already paid for.
    stageAndFinalize();
    noteRosterPeers([PEER]);
    expect(handoffOwed(PEER)).toBe(0); // undecided: nobody owes anything yet

    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    expect(liveLinkFor(PEER)).toBe(0);
    expect(handoffOwed(PEER)).toBe(1);
  });

  it("owes an old peer nothing, because the live lane takes those entries instead", () => {
    stageAndFinalize("legacy.txt");
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    expect(handoffOwed(PEER)).toBe(0);
    expect(liveLinkFor(PEER)).toBe(1);
  });

  it("owes nothing for an entry still uploading", () => {
    // Its bytes are moving and it is in nobody's batch. Counting it would arm a
    // confirmation for keys that do not exist yet.
    setOutbox([pf("inflight.txt")]);
    markUploading(0);
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);
    expect(handoffOwed(PEER)).toBe(0);

    markUploaded(0, { id: "obj-late", key: KEY });
    expect(handoffOwed(PEER)).toBe(1);
  });
});

describe("the batch a standing release control has to describe", () => {
  it("names the pre-uploaded entries while their keys have not been released", () => {
    setOutbox([pf("uploaded.txt"), pf("staged.txt")]);
    markUploading(0);
    markUploaded(0, { id: "obj-1", key: KEY });
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, CURRENT_CAPS);
    notePeerCaps(PEER);

    // Both halves are still waiting on the user: one for the live link, one for
    // the handoff. A control that counted only the live half would say "1 file"
    // about a batch of two — and for a FULLY pre-uploaded batch it would say
    // nothing at all and never render, leaving those files with no control on
    // screen that could reach them.
    expect(names(pendingFilesFor(PEER, false))).toEqual(["uploaded.txt", "staged.txt"]);
    expect(pendingCountFor(PEER, false)).toBe(2);

    // Once the keys are released, the uploaded entry is the handoff's and is not
    // waiting on that control any more — the live lane's own question again.
    expect(names(pendingFilesFor(PEER, true))).toEqual(["staged.txt"]);
    expect(pendingCountFor(PEER, true)).toBe(1);
    // Which is the live lane's own question again — the one the drain asks.
    expect(liveLinkFor(PEER)).toBe(1);
  });

  it("describes nothing at all while the lane is undecided", () => {
    stageAndFinalize();
    noteRosterPeers([PEER]);
    expect(pendingFilesFor(PEER, false)).toEqual([]);
    expect(pendingCountFor(PEER, false)).toBe(0);
  });

  it("names an old peer's whole batch, released keys or not", () => {
    // `live` means those entries never had a handoff to be released from; the
    // drain returns them either way, so both answers must be the same one.
    stageAndFinalize("legacy.txt");
    noteRosterPeers([PEER]);
    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    expect(names(pendingFilesFor(PEER, false))).toEqual(["legacy.txt"]);
    expect(names(pendingFilesFor(PEER, true))).toEqual(["legacy.txt"]);
  });
});

describe("the drain is the only irreversible step, and it asks the same question", () => {
  it("releases on `live` and on nothing else", () => {
    stageAndFinalize();
    noteRosterPeers([PEER]);
    // Called directly, past the gate: the gate and the one-way step behind it
    // must not be able to disagree.
    expect(drainFor(PEER)).toEqual([]);
    expect(uploadedRefs()).toHaveLength(1);
    addToOutbox([pf("later.txt")]);
    expect(drainFor(PEER).map((p) => p.file.name)).toEqual(["later.txt"]);
    expect(uploadedRefs()).toHaveLength(1);

    recordPeerCaps(PEER, LEGACY_CAPS);
    notePeerCaps(PEER);
    expect(drainFor(PEER)).toHaveLength(1);
    expect(uploadedRefs()).toEqual([]);
  });
});
