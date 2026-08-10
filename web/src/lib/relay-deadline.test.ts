import { describe, expect, it } from "vitest";
import {
  RELAY_DEADLINE_WARN_MS,
  TURN_CLOCK_SKEW_MS,
  earliestTurnExpiry,
  relayDeadline,
} from "./relay-deadline";

const turn = (username?: string, urls: string | string[] = "turn:relay.example:3478"): RTCIceServer =>
  username === undefined ? { urls } : { urls, username, credential: "x" };
const stun: RTCIceServer = { urls: "stun:stun.example:3478" };

describe("earliestTurnExpiry", () => {
  it("reads the TURN REST username's unix-second prefix", () => {
    expect(earliestTurnExpiry([turn("1900000000:owner.123456")])).toBe(1_900_000_000);
  });

  it("takes the EARLIEST of several relays, not the first or the longest", () => {
    // A pool hands out one credential per relay, all minted in the same request
    // but not necessarily with the same TTL. The link may end up on any of them,
    // so the bound has to be the one that dies first.
    expect(earliestTurnExpiry([
      turn("1900000900:owner.123456"),
      turn("1900000300:owner.123456", "turns:relay2.example:5349"),
      turn("1900000600:owner.123456", ["turn:relay3.example:3478", "turn:relay3.example:3478?transport=tcp"]),
    ])).toBe(1_900_000_300);
  });

  it("has no expiry for a STUN-only list", () => {
    expect(earliestTurnExpiry([stun])).toBeNull();
    expect(earliestTurnExpiry([])).toBeNull();
    expect(earliestTurnExpiry(undefined)).toBeNull();
  });

  it("ignores a username on an entry that carries no turn:/turns: URL", () => {
    // A STUN entry has no business carrying a credential; reading one would let a
    // hostile /api/ice body impose a deadline on a link that never relays.
    expect(earliestTurnExpiry([{ urls: "stun:stun.example:3478", username: "1:x", credential: "x" }])).toBeNull();
  });

  it.each([
    ["no colon at all", "notatimestamp"],
    ["a non-numeric prefix", "abc:owner.123456"],
    ["an empty prefix", ":owner.123456"],
    ["a signed prefix", "+1900000000:owner.123456"],
    ["a fractional prefix", "1900000000.5:owner.123456"],
    ["a hex prefix", "0x71b1b900:owner.123456"],
    ["whitespace padding", " 1900000000:owner.123456"],
    ["a non-positive prefix", "0:owner.123456"],
    ["a negative prefix", "-1900000000:owner.123456"],
    ["an absurd prefix", "99999999999999999999:owner.123456"],
    ["no username", undefined],
    ["an empty username", ""],
  ])("ignores a malformed credential with %s", (_label, username) => {
    expect(earliestTurnExpiry([turn(username)])).toBeNull();
  });

  it("keeps a valid sibling when one entry is malformed", () => {
    // Fail-closed on the malformed entry alone would drop the only bound we have.
    expect(earliestTurnExpiry([turn("garbage"), turn("1900000000:owner.123456")])).toBe(1_900_000_000);
  });

  it("never throws on a hostile body shape", () => {
    const hostile = [
      { urls: undefined as unknown as string },
      { urls: ["turn:relay.example:3478"], username: 12345 as unknown as string },
      { urls: [null as unknown as string], username: "1900000000:o" },
      null as unknown as RTCIceServer,
    ];
    expect(earliestTurnExpiry(hostile)).toBeNull();
  });
});

describe("relayDeadline", () => {
  const NOW = 1_700_000_000_000; // local clock, ms
  const inMinutes = (m: number) => Math.floor((NOW + m * 60_000) / 1000);

  it("subtracts a clock-skew margin from the earliest expiry", () => {
    const d = relayDeadline({ iceServers: [stun, turn(`${inMinutes(60)}:owner.123456`)] }, NOW);
    expect(d).not.toBeNull();
    expect(d!.expiresAt).toBe(NOW + 60 * 60_000);
    expect(d!.deadlineAt).toBe(NOW + 60 * 60_000 - TURN_CLOCK_SKEW_MS);
    expect(d!.warnAt).toBe(d!.deadlineAt - RELAY_DEADLINE_WARN_MS);
  });

  it("folds the relay pool in, not just the legacy top-level entry", () => {
    // A deployment that puts its relays in `relays` has an empty-of-TURN
    // top-level list; reading only that one would leave a relayed link unbounded.
    const d = relayDeadline({
      iceServers: [stun],
      relays: [
        { id: "a", iceServers: [turn(`${inMinutes(50)}:owner.123456`)] },
        { id: "b", iceServers: [turn(`${inMinutes(20)}:owner.123456`)] },
      ],
    }, NOW);
    expect(d!.expiresAt).toBe(NOW + 20 * 60_000);
  });

  it("has no deadline for a STUN-only config — LAN and a relay-less code room alike", () => {
    expect(relayDeadline({ iceServers: [stun] }, NOW)).toBeNull();
    expect(relayDeadline({ iceServers: [], relays: [] }, NOW)).toBeNull();
    expect(relayDeadline({ iceServers: [stun], relays: [{ id: "a", iceServers: [stun] }] }, NOW)).toBeNull();
  });

  it("clamps a credential that is already expired to an immediate deadline", () => {
    // Never negative and never in the past: the caller arms timers off these, and
    // a negative delay would fire in a way that reads as "no deadline at all".
    const d = relayDeadline({ iceServers: [turn(`${inMinutes(-30)}:owner.123456`)] }, NOW);
    expect(d!.deadlineAt).toBe(NOW);
    expect(d!.warnAt).toBe(NOW);
  });

  it("clamps the warning to the deadline when less than the warning lead remains", () => {
    const d = relayDeadline({ iceServers: [turn(`${inMinutes(2)}:owner.123456`)] }, NOW);
    expect(d!.deadlineAt).toBe(NOW + 2 * 60_000 - TURN_CLOCK_SKEW_MS);
    expect(d!.warnAt).toBe(NOW); // warn now rather than after the boundary
    expect(d!.warnAt).toBeLessThanOrEqual(d!.deadlineAt);
  });

  it("is a plain absolute local-clock pair, so a later read cannot re-derive it", () => {
    // Derived ONCE from the fetch-time clock: the skew correction is a duration
    // measured against the local clock, so re-deriving it later against a drifted
    // clock would silently move the boundary.
    const d = relayDeadline({ iceServers: [turn(`${inMinutes(60)}:owner.123456`)] }, NOW);
    const later = relayDeadline({ iceServers: [turn(`${inMinutes(60)}:owner.123456`)] }, NOW + 600_000);
    expect(d!.deadlineAt).toBe(later!.deadlineAt);
  });
});
