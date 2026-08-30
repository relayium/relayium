import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAP_LINK, CAP_TEXT, CapsAnnouncer, LINK_CAPS_ANNOUNCE_ATTEMPTS, LINK_CAPS_RETRY_INTERVAL_MS,
  advertisedCaps, capsSignal, peerCapsKnown, peerSupportsLink, recordPeerCaps, resetPeerCaps,
  retainPeers,
} from "./peer-caps.svelte";
import { linkRole } from "./peer-link.svelte";
import { clearRoom } from "./room.svelte";
import { ready, sas } from "./crypto";

/**
 * The browser half of the cross-language capability contract.
 *
 * `LinkCapabilityVectorTests.swift` is the other half, and both read the same
 * generated file. That is the entire point of writing it down: the workflows are
 * path-filtered — `web.yml` triggers on `web/**`, `macos.yml` on `apps/**` — so
 * no commit can ever fail both suites, and until now nothing linked the two
 * trees on this subject at all. The result was a Swift test asserting
 * `{"caps":["text/1","link/1"]}` as `capsSignal()` "verbatim" while
 * `peer-caps.test.ts` pinned three capabilities, both green, for as long as
 * `preupload/1` had shipped.
 *
 * To regenerate after a deliberate change:
 *   node scripts/gen-realtime-wire-vectors.mjs      (from web/)
 *
 * ## What this side stopped asserting, and why that is not a gap
 *
 * `legacyLane`, `resolvesImmediately` and `revocation.text` are still in the
 * generated file and are still asserted — by `LinkCapabilityVectorTests.swift`
 * alone. They describe which single-lane legacy transport a peer that is not
 * exact `link/1` falls to, and whether that fall waits out the capability
 * window. The browser has neither: there is one transport, and a peer that does
 * not announce it is unsupported, terminally and immediately. Asserting those
 * fields here would mean re-deriving a native concept from a browser predicate
 * that no longer exists, which is how the drift this file was written to catch
 * started. iOS still ships the lane, so the rows stay; this suite pins the half
 * that is genuinely shared.
 */
const WIRE = "../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json";
const CRYPTO = "../apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json";
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));

interface CapRow { caps: string[]; link: boolean; resolvesImmediately: boolean; legacyLane?: string }
interface RoleRow { self: string; peer: string; role: "initiator" | "responder" }

const wire = load(WIRE) as {
  capability: {
    hello: Record<string, { caps: string[] }>;
    retry: { attempts: number; intervalMs: number };
    settleSeconds: number;
    lastAttemptSeconds: number;
    promotion: CapRow[];
    downgrade: Record<string, { caps: string[] }>;
    revocation: { first: { caps: string[] }; then: { caps: string[] }; link: boolean; text: boolean };
    notAHello: unknown[];
    role: RoleRow[];
  };
};
const cap = wire.capability;

beforeEach(() => { clearRoom(); resetPeerCaps(); });

describe("capability vectors (shared with the native clients)", () => {
  it("has a capability block at all", () => {
    expect(cap, "run `node scripts/gen-realtime-wire-vectors.mjs` from web/").toBeTruthy();
  });

  it("announces exactly what the vector says this build announces", () => {
    expect(capsSignal()).toEqual(cap.hello.web);
    expect([...advertisedCaps()]).toEqual(cap.hello.web.caps);
  });

  it("understands the native hello, which is neither this one nor a subset of it", () => {
    // Not equal, and the assertion is the inequality — in BOTH directions now.
    // `preupload/1` is a Web lane the native clients do not implement, and
    // `text/1` is a native lane this build deleted. A test that asserted a
    // subset either way would be asserting a fiction, which is the mistake the
    // Swift side originally made in the other direction.
    expect(cap.hello.native.caps).not.toEqual(cap.hello.web.caps);
    expect(cap.hello.native.caps).toContain(CAP_TEXT);
    expect(cap.hello.web.caps).not.toContain(CAP_TEXT);
    // What IS shared is the one string either side may act on.
    expect(cap.hello.native.caps).toContain(CAP_LINK);
    expect(cap.hello.web.caps).toContain(CAP_LINK);

    expect(recordPeerCaps("mac", cap.hello.native)).toBe(true);
    expect(peerSupportsLink("mac")).toBe(true);
  });

  it("uses the same bounded retry cadence as the native clients", () => {
    expect(LINK_CAPS_ANNOUNCE_ATTEMPTS).toBe(cap.retry.attempts);
    expect(LINK_CAPS_RETRY_INTERVAL_MS).toBe(cap.retry.intervalMs);
    // Every attempt has to land inside the window the native pairing room waits
    // before it calls a silent peer legacy — a hello that arrives after it is a
    // frame that changes nothing, sent by a client that thinks it is still
    // negotiating.
    expect(cap.lastAttemptSeconds).toBe(((cap.retry.attempts - 1) * cap.retry.intervalMs) / 1000);
    expect(cap.lastAttemptSeconds).toBeLessThan(cap.settleSeconds);
  });

  it("promotes on exactly the announcements the vector promotes on", () => {
    // The rows are pinned against the source so a row deleted from the generator
    // fails loudly here instead of silently narrowing the loop below.
    expect(cap.promotion.map((row) => row.caps.join("+"))).toEqual([
      "text/1+link/1+preupload/1", "text/1+link/1", "link/1",
      "text/1", "", "link/2", "LINK/1", "text/2",
    ]);
    expect(cap.promotion.filter((row) => row.link)).toHaveLength(3);

    for (const row of cap.promotion) {
      resetPeerCaps();
      expect(recordPeerCaps("p", { caps: row.caps }), `${row.caps} was not read as a hello`).toBe(true);
      expect(peerSupportsLink("p"), `promotion disagreed for ${row.caps}`).toBe(row.link);
      // Every row announced SOMETHING, including the empty one. On this side
      // that is the whole of the decision: there is no window to wait out and no
      // second lane to fall to, so a row that does not promote is unsupported at
      // the instant its hello lands.
      expect(peerCapsKnown("p"), `${row.caps} was not recorded`).toBe(true);
    }
  });

  it("reads a hello as a snapshot, so a smaller one revokes", () => {
    recordPeerCaps("p", cap.revocation.first);
    expect(peerSupportsLink("p")).toBe(true);
    expect(recordPeerCaps("p", cap.revocation.then)).toBe(true);
    expect(peerSupportsLink("p")).toBe(cap.revocation.link);
    // …and the peer is still HEARD FROM. Revoking is a hello, not a silence, so
    // the browser's answer is "this peer said it cannot", not "we are waiting".
    expect(peerCapsKnown("p")).toBe(true);
  });

  it("does not read a frame without a caps array as a hello", () => {
    for (const frame of cap.notAHello) {
      resetPeerCaps();
      recordPeerCaps("p", { caps: [CAP_TEXT, CAP_LINK] });
      expect(recordPeerCaps("p", frame), `${JSON.stringify(frame)} was read as a hello`).toBe(false);
      expect(peerSupportsLink("p"), `${JSON.stringify(frame)} cleared an announcement`).toBe(true);
    }
  });

  it("accepts a native downgrade announcement, and answers both rows the same way", () => {
    // The native client sends this when it gives up on `link/1`, so the
    // withdrawal is agreed rather than one-sided: this page latches nothing and
    // would otherwise keep re-asking a peer that had stopped listening.
    //
    // Which lane the row names is a native fact (see the header). What the
    // browser does with either is identical and is the assertion here: the peer
    // stops being routable, because the lanes both rows name are gone from this
    // side. That sameness is the contraction, stated rather than implied.
    for (const [label, row] of [["text", cap.downgrade.text], ["files", cap.downgrade.files]] as const) {
      resetPeerCaps();
      recordPeerCaps("mac", cap.hello.native);
      expect(peerSupportsLink("mac"), label).toBe(true);
      expect(recordPeerCaps("mac", row),
        "an empty caps array is still a hello — that is what makes it revoke").toBe(true);
      expect(peerSupportsLink("mac"), label).toBe(false);
      expect(peerCapsKnown("mac"), label).toBe(true);
    }
    // The two rows are genuinely different frames; answering them alike is a
    // decision, not an artefact of the fixture being the same twice.
    expect(cap.downgrade.text.caps).not.toEqual(cap.downgrade.files.caps);
  });

  it("assigns the same role as the native clients, in both directions", () => {
    expect(cap.role.length % 2).toBe(0);
    for (const row of cap.role) expect(linkRole(row.self, row.peer), `${row.self}→${row.peer}`).toBe(row.role);
  });
});

/**
 * The SAS had a frozen six-digit vector that only Swift read: `SasTests.swift`
 * asserts an exact value, while `crypto.test.ts` asserted only `/^\d{6}$/`
 * against random keys. So a change to this side's `sas()` was invisible to every
 * test in the repository, and the digits two users are asked to compare are the
 * one value where "both sides computed something six digits long" is worth
 * nothing.
 */
describe("SAS", () => {
  it("matches the frozen cross-language vector, in both key orders", async () => {
    await ready();
    const v = load(CRYPTO) as { alice: { pub: string }; bob: { pub: string }; sas: string };
    const unhex = (s: string) =>
      new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16))) as Uint8Array<ArrayBuffer>;
    expect(sas(unhex(v.alice.pub), unhex(v.bob.pub))).toBe(v.sas);
    expect(sas(unhex(v.bob.pub), unhex(v.alice.pub))).toBe(v.sas);
  });
});

/**
 * The announcer itself. Everything here is a way a lost frame becomes a silently
 * wrong lane on the other client, and the one-shot broadcast this replaced had
 * no defence against any of them.
 */
describe("CapsAnnouncer", () => {
  interface Sent { to: string; caps: string[] }

  function rig() {
    const sent: Sent[] = [];
    let pending: (() => void) | undefined;
    const announcer = new CapsAnnouncer(
      (to, signal) => sent.push({ to, caps: signal.caps }),
      {
        setTimer: (fn) => { pending = fn; return 1; },
        clearTimer: () => { pending = undefined; },
      },
    );
    const tick = () => { const fn = pending; pending = undefined; fn?.(); };
    return { sent, announcer, tick, armed: () => pending !== undefined };
  }

  it("greets a new peer once, then runs exactly the bounded retries", () => {
    const { sent, announcer, tick } = rig();
    announcer.rosterChanged(["p1"]);
    expect(sent).toEqual([{ to: "p1", caps: [...advertisedCaps()] }]);

    for (let i = 0; i < LINK_CAPS_ANNOUNCE_ATTEMPTS + 3; i++) tick();
    expect(sent.length, "bounded: the promised attempts and not one more")
      .toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS);
    for (const frame of sent) expect(frame.caps).toEqual([...advertisedCaps()]);
  });

  it("stops the timer once nothing is owed, so a settled roster runs no work", () => {
    const { announcer, tick, armed } = rig();
    announcer.rosterChanged(["p1"]);
    for (let i = 0; i < LINK_CAPS_ANNOUNCE_ATTEMPTS; i++) tick();
    expect(armed()).toBe(false);
  });

  it("retires a peer that answers, and never answers a hello with a hello", () => {
    const { sent, announcer, tick } = rig();
    announcer.rosterChanged(["p1"]);
    announcer.didHearFrom("p1");
    const after = sent.length;
    for (let i = 0; i < LINK_CAPS_ANNOUNCE_ATTEMPTS; i++) tick();
    expect(sent.length, "a peer that has spoken does not need telling again").toBe(after);
  });

  it("does not re-greet a peer that was already in the roster", () => {
    const { sent, announcer } = rig();
    announcer.rosterChanged(["p1"]);
    announcer.rosterChanged(["p1"]);
    announcer.rosterChanged(["p1"]);
    expect(sent.length).toBe(1);
  });

  it("greets only the peer that is new when the roster grows", () => {
    const { sent, announcer } = rig();
    announcer.rosterChanged(["p1"]);
    announcer.rosterChanged(["p1", "p2"]);
    expect(sent.map((s) => s.to)).toEqual(["p1", "p2"]);
  });

  it("forgets a peer that left, and greets it again if the id returns", () => {
    const { sent, announcer } = rig();
    announcer.rosterChanged(["p1"]);
    announcer.rosterChanged([]);
    announcer.rosterChanged(["p1"]);
    expect(sent.map((s) => s.to)).toEqual(["p1", "p1"]);
  });

  it("forgets everything a room change invalidates", () => {
    const { sent, announcer, tick, armed } = rig();
    announcer.rosterChanged(["p1"]);
    announcer.roomChanged();
    expect(armed()).toBe(false);
    tick();
    expect(sent.length, "a peer id means nothing outside the room that issued it").toBe(1);
  });

  it("stops permanently when stopped", () => {
    const { sent, announcer } = rig();
    announcer.stop();
    announcer.rosterChanged(["p1"]);
    expect(sent).toEqual([]);
  });

  /**
   * `refreshPresent` — the page became the one the user is looking at.
   *
   * The defect it repairs is not on this side of the wire, which is why no
   * assertion above catches it. `#greeted` records who this page has TOLD; it
   * cannot record that the listener threw the announcement away. The other side
   * prunes caps per roster (`retainPeers`), and two pages of one browser are ONE
   * roster entry — so while the sibling represents the installation, this page's
   * hello is pruned over there. When the sibling closes and this page becomes
   * the representative, the other device holds a peer it has no announcement
   * for and renders "too old" with no action. This page's own roster never
   * changed through any of it, so `rosterChanged` has nothing new to greet and
   * the hello is never sent again by any existing path.
   */
  describe("refreshPresent", () => {
    it("tells every present peer again, even ones long since greeted and answered", () => {
      const { sent, announcer } = rig();
      announcer.rosterChanged(["p1", "p2"]);
      announcer.didHearFrom("p1");
      announcer.didHearFrom("p2");
      sent.length = 0;

      announcer.refreshPresent(["p1", "p2"]);
      // Sorted, so the frame order is something a vector can pin.
      expect(sent).toEqual([
        { to: "p1", caps: [...advertisedCaps()] },
        { to: "p2", caps: [...advertisedCaps()] },
      ]);
    });

    it("sends the current announcement verbatim, exactly like every other path", () => {
      const { sent, announcer } = rig();
      announcer.refreshPresent(["p1"]);
      expect(sent).toEqual([{ to: "p1", caps: cap.hello.web.caps }]);
    });

    it("owes nothing afterwards: no greeted change, no pending, no timer", () => {
      const { sent, announcer, tick, armed } = rig();
      announcer.rosterChanged(["p1"]);
      announcer.didHearFrom("p1"); // retired: nothing is owed, nothing is armed
      expect(armed()).toBe(false);
      sent.length = 0;

      announcer.refreshPresent(["p1"]);
      expect(sent.length, "exactly one frame, once").toBe(1);
      // No timer. A refresh that armed one would turn every tab switch into a
      // fresh three-frame burst against a peer that has already answered.
      expect(armed(), "the refresh armed the retry timer").toBe(false);
      expect(announcer.owed("p1"), "the refresh created a pending obligation").toBe(0);
      tick();
      expect(sent.length, "the refresh left something behind to retry").toBe(1);
    });

    it("does not spend the bounded budget a genuinely new peer is still owed", () => {
      // The other half of "owes nothing": a page switched to twice must not eat
      // the retries that exist for a peer which has never answered at all.
      const { sent, announcer, tick } = rig();
      announcer.rosterChanged(["p1"]);
      expect(announcer.owed("p1")).toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1);

      announcer.refreshPresent(["p1"]);
      announcer.refreshPresent(["p1"]);
      expect(announcer.owed("p1"), "a refresh consumed a retry attempt")
        .toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1);

      const beforeTicks = sent.length;
      for (let i = 0; i < LINK_CAPS_ANNOUNCE_ATTEMPTS + 3; i++) tick();
      expect(sent.length - beforeTicks, "the bounded retries did not all survive the refreshes")
        .toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1);
    });

    it("does not re-greet, so the roster's own greeting stays one-shot", () => {
      const { sent, announcer } = rig();
      announcer.rosterChanged(["p1"]);
      announcer.refreshPresent(["p1"]);
      sent.length = 0;
      // If the refresh had cleared `#greeted`, this roster event would greet p1
      // all over again — a second full retry burst on every tab switch.
      announcer.rosterChanged(["p1"]);
      expect(sent).toEqual([]);
    });

    it("does not mark anyone greeted, so a peer refreshed first is still greeted properly", () => {
      // The other direction, and the one that actually costs something. A
      // refresh can reach a peer this announcer has not greeted yet — the page
      // was switched to before the roster event landed. Marking it greeted there
      // would make the roster event a no-op, and the peer would get ONE
      // unacknowledged frame instead of the bounded retries it is owed. That is
      // the original lost-hello failure, reintroduced by the repair for it.
      const { sent, announcer, tick } = rig();
      announcer.refreshPresent(["p1"]);
      expect(sent.length).toBe(1);

      announcer.rosterChanged(["p1"]);
      expect(sent.length, "the roster event did not greet a peer that had only been refreshed").toBe(2);
      expect(announcer.owed("p1")).toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1);
      for (let i = 0; i < LINK_CAPS_ANNOUNCE_ATTEMPTS + 3; i++) tick();
      expect(sent.length, "the bounded retries were skipped").toBe(1 + LINK_CAPS_ANNOUNCE_ATTEMPTS);
    });

    it("says nothing to a peer that is not present, and nothing at all when stopped", () => {
      const { sent, announcer } = rig();
      announcer.rosterChanged(["p1"]);
      sent.length = 0;
      announcer.refreshPresent([]);
      expect(sent, "a refresh with an empty roster is not a broadcast").toEqual([]);

      announcer.stop();
      announcer.refreshPresent(["p1"]);
      expect(sent, "a stopped announcer still spoke").toEqual([]);
    });

    it("is never the answer to a hello", () => {
      // The structural property that keeps two clients from talking past each
      // other forever: hearing from a peer RETIRES, it never sends. Stated here
      // because `refreshPresent` is the first send path that is not driven by
      // the roster, and wiring it into the receive path would be the ping-pong.
      const { sent, announcer } = rig();
      announcer.rosterChanged(["p1"]);
      sent.length = 0;
      announcer.didHearFrom("p1");
      expect(sent).toEqual([]);
    });

    it("makes the pruned-sibling peer reachable again, end to end", () => {
      // The whole defect, in the two objects that actually decide it. The other
      // device's view is `recordPeerCaps`/`retainPeers`; this page's view is the
      // announcer. Neither alone shows the deadlock.
      const { sent, announcer } = rig();
      const other = "b";
      announcer.rosterChanged([other]);
      // The other device hears this page and, at this point, can reach it.
      for (const frame of sent) recordPeerCaps("a2", { caps: frame.caps });
      announcer.didHearFrom(other);
      expect(peerSupportsLink("a2")).toBe(true);

      // …then its roster settles on the SIBLING, and this page's caps are pruned.
      retainPeers(["a1"]);
      expect(peerSupportsLink("a2"), "the prune is the precondition, not the bug").toBe(false);

      // The sibling closes. The other device's roster falls back to this page,
      // and this page's roster is unchanged — so nothing re-greets.
      sent.length = 0;
      announcer.rosterChanged([other]);
      expect(sent, "the roster path cannot fix this: nothing about it changed").toEqual([]);
      retainPeers(["a2"]);
      expect(peerCapsKnown("a2"), "the other device has no announcement to show a card for").toBe(false);

      // Becoming the current page is what breaks it.
      announcer.refreshPresent([other]);
      expect(sent.length).toBe(1);
      for (const frame of sent) recordPeerCaps("a2", { caps: frame.caps });
      expect(peerSupportsLink("a2")).toBe(true);
    });
  });
});
