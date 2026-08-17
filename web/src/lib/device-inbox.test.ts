import { describe, it, expect } from "vitest";
import {
  CAP_RECEIVE_V2,
  CAP_TEXT_V1,
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
  textDraftSize,
  toSendErrorCode,
} from "./device-inbox";
import { INBOX_MANIFEST_MAX_TEXT_BYTES } from "./inbox-manifest";

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
    Capabilities: [CAP_RECEIVE_V2, "inbox.autoaccept.v1"],
    ReceiveCapability: CAP_RECEIVE_V2,
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
    expect(parseDeviceInbox(inboxJson({ Capabilities: "inbox.receive.v2" }))!.Capabilities).toEqual([]);
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
    // v1 is the one that matters: a device still enrolled under the historical
    // capability cannot read a v2 manifest, so offering it as a target would
    // promise a delivery that fails after the file is already encrypted and
    // uploaded. There is no downgrade branch — the owner waived old-protocol
    // compatibility, so this is a refusal, not a fallback.
    expect(avail({ ReceiveCapability: "inbox.receive.v1" }).block).toBe("unsupported_capability");
    expect(avail({ ReceiveCapability: "inbox.receive.v9" }).block).toBe("unsupported_capability");
    expect(avail({ ReceiveCapability: "" }).block).toBe("unsupported_capability");
  });

  it("treats the text capability as a sender's truth claim, never as a gate", () => {
    // `inbox.text.v1` says "this receiver shows a message as a message". It is
    // read off the device, never required: a receiver that only takes files is
    // still a perfectly good target for files, so its ABSENCE must not block a
    // send. Central cannot verify the claim either way — content kind lives
    // only inside the encrypted manifest.
    expect(CAP_TEXT_V1).toBe("inbox.text.v1");
    const fileOnly = parseDeviceInbox(inboxJson({ Capabilities: [CAP_RECEIVE_V2] }))!;
    expect(fileOnly.Capabilities).not.toContain(CAP_TEXT_V1);
    expect(sendAvailability("dev1", fileOnly).sendable).toBe(true);
    // And a device that does announce it is carried verbatim, for the sender to
    // read when the text surface lands.
    const withText = parseDeviceInbox(inboxJson({ Capabilities: [CAP_RECEIVE_V2, CAP_TEXT_V1] }))!;
    expect(withText.Capabilities).toContain(CAP_TEXT_V1);
    expect(sendAvailability("dev1", withText).sendable).toBe(true);
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

// The bound a composer enables its Send button against. It has to be the same
// bound `sendTextToDevice` applies, measured the same way — a counter that
// disagrees with the seal either refuses a legal message or promises one the
// send then rejects after the user believed the length was fine.
describe("measuring a message draft", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(textDraftSize("abc").bytes).toBe(3);
    // Three bytes each in UTF-8.
    expect(textDraftSize("会议室").bytes).toBe(9);
    // Four: one astral code point, which is also two UTF-16 units — so both a
    // `.length` and a code-point count would be wrong here, in two directions.
    expect(textDraftSize("🙂").bytes).toBe(4);
    expect("🙂".length, "the JS length that must NOT be used").toBe(2);
    expect(textDraftSize("meet me at 6 — 会议室 B 🙂").bytes).toBe(
      new TextEncoder().encode("meet me at 6 — 会议室 B 🙂").length,
    );
  });

  it("measures the draft exactly as typed, never trimmed or normalized", () => {
    // Whitespace a user deliberately wrote is part of the message, and it is
    // what `sendTextToDevice` would seal — so it is what gets counted.
    expect(textDraftSize("  ").bytes).toBe(2);
    expect(textDraftSize("  ").sendable, "a whitespace message is still a message").toBe(true);
    expect(textDraftSize("a\n\n").bytes).toBe(3);
  });

  it("calls an empty draft empty and unsendable", () => {
    const empty = textDraftSize("");
    expect(empty).toEqual({ bytes: 0, empty: true, tooLong: false, sendable: false, overflow: 0 });
  });

  it("accepts both ends of the range and refuses one byte past it", () => {
    expect(textDraftSize("a").sendable).toBe(true);
    const atLimit = textDraftSize("a".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES));
    expect(atLimit.sendable).toBe(true);
    expect(atLimit.tooLong).toBe(false);
    expect(atLimit.overflow).toBe(0);

    const over = textDraftSize("a".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES + 1));
    expect(over.tooLong).toBe(true);
    expect(over.sendable).toBe(false);
    expect(over.overflow, "the sentence that says how far over would be wrong").toBe(1);
  });

  it("puts an emoji-only draft over the bound at the byte, not the character", () => {
    // 16385 emoji is 65 540 bytes: well inside any per-character limit and four
    // bytes past this one.
    const draft = "🙂".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES / 4 + 1);
    const size = textDraftSize(draft);
    expect(size.tooLong).toBe(true);
    expect(size.overflow).toBe(4);
    expect(draft.length, "a character count would have called this sendable").toBeLessThan(
      INBOX_MANIFEST_MAX_TEXT_BYTES,
    );
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
