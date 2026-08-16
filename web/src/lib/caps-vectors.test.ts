import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAP_LINK, CAP_TEXT, CapsAnnouncer, LINK_CAPS_ANNOUNCE_ATTEMPTS, LINK_CAPS_RETRY_INTERVAL_MS,
  advertisedCaps, capsSignal, peerSupportsLink, peerSupportsText, recordPeerCaps, resetPeerCaps,
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

  it("understands the native hello, which is deliberately a smaller list", () => {
    // Not equal, and the assertion is the inequality: `preupload/1` is a Web
    // lane the native clients do not implement. A test that asserted equality
    // here would be the same mistake the Swift side made in the other direction.
    expect(cap.hello.native.caps).not.toEqual(cap.hello.web.caps);
    expect(recordPeerCaps("mac", cap.hello.native)).toBe(true);
    expect(peerSupportsLink("mac")).toBe(true);
    expect(peerSupportsText("mac")).toBe(true);
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
    for (const row of cap.promotion) {
      resetPeerCaps();
      expect(recordPeerCaps("p", { caps: row.caps }), `${row.caps} was not read as a hello`).toBe(true);
      expect(peerSupportsLink("p"), `promotion disagreed for ${row.caps}`).toBe(row.link);
      const decided = peerSupportsLink("p") || peerSupportsText("p");
      expect(decided, `immediacy disagreed for ${row.caps}`).toBe(row.resolvesImmediately);
      if (row.legacyLane) {
        expect(peerSupportsText("p"), `lane disagreed for ${row.caps}`).toBe(row.legacyLane === "text");
      }
    }
  });

  it("reads a hello as a snapshot, so a smaller one revokes", () => {
    recordPeerCaps("p", cap.revocation.first);
    expect(peerSupportsLink("p")).toBe(true);
    expect(recordPeerCaps("p", cap.revocation.then)).toBe(true);
    expect(peerSupportsLink("p")).toBe(cap.revocation.link);
    expect(peerSupportsText("p")).toBe(cap.revocation.text);
  });

  it("does not read a frame without a caps array as a hello", () => {
    for (const frame of cap.notAHello) {
      resetPeerCaps();
      recordPeerCaps("p", { caps: [CAP_TEXT, CAP_LINK] });
      expect(recordPeerCaps("p", frame), `${JSON.stringify(frame)} was read as a hello`).toBe(false);
      expect(peerSupportsLink("p"), `${JSON.stringify(frame)} cleared an announcement`).toBe(true);
    }
  });

  it("accepts a native downgrade announcement and reaches the lane it names", () => {
    // The native client sends this when it gives up on `link/1`, so the
    // withdrawal is agreed rather than one-sided: this page latches nothing and
    // would otherwise keep re-asking a peer that had stopped listening.
    recordPeerCaps("mac", cap.hello.native);
    expect(peerSupportsLink("mac")).toBe(true);

    expect(recordPeerCaps("mac", cap.downgrade.text)).toBe(true);
    expect(peerSupportsLink("mac")).toBe(false);
    expect(peerSupportsText("mac"), "a text lane must stay offerable").toBe(true);

    recordPeerCaps("mac", cap.hello.native);
    expect(recordPeerCaps("mac", cap.downgrade.files),
      "an empty caps array is still a hello — that is what makes it revoke").toBe(true);
    expect(peerSupportsLink("mac")).toBe(false);
    expect(peerSupportsText("mac"), "a file lane must not be offered a conversation").toBe(false);
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
});
