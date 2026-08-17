// device-list.ts — the rules two pages must answer identically.
//
// /me and /device-inbox now render the same rows for different reasons. Every
// question this module answers is one where a disagreement between them would
// be visible to the owner as a contradiction: a device listed on one page and
// missing from the other, or a count that does not match the list beside it.
import { describe, it, expect } from "vitest";
import en from "./i18n/en";
import { CAP_RECEIVE_V2, INBOX_KEY_ALGORITHM } from "./device-inbox";
import {
  SUPPORTED_DEVICE_KINDS,
  censusOf,
  deviceKindLabel,
  deviceLastUsedText,
  deviceRefText,
  deviceSignedInText,
  isSendable,
  isSupportedDeviceKind,
  supportedDevices,
  type DeviceRow,
} from "./device-list";

const ZERO_KEY = "A".repeat(43);

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    ProtocolVersion: 1,
    Capabilities: [CAP_RECEIVE_V2],
    ReceiveCapability: CAP_RECEIVE_V2,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "linux",
    AppVersion: "0.16.0",
    Revoked: false,
    CanReceive: true,
    RegisteredAt: 1_699_000_000,
    Key: {
      ID: "k1", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: ZERO_KEY,
      Generation: 1, CreatedAt: 1, SupersededAt: 0, RevokedAt: 0,
    },
    ...over,
  };
}

const row = (over: Partial<DeviceRow> = {}): Record<string, unknown> => ({
  ID: "0123456789abcdef0123456789abcdef",
  Name: "build-server",
  CreatedAt: 1_690_000_000,
  LastSeenAt: 1_700_000_000,
  Kind: "cli",
  Inbox: inbox(),
  ...over,
});

describe("which rows an account page may render", () => {
  it("lists the two token-bearing kinds and nothing else", () => {
    expect([...SUPPORTED_DEVICE_KINDS].sort()).toEqual(["app", "cli"]);
    expect(isSupportedDeviceKind("app")).toBe(true);
    expect(isSupportedDeviceKind("cli")).toBe(true);
    // A browser holds a session cookie, not a carryable token; an unknown kind
    // is one this build cannot say anything true about.
    expect(isSupportedDeviceKind("browser")).toBe(false);
    expect(isSupportedDeviceKind("")).toBe(false);
    expect(isSupportedDeviceKind(undefined)).toBe(false);
  });

  it("cannot be tricked by a Kind that names an Object.prototype member", () => {
    // The reason the lookup is a Map: `kinds["toString"]` on a plain object
    // walks the prototype chain, waving the row through AND rendering a
    // built-in function as its badge.
    for (const kind of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(isSupportedDeviceKind(kind), kind).toBe(false);
      expect(deviceKindLabel(kind, en), kind).toBe("");
    }
    expect(supportedDevices([row({ Kind: "toString" })])).toEqual([]);
  });

  it("orders by most recently used, then by most recently approved", () => {
    const rows = [
      row({ ID: "never-used-old", LastSeenAt: 0, CreatedAt: 100 }),
      row({ ID: "used-earlier", LastSeenAt: 50, CreatedAt: 1 }),
      row({ ID: "never-used-new", LastSeenAt: 0, CreatedAt: 200 }),
      row({ ID: "used-latest", LastSeenAt: 99, CreatedAt: 1 }),
    ];
    expect(supportedDevices(rows).map((d) => d.ID)).toEqual([
      "used-latest", "used-earlier", "never-used-new", "never-used-old",
    ]);
  });

  it("drops rows it cannot identify and coerces the fields the cards render", () => {
    // A row with no id cannot be revoked or sent to; a missing timestamp must
    // not reach `new Date(undefined * 1000)` and print "Invalid Date" where a
    // sign-in time belongs.
    const out = supportedDevices([
      null,
      "not a row",
      { Kind: "cli" }, // no ID
      { ID: "abc", Kind: "cli", Name: 7, CreatedAt: "soon", LastSeenAt: NaN, LastIP: 9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ ID: "abc", Name: "", CreatedAt: 0, LastSeenAt: 0, Kind: "cli", Inbox: undefined });
    expect("LastIP" in out[0]).toBe(false);
  });

  it("passes the Inbox subtree through untouched, for its one parser", () => {
    const raw = inbox();
    expect(supportedDevices([row({ Inbox: raw })])[0].Inbox).toBe(raw);
  });
});

describe("how many of them could actually receive", () => {
  it("counts sendability with the same rule the send control uses", () => {
    const rows = supportedDevices([
      row({ ID: "ready1" }),
      row({ ID: "ready2" }),
      row({ ID: "revoked", Inbox: inbox({ Revoked: true }) }),
      row({ ID: "off", Inbox: inbox({ AutoAccept: "off" }) }),
      row({ ID: "bare", Inbox: null }),
    ]);
    // A looser "has an Inbox subtree" rule would call three of these ready.
    expect(censusOf(rows)).toEqual({ total: 5, withInbox: 2 });
    expect(rows.filter(isSendable).map((d) => d.ID)).toEqual(["ready1", "ready2"]);
  });

  it("an offline device is still a target — the task queues", () => {
    const rows = supportedDevices([row({ Inbox: inbox({ Presence: "offline" }) })]);
    expect(censusOf(rows).withInbox).toBe(1);
  });

  it("an empty account is zero, not unknown", () => {
    expect(censusOf([])).toEqual({ total: 0, withInbox: 0 });
  });
});

describe("the three sentences that identify a row", () => {
  const d = supportedDevices([row()])[0];

  it("gives each kind its own localized badge", () => {
    expect(deviceKindLabel("cli", en)).toBe(en.me.deviceKindCli);
    expect(deviceKindLabel("app", en)).toBe(en.me.deviceKindApp);
  });

  it("says a never-used credential has not been used, not that it is missing", () => {
    expect(deviceLastUsedText({ ...d, LastSeenAt: 0 }, en, "en")).toBe(en.me.deviceNotUsedSinceSignIn);
    expect(deviceLastUsedText(d, en, "en")).toContain("Last used");
  });

  it("names when the credential was approved", () => {
    expect(deviceSignedInText(d, en, "en")).toContain("Signed in");
  });

  it("shortens the id, and renders nothing when there is nothing to shorten", () => {
    expect(deviceRefText(d, en)).toBe(en.me.deviceRef("abcdef"));
    // Below device-identity's minimum there is nothing distinguishing left to
    // show, and an almost-whole id is worse than none.
    expect(deviceRefText({ ...d, ID: "a" }, en)).toBe("");
    expect(deviceRefText({ ...d, ID: "--" }, en)).toBe("");
  });
});
