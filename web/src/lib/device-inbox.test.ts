import { describe, it, expect } from "vitest";
import {
  CAP_RECEIVE_V1,
  INBOX_KEY_ALGORITHM,
  POLL_MAX_MS,
  POLL_MIN_MS,
  SERVER_TASK_STATES,
  TASK_ERROR_CODES,
  httpSendErrorCode,
  isCanonicalB64Url,
  isInertId,
  isSaved,
  isServerTaskState,
  isTaskErrorCode,
  isTerminalTaskState,
  parseDeviceInbox,
  parseInboxTask,
  pollDelay,
  sendAvailability,
  toSendErrorCode,
} from "./device-inbox";

/** 43 canonical base64url characters = 32 raw bytes. All-zero is the simplest
 *  spelling that satisfies the trailing-bit rule. */
const ZERO_KEY_B64 = "A".repeat(43);

function inboxJson(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    ProtocolVersion: 1,
    Capabilities: [CAP_RECEIVE_V1, "inbox.autoaccept.v1"],
    ReceiveCapability: CAP_RECEIVE_V1,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "linux",
    AppVersion: "0.15.0",
    Revoked: false,
    CanReceive: true,
    RegisteredAt: 1_699_000_000,
    Key: {
      ID: "k1",
      Algorithm: INBOX_KEY_ALGORITHM,
      PublicKey: ZERO_KEY_B64,
      Generation: 1,
      CreatedAt: 1_699_000_000,
      SupersededAt: 0,
      RevokedAt: 0,
    },
    ...over,
  };
}

const avail = (over: Record<string, unknown> = {}, id = "dev1") =>
  sendAvailability(id, parseDeviceInbox(inboxJson(over)));

describe("identifier hygiene", () => {
  it("refuses ids that change the MEANING of a request path", () => {
    // encodeURIComponent leaves these intact, which is exactly why the rule
    // cannot be "escape it": `..` composes a request at another endpoint.
    for (const bad of ["..", ".", "a/b", "a.b", "", "a b", "a#b", "%2e%2e", "a".repeat(129)]) {
      expect(isInertId(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(isInertId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isInertId("web-abc_DEF-123")).toBe(true);
  });

  it("refuses non-strings whatever the type annotation says", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(isInertId(bad)).toBe(false);
    }
  });
});

describe("canonical base64url", () => {
  it("accepts exactly one spelling of a 32-byte key", () => {
    expect(isCanonicalB64Url(ZERO_KEY_B64, 32)).toBe(true);
  });

  it("rejects padding, the standard alphabet, and the wrong length", () => {
    expect(isCanonicalB64Url("A".repeat(42) + "=", 32)).toBe(false);
    expect(isCanonicalB64Url("A".repeat(42) + "+", 32)).toBe(false);
    expect(isCanonicalB64Url("A".repeat(42) + "/", 32)).toBe(false);
    expect(isCanonicalB64Url("A".repeat(42), 32)).toBe(false);
    expect(isCanonicalB64Url("A".repeat(44), 32)).toBe(false);
    expect(isCanonicalB64Url("", 32)).toBe(false);
  });

  it("rejects a non-canonical trailing-bit spelling a permissive decoder accepts", () => {
    // 'B' = index 1: its low bits sit past the 32nd byte. Go's
    // RawURLEncoding.Strict() refuses it, so this client must too — otherwise
    // one key would have several spellings and "is this the key central named?"
    // would stop being a string comparison.
    expect(isCanonicalB64Url("A".repeat(42) + "B", 32)).toBe(false);
    expect(isCanonicalB64Url("A".repeat(42) + "C", 32)).toBe(false); // index 2, low bit 0 of 2 set
    expect(isCanonicalB64Url("A".repeat(42) + "E", 32)).toBe(true); // index 4: low two bits zero
  });
});

describe("parseDeviceInbox", () => {
  it("is null for anything that is not an object", () => {
    for (const bad of [null, undefined, "x", 3, [], true]) {
      expect(parseDeviceInbox(bad)).toBeNull();
    }
  });

  it("coerces rather than trusts: a truthy string is not a boolean", () => {
    const parsed = parseDeviceInbox(inboxJson({ CanReceive: "false", Revoked: "no" }))!;
    expect(parsed.CanReceive, "the string \"false\" was treated as a usable device").toBe(false);
    expect(parsed.Revoked).toBe(false);
  });

  it("survives a Capabilities field that is not an array of strings", () => {
    expect(parseDeviceInbox(inboxJson({ Capabilities: "inbox.receive.v1" }))!.Capabilities).toEqual([]);
    expect(parseDeviceInbox(inboxJson({ Capabilities: [1, "a", null] }))!.Capabilities).toEqual(["a"]);
  });

  it("drops a Key that is not an object rather than half-parsing one", () => {
    expect(parseDeviceInbox(inboxJson({ Key: "AAAA" }))!.Key).toBeNull();
    expect(parseDeviceInbox(inboxJson({ Key: null }))!.Key).toBeNull();
  });
});

describe("sendAvailability", () => {
  it("an online auto device with a ready folder is sendable with no caveats", () => {
    const a = avail();
    expect(a.sendable).toBe(true);
    expect(a.caveats).toEqual([]);
    expect(a.online).toBe(true);
    expect(a.policy).toBe("auto");
  });

  it("OFFLINE but cryptographically able stays sendable, and says it queues", () => {
    // This is the whole reason the queue exists (PRD §7.3): presence must never
    // become permission.
    const a = avail({ Presence: "offline" });
    expect(a.sendable, "an offline enrolled device was refused as a target").toBe(true);
    expect(a.caveats).toContain("queued_until_online");
    expect(a.online).toBe(false);
  });

  it("a presence value that is neither online nor offline is treated as offline", () => {
    expect(avail({ Presence: "maybe" }).online).toBe(false);
    expect(avail({ Presence: "" }).online).toBe(false);
  });

  it("policy ask is sendable but truthfully needs someone at that machine", () => {
    const a = avail({ AutoAccept: "ask" });
    expect(a.sendable).toBe(true);
    expect(a.caveats).toContain("needs_approval");
  });

  it("policy auto with an unusable receive folder is sendable but not portrayed as ready", () => {
    const a = avail({ ReceiveDirReady: false });
    expect(a.sendable).toBe(true);
    expect(a.caveats).toContain("directory_not_ready");
  });

  it("policy off is NOT sendable — central refuses it and stores nothing", () => {
    const a = avail({ AutoAccept: "off" });
    expect(a.sendable).toBe(false);
    expect(a.block).toBe("receive_off");
  });

  it("an unknown policy fails closed rather than being coerced", () => {
    const a = avail({ AutoAccept: "always" });
    expect(a.sendable).toBe(false);
    expect(a.block).toBe("unknown_policy");
  });

  it("revoked, cannot-receive and never-enrolled are each refused with their own reason", () => {
    expect(avail({ Revoked: true }).block).toBe("revoked");
    expect(avail({ CanReceive: false }).block).toBe("cannot_receive");
    expect(avail({ RegisteredAt: 0 }).block).toBe("not_enrolled");
    expect(sendAvailability("dev1", null).block).toBe("not_enrolled");
    expect(sendAvailability("dev1", null).sendable).toBe(false);
  });

  it("refuses every unusable shape of key material", () => {
    expect(avail({ Key: null }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, Algorithm: "rsa-oaep-v1" } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, PublicKey: "not-base64url!" } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, PublicKey: "A".repeat(42) } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, RevokedAt: 5 } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, SupersededAt: 5 } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, Generation: 0 } }).block).toBe("unsupported_key");
    expect(avail({ Key: { ...inboxJson().Key, ID: "../other" } }).block).toBe("unsupported_key");
  });

  it("refuses a receive capability this build cannot drive", () => {
    expect(avail({ ReceiveCapability: "inbox.receive.v2" }).block).toBe("unsupported_capability");
    expect(avail({ ReceiveCapability: "" }).block).toBe("unsupported_capability");
  });

  it("refuses a device whose id could not be composed into a request path", () => {
    // The revoke button still works for such a row (it encodes the id); what
    // must not happen is a SEND aimed at a path this client never meant to call.
    const a = sendAvailability("../me", parseDeviceInbox(inboxJson()));
    expect(a.sendable).toBe(false);
    expect(a.block).toBe("unusable_id");
  });

  it("names the FIRST thing the user would have to change", () => {
    // Revoked AND policy off AND no key: the sentence must be about revocation,
    // because clearing it is the step that unblocks everything else.
    expect(avail({ Revoked: true, AutoAccept: "off", Key: null }).block).toBe("revoked");
  });
});

describe("task state vocabulary", () => {
  it("is the closed PRD §10 server set — sender-local phases are refused by name", () => {
    expect(SERVER_TASK_STATES).toHaveLength(10);
    expect(isServerTaskState("encrypting")).toBe(false);
    expect(isServerTaskState("uploading")).toBe(false);
    expect(isServerTaskState("sent")).toBe(false);
    expect(isServerTaskState("saved")).toBe(true);
    expect(isServerTaskState(undefined)).toBe(false);
  });

  it("marks exactly the four terminal states", () => {
    const terminal = SERVER_TASK_STATES.filter(isTerminalTaskState);
    expect(terminal.sort()).toEqual(["expired", "failed_terminal", "revoked", "saved"]);
  });

  it("has the closed protocol §16 error set and refuses anything outside it", () => {
    expect(TASK_ERROR_CODES).toHaveLength(14);
    expect(isTaskErrorCode("disk_full")).toBe(true);
    expect(isTaskErrorCode("/etc/passwd is not writable")).toBe(false);
    expect(isTaskErrorCode("")).toBe(false);
  });
});

describe("parseInboxTask", () => {
  const base = { ID: "0123456789abcdef0123456789abcdef", State: "queued", ErrorCode: "" };

  it("refuses a task whose id could not be polled or cancelled safely", () => {
    expect(parseInboxTask({ ...base, ID: "../../me" })).toBeNull();
    expect(parseInboxTask({ ...base, ID: 42 })).toBeNull();
    expect(parseInboxTask(null)).toBeNull();
    expect(parseInboxTask([base])).toBeNull();
  });

  it("derives Terminal from the state table even when the server omits the flag", () => {
    expect(parseInboxTask({ ...base, State: "saved" })!.Terminal).toBe(true);
    expect(parseInboxTask({ ...base, State: "queued" })!.Terminal).toBe(false);
    // …and honours an explicit flag on a state this build does not know, so an
    // unrecognised terminal state still stops the poll.
    expect(parseInboxTask({ ...base, State: "quarantined", Terminal: true })!.Terminal).toBe(true);
  });
});

describe("isSaved", () => {
  const saved = parseInboxTask({ ID: "a".repeat(32), State: "saved", SavedAt: 1_700_000_500 })!;

  it("is true only for the server's own saved state WITH its commit timestamp", () => {
    expect(isSaved(saved)).toBe(true);
    expect(isSaved(parseInboxTask({ ID: "a".repeat(32), State: "saved", SavedAt: 0 })!)).toBe(false);
    expect(isSaved(parseInboxTask({ ID: "a".repeat(32), State: "verifying", SavedAt: 5 })!)).toBe(false);
    expect(isSaved(null)).toBe(false);
  });
});

describe("error mapping", () => {
  it("maps every documented create refusal, and only those, to itself", () => {
    for (const code of [
      "auto_receive_disabled",
      "device_cannot_receive",
      "device_inbox_revoked",
      "stale_target_key",
      "idempotency_key_conflict",
      "stored_object_unavailable",
      "stored_object_already_bound",
      "inbox_queue_full",
    ]) {
      expect(toSendErrorCode(code)).toBe(code);
    }
  });

  it("never lets an unrecognised server string through", () => {
    expect(toSendErrorCode("something the server made up")).toBe("unknown");
    expect(toSendErrorCode({ error: "x" })).toBe("unknown");
    expect(toSendErrorCode(undefined)).toBe("unknown");
    // A code from the TASK vocabulary is not a CREATE vocabulary code.
    expect(toSendErrorCode("disk_full")).toBe("unknown");
  });

  it("maps the statuses whose remedies differ", () => {
    expect(httpSendErrorCode(401)).toBe("signed_out");
    expect(httpSendErrorCode(403)).toBe("signed_out");
    expect(httpSendErrorCode(413)).toBe("upload_too_large");
    expect(httpSendErrorCode(429)).toBe("quota_exceeded");
    expect(httpSendErrorCode(0)).toBe("network");
    expect(httpSendErrorCode(500)).toBe("unknown");
  });
});

describe("poll cadence", () => {
  it("starts short, doubles, and is bounded on both ends", () => {
    expect(pollDelay(0)).toBe(POLL_MIN_MS);
    expect(pollDelay(1)).toBe(POLL_MIN_MS * 2);
    expect(pollDelay(100)).toBe(POLL_MAX_MS);
    expect(pollDelay(-5)).toBe(POLL_MIN_MS);
    for (let n = 0; n < 40; n++) {
      expect(pollDelay(n)).toBeGreaterThanOrEqual(POLL_MIN_MS);
      expect(pollDelay(n)).toBeLessThanOrEqual(POLL_MAX_MS);
    }
  });
});
