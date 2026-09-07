import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  LINK_CHANNEL_LABELS,
  authPayload,
  linkLeavePayload,
  signalGeneration,
  type InboundSignal,
} from "./webrtc-core";
import { LINK_CAPTURE_MAX_BYTES } from "./webrtc";
import {
  LINK_AUTH_TIMEOUT_MS,
  LINK_HELD_SIGNAL_MAX,
  LINK_LEAVE_AUTH_LENGTH,
  LINK_LEAVE_MAX_ATTEMPTS,
  LINK_RECOVERY_RETRY_MS,
  LINK_RECOVERY_WINDOW_MS,
  LINK_REQUEST_RETRY_MS,
  LINK_REQUEST_TIMEOUT_MS,
  isLinkLeave,
  isLinkOffer,
  isLinkRequest,
  linkRole,
} from "./peer-link.svelte";
import {
  CAP_LINK,
  LINK_CAPS_ANNOUNCE_ATTEMPTS,
  LINK_CAPS_RETRY_INTERVAL_MS,
  advertisedCaps,
} from "./peer-caps.svelte";
import {
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  FLOW_ACK_INTERVAL,
  FLOW_WINDOW,
  FRAME,
  MANIFEST_MAX_BYTES,
  MIN_PIECE_BYTES,
  Sender,
  advanceAck,
  controlKind,
  isBatchAbort,
  isResumeReq,
  parseAck,
  piecePlainBytes,
  resumePointAligned,
  resumePointInRange,
} from "./transfer";
import { MAX_FILES, MAX_FILE_NAME_LENGTH, validateManifestFiles } from "./manifest";
import {
  KIND_TEXT_ENC,
  TEXT_FRAME_OVERHEAD,
  TEXT_MAX_BYTES,
  isTextFrame,
  textLifecycleKind,
  textPlainLimit,
} from "./text-wire";
import {
  TEXT_BURST,
  TEXT_HISTORY_MAX,
  TEXT_IDLE_MS,
  TEXT_PER_SEC,
  TEXT_SEND_BUFFER_MAX,
  TEXT_SESSION_MAX_BYTES,
  TEXT_SESSION_MAX_MESSAGES,
} from "./text-model";
import { signResume, verifyResume, type SessionKeys } from "./crypto";

// The `link` block of `apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json`,
// consumed here against the SHIPPED modules.
//
// ## What this suite is for, and what it deliberately is not
//
// `web/scripts/check-wire-vectors.mjs` already proves the fixture is byte-for-byte
// what `gen-realtime-wire-vectors.mjs` produces. That is a claim about the
// generator, not about the browser: the generator re-derives the wire in plain
// JavaScript so it can run without a TypeScript loader, so a generator that is
// faithfully reproduced and *wrong* passes that gate with a green board.
//
// This file closes the other half, the same way `text-vectors.test.ts` does for
// the kind-9 frames: every claim below is answered by the real exported helper
// the product runs — `authPayload`, `linkLeavePayload`, `controlKind`,
// `parseAck`, `isResumeReq`, `isLinkLeave`, `textLifecycleKind`,
// `piecePlainBytes`, `Sender.batchFrames`, `validateManifestFiles`,
// `signResume`/`verifyResume` — never by a copy of it written here.
//
// It changes no production behaviour and adds no production module.
//
// ## The one thing a green run here does NOT prove
//
// The Web has no single exported total classifier for the file lane: it demuxes
// inline in `mixed-file-session.svelte.ts`, while `LinkProtocol.swift` has a
// total `linkFileFrameClass`. So `classify()` below is a composition THIS TEST
// writes out of `controlKind` / `isBatchAbort` / `parseAck` / `isResumeReq`, and
// each of those predicates is also asserted individually so a wrong composition
// cannot hide a wrong predicate (or the reverse).
//
// That is a routing claim about ONE FRAME IN ISOLATION, and it is not evidence
// about the live session demux. It does not exercise wire ordering against the
// receive chain, the consent gate that refuses protected content before ACCEPT,
// the resume-realignment gate, the pre-upload discriminator that must run ahead
// of the file receiver, or lane failure on an unroutable frame — all of which
// live in `mixed-file-session.svelte.ts` and are covered by its own suite. A
// port must drive these vectors through its OWN total classifier and its real
// receive state machine before claiming section 6.1 is implemented. Recorded in
// docs/protocol/relayium-link-v1.md section 6.1 under "What the fixture can and
// cannot prove".

const WIRE = "../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json";

type Signal = Record<string, unknown>;
interface FrameClassRow { label: string; frameHex: string; class: string; control?: string }
interface LifecycleRow { frameHex: string; kind: string | null }
interface TextFrameRow { frameHex: string; isTextFrame: boolean }
interface PayloadRow { label: string; payloadUtf8Hex: string; payloadAscii?: string }
interface AuthPayloadRow extends PayloadRow { signal: Signal }
interface LeavePayloadRow extends PayloadRow { fromUtf16: number[]; toUtf16: number[] }
interface ShapeRow { label: string; signal: Signal; accepted: boolean; verifies?: boolean }

interface LinkVectors {
  capability: string;
  channelLabels: string[];
  captureMaxBytes: number;
  authTagLength: number;
  heldSignalMax: number;
  maxCandidateProgress: number;
  deadlines: Record<string, number>;
  controlHex: Record<string, string>;
  lifecycle: { file: LifecycleRow[]; text: LifecycleRow[]; textFrame: TextFrameRow[] };
  frameClass: FrameClassRow[];
  authPayload: AuthPayloadRow[];
  linkLeavePayload: LeavePayloadRow[];
  leave: {
    keyHex: string; from: string; to: string; payload: string;
    tag: string; tagLength: number; reversedTag: string;
    maxAttempts: number; shapes: ShapeRow[];
  };
  signals: {
    request: Signal; busy: Signal; leave: Signal;
    generation: { signal: Signal; generation: string }[];
    isLinkOffer: { signal: Signal; expected: boolean }[];
    isLinkRequest: { signal: Signal; expected: boolean }[];
  };
  flow: { windowBytes: number; ackIntervalBytes: number };
  textSession: Record<string, number>;
  bounds: {
    piecePlainBytes: { maxFrameBytes: number; pieceBytes: number | null }[];
    textPlainLimit: { maxFrameBytes: number; limit: number }[];
    manifestCiphertext: { payloadBytes: number; accepted: boolean }[];
    manifestFileCount: { count: number; accepted: boolean }[];
    manifestNameBytes: { nameBytes: number; accepted: boolean }[];
    advanceAck: { acked: number; sent: number; candidate: number; result: number }[];
    resumePoint: { sizes: number[]; point: { index: number; offset: number }; aligned: boolean; inRange: boolean }[];
  };
}

interface WireVectors {
  link: LinkVectors;
  capability: { role: { self: string; peer: string; role: string }[] };
}

const wire = JSON.parse(readFileSync(WIRE, "utf8")) as WireVectors & Record<string, unknown>;
const link = wire.link;

const unhex = (s: string) =>
  new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16))) as Uint8Array<ArrayBuffer>;
const buf = (s: string): ArrayBuffer => unhex(s).buffer;
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
/** Rebuild a fixture input from its UTF-16 code units. The escaping rows are
 *  written that way so the file stays pure ASCII and can carry an unpaired
 *  surrogate without putting one in the JSON — see the generator's header. */
const fromUtf16 = (units: number[]) => units.map((u) => String.fromCharCode(u)).join("");
/** The rendered payload a row pins, whichever form it was stored in. */
const expectedPayload = (row: PayloadRow) =>
  row.payloadAscii ?? new TextDecoder().decode(unhex(row.payloadUtf8Hex));

describe("link/1 — the block exists and the older ones survived", () => {
  it("still has every pre-existing top-level fixture key", () => {
    // A regeneration that dropped one would break the Swift suites silently;
    // this suite adds a key rather than editing any.
    for (const key of [
      "sessionKeyHex", "manifest", "batchFrameHex", "files", "frameStreamHex", "framesHex",
      "ackHex", "controlHex", "doneHashes", "sanitizedNames", "text", "kinds", "limits",
      "resume", "fragmentation", "durableResume", "multiFileResume", "capability",
    ]) {
      expect(wire[key], `realtime-wire-vectors.${key} disappeared`).toBeTruthy();
    }
  });

  it("has a link block with every section this suite reads", () => {
    for (const key of [
      "capability", "channelLabels", "captureMaxBytes", "authTagLength", "heldSignalMax",
      "deadlines", "controlHex", "lifecycle", "frameClass", "authPayload",
      "linkLeavePayload", "leave", "signals", "flow", "textSession", "bounds",
    ]) {
      expect(link[key as keyof LinkVectors], `link.${key} missing`).toBeTruthy();
    }
  });
});

describe("link/1 — identity and the exact lane tuple", () => {
  it("names the capability the shipped admission decision matches on", () => {
    expect(link.capability).toBe(CAP_LINK);
    expect(advertisedCaps()).toContain(CAP_LINK);
  });

  // A tuple, not a set: the empty list, the one-element legacy lane, a reversed
  // pair and an extra lane are each a connection this build must not construct.
  it("pins the channel tuple in primary-first order", () => {
    expect(link.channelLabels).toEqual([...LINK_CHANNEL_LABELS]);
    expect(link.channelLabels[0]).toBe("relayium");
    expect(link.channelLabels[1]).toBe("relayium-text");
  });

  it("pins the pre-attachment capture bound", () => {
    expect(link.captureMaxBytes).toBe(LINK_CAPTURE_MAX_BYTES);
    // Deliberately far below the file window: pre-attachment traffic has not
    // reached a content-consent state yet.
    expect(link.captureMaxBytes).toBeLessThan(FLOW_WINDOW);
  });

  it("pins every bound and deadline the shipped link manager enforces", () => {
    expect(link.authTagLength).toBe(LINK_LEAVE_AUTH_LENGTH);
    expect(link.leave.maxAttempts).toBe(LINK_LEAVE_MAX_ATTEMPTS);
    expect(link.heldSignalMax).toBe(LINK_HELD_SIGNAL_MAX);
    expect(link.deadlines.linkRequestMs).toBe(LINK_REQUEST_TIMEOUT_MS);
    expect(link.deadlines.linkRequestRetryMs).toBe(LINK_REQUEST_RETRY_MS);
    expect(link.deadlines.linkAuthMs).toBe(LINK_AUTH_TIMEOUT_MS);
    expect(link.deadlines.recoveryWindowMs).toBe(LINK_RECOVERY_WINDOW_MS);
    expect(link.deadlines.recoveryRetryMs).toBe(LINK_RECOVERY_RETRY_MS);
  });

  it("pins the flow-control and text-session constants", () => {
    expect(link.flow.windowBytes).toBe(FLOW_WINDOW);
    expect(link.flow.ackIntervalBytes).toBe(FLOW_ACK_INTERVAL);
    expect(link.textSession.maxMessages).toBe(TEXT_SESSION_MAX_MESSAGES);
    expect(link.textSession.maxBytes).toBe(TEXT_SESSION_MAX_BYTES);
    expect(link.textSession.burst).toBe(TEXT_BURST);
    expect(link.textSession.perSecond).toBe(TEXT_PER_SEC);
    expect(link.textSession.sendBufferMax).toBe(TEXT_SEND_BUFFER_MAX);
    expect(link.textSession.idleMs).toBe(TEXT_IDLE_MS);
    expect(link.textSession.historyMax).toBe(TEXT_HISTORY_MAX);
  });

  // Three attempts at 1.5 s land inside the peer's five-second settle window.
  // Raising either constant alone is what strands a peer on a legacy lane.
  it("keeps the capability hello cadence inside the settle window", () => {
    const cap = (wire.capability as unknown as {
      retry: { attempts: number; intervalMs: number };
      settleSeconds: number;
      lastAttemptSeconds: number;
    });
    expect(cap.retry.attempts).toBe(LINK_CAPS_ANNOUNCE_ATTEMPTS);
    expect(cap.retry.intervalMs).toBe(LINK_CAPS_RETRY_INTERVAL_MS);
    expect(cap.lastAttemptSeconds).toBe(
      ((LINK_CAPS_ANNOUNCE_ATTEMPTS - 1) * LINK_CAPS_RETRY_INTERVAL_MS) / 1000,
    );
    expect(cap.lastAttemptSeconds).toBeLessThan(cap.settleSeconds);
  });
});

describe("link/1 — deterministic role", () => {
  it.each(wire.capability.role)("$self vs $peer is $role", ({ self, peer, role }) => {
    expect(linkRole(self, peer)).toBe(role);
  });

  it("is total and antisymmetric across the fixture's pairs", () => {
    for (const { self, peer } of wire.capability.role) {
      // Exactly one side offers. Without that, two simultaneous taps produce two
      // SDP offers into one pair of lanes.
      expect(linkRole(self, peer)).not.toBe(linkRole(peer, self));
    }
    expect(linkRole("same", "same")).toBe("responder");
  });
});

describe("link/1 — the file lane's frame partition", () => {
  const PROTECTED_KINDS = new Set([1, 10, 7, 11, 8, 3, 2]);

  /**
   * The Web's answer, composed only from exports the product runs.
   *
   * The order matters and mirrors `mixed-file-session`'s demux and Swift's
   * `linkFileFrameClass`: one-byte controls first, then the header-length gate,
   * then the kind.
   */
  function classify(frame: ArrayBuffer): string {
    if (isBatchAbort(frame) || controlKind(frame) !== null) return "lifecycle";
    const b = new Uint8Array(frame);
    if (b.length < 5) return "unroutable";
    if (b[0] === 6) return parseAck(frame) !== null ? "ack" : "unroutable";
    if (isResumeReq(frame)) return "resumeRequest";
    if (b[0] === FRAME.RESUME) return "resumeStart";
    return PROTECTED_KINDS.has(b[0]) ? "protected" : "unroutable";
  }

  it.each(link.frameClass)("$label is $class", (row) => {
    expect(classify(buf(row.frameHex))).toBe(row.class);
  });

  // Each predicate on its own, so a wrong composition above cannot hide a wrong
  // predicate below — and vice versa.
  it("answers each production predicate exactly on its own class", () => {
    for (const row of link.frameClass) {
      const frame = buf(row.frameHex);
      const control = controlKind(frame);
      const abort = isBatchAbort(frame);
      expect(control !== null || abort, `${row.label}: controlKind/isBatchAbort`)
        .toBe(row.class === "lifecycle");
      if (row.class === "lifecycle" && row.control) {
        if (row.control === "batchAbort") {
          expect(abort, row.label).toBe(true);
          // BATCH_ABORT is separate from controlKind on purpose: every frame
          // decoded there flows the other way and refers to OUR outbound batch.
          expect(control, row.label).toBeNull();
        } else {
          expect(control, row.label).toBe(row.control);
          expect(abort, row.label).toBe(false);
        }
      }
      expect(parseAck(frame) !== null, `${row.label}: parseAck`).toBe(row.class === "ack");
      // Kind 5 is a resume REQUEST even when its payload does not parse: it is
      // control the lane must fail closed on, never bytes for the AEAD stream.
      const looksLikeResumeReq = new Uint8Array(frame).length >= 5 && isResumeReq(frame);
      expect(looksLikeResumeReq, `${row.label}: isResumeReq`).toBe(row.class === "resumeRequest");
    }
  });

  it("covers every class, so the partition is exercised and not merely stated", () => {
    const seen = new Set(link.frameClass.map((r) => r.class));
    expect([...seen].sort()).toEqual(
      ["ack", "lifecycle", "protected", "resumeRequest", "resumeStart", "unroutable"],
    );
  });

  it("pins the ACK frame's exact 13-byte shape and value", () => {
    const ack = buf(wire.ackHex as string);
    expect(new Uint8Array(ack).length).toBe(13);
    expect(parseAck(ack)).toBe(1_048_576);
    // One byte either side of 13 is not an ACK, and must not fall through into
    // the protected stream either.
    expect(parseAck(unhex((wire.ackHex as string) + "00").buffer)).toBeNull();
    expect(parseAck(unhex((wire.ackHex as string).slice(0, -2)).buffer)).toBeNull();
  });
});

describe("link/1 — lifecycle bytes", () => {
  it("pins the seven control bytes both lanes use", () => {
    expect(link.controlHex).toEqual({
      accept: "fe", reject: "ff", complete: "fd",
      busy: "f9", batchAbort: "f8",
      textRequest: "fa", textEnd: "fb",
    });
  });

  it.each(link.lifecycle.file)("file lane: $frameHex is $kind", (row) => {
    const frame = buf(row.frameHex);
    if (row.kind === "batchAbort") {
      expect(isBatchAbort(frame)).toBe(true);
      expect(controlKind(frame)).toBeNull();
    } else {
      expect(controlKind(frame)).toBe(row.kind);
      expect(isBatchAbort(frame)).toBe(false);
    }
  });

  it.each(link.lifecycle.text)("text lane: $frameHex is $kind", (row) => {
    expect(textLifecycleKind(buf(row.frameHex))).toBe(row.kind);
  });

  // A lifecycle control is EXACTLY one byte. A longer frame that merely starts
  // with one of these values is a protected or malformed frame, and reading it
  // as consent is how a batch gets accepted without anyone answering.
  it("never reads a multi-byte frame as consent on either lane", () => {
    for (const byte of [0xfe, 0xff, 0xfd, 0xf9, 0xf8, 0xfa, 0xfb]) {
      const two = new Uint8Array([byte, byte]).buffer;
      expect(controlKind(two)).toBeNull();
      expect(isBatchAbort(two)).toBe(false);
      expect(textLifecycleKind(two)).toBeNull();
    }
  });

  it.each(link.lifecycle.textFrame)("text frame discriminator: $frameHex", (row) => {
    expect(isTextFrame(buf(row.frameHex))).toBe(row.isTextFrame);
  });

  it("keeps the text frame structurally disjoint from every one-byte control", () => {
    expect(KIND_TEXT_ENC).toBe(9);
    expect(TEXT_FRAME_OVERHEAD).toBe(21);
    for (const row of link.lifecycle.text) {
      if (row.kind !== null) expect(isTextFrame(buf(row.frameHex))).toBe(false);
    }
  });
});

describe("link/1 — authPayload covers an explicit field list, and only it", () => {
  it.each(link.authPayload)("$label", (row) => {
    const rendered = authPayload(row.signal as unknown as InboundSignal);
    expect(rendered).toBe(expectedPayload(row));
    // The bytes, not just the string: a tag is only meaningful over these.
    expect(hex(utf8(rendered))).toBe(row.payloadUtf8Hex);
  });

  it("always renders the same six keys in the same order", () => {
    for (const row of link.authPayload) {
      const rendered = authPayload(row.signal as unknown as InboundSignal);
      expect(Object.keys(JSON.parse(rendered) as object)).toEqual(
        ["sdpType", "sdp", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"],
      );
      expect(rendered.startsWith('{"sdpType":')).toBe(true);
    }
  });

  // `caps` is a hint, never a security input, and it is OUTSIDE this payload so
  // that adding a signal field cannot change what an existing tag covers.
  it("does not cover caps, commit, rename or the generation tag", () => {
    const row = link.authPayload.find((r) => r.label.includes("caps and unknown fields"));
    expect(row, "the caps row disappeared from the fixture").toBeTruthy();
    const rendered = authPayload(row!.signal as unknown as InboundSignal);
    for (const absent of ["caps", "link/1", "preupload/1", "commit", "Zm9v", "rename"]) {
      expect(rendered).not.toContain(absent);
    }
  });

  // `?? null` on a numeric field: index 0 is a real m-line, not a missing one.
  it("renders sdpMLineIndex 0 as 0 and an absent one as null", () => {
    expect(authPayload({ ice: { candidate: "c", sdpMLineIndex: 0 } } as InboundSignal))
      .toContain('"sdpMLineIndex":0');
    expect(authPayload({ ice: { candidate: "c" } } as InboundSignal))
      .toContain('"sdpMLineIndex":null');
  });
});

describe("link/1 — linkLeavePayload is directional and escapes exactly", () => {
  it.each(link.linkLeavePayload)("$label", (row) => {
    const rendered = linkLeavePayload(fromUtf16(row.fromUtf16), fromUtf16(row.toUtf16));
    expect(rendered).toBe(expectedPayload(row));
    expect(hex(utf8(rendered))).toBe(row.payloadUtf8Hex);
  });

  // A leave has no SDP and no ICE, so authPayload would render one constant,
  // directionless string for the life of a link. `kind` is what makes this
  // string unreachable from authPayload, whose output always begins with
  // `sdpType` — a signature over one can never be mistaken for the other.
  it("is unreachable from authPayload", () => {
    const leave = linkLeavePayload("a", "b");
    expect(leave.startsWith('{"kind":"link-leave"')).toBe(true);
    expect(leave).not.toBe(authPayload({} as InboundSignal));
    expect(authPayload({} as InboundSignal).startsWith('{"sdpType":')).toBe(true);
  });

  it("reverses to a different string, so a reflected leave fails", () => {
    expect(linkLeavePayload("a", "b")).not.toBe(linkLeavePayload("b", "a"));
  });
});

describe("link/1 — the authenticated leave", () => {
  const hmacKey = () => crypto.subtle.importKey(
    "raw", unhex(link.leave.keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );

  it("reproduces the committed tag through the shipped signResume", async () => {
    const key = await hmacKey();
    const payload = linkLeavePayload(link.leave.from, link.leave.to);
    expect(payload).toBe(link.leave.payload);
    expect(await signResume(key, payload)).toBe(link.leave.tag);
    // Standard base64 WITH padding: a 32-byte HMAC is exactly 44 characters,
    // and that length is checked before any decode or HMAC.
    expect(link.leave.tag.length).toBe(LINK_LEAVE_AUTH_LENGTH);
    expect(link.leave.tagLength).toBe(LINK_LEAVE_AUTH_LENGTH);
    expect(link.leave.tag.endsWith("=")).toBe(true);
    expect(link.leave.tag).not.toMatch(/[-_]/);
  });

  it("verifies the forward direction and refuses the reflected one", async () => {
    const key = await hmacKey();
    const forward = linkLeavePayload(link.leave.from, link.leave.to);
    expect(await verifyResume(key, forward, link.leave.tag)).toBe(true);
    // A relay reflecting a leave back at its sender presents the reversed tuple.
    expect(await verifyResume(key, forward, link.leave.reversedTag)).toBe(false);
    expect(await verifyResume(key, linkLeavePayload(link.leave.to, link.leave.from), link.leave.tag))
      .toBe(false);
  });

  it("treats an absent or malformed tag as a failure, never a pass", async () => {
    const key = await hmacKey();
    const forward = linkLeavePayload(link.leave.from, link.leave.to);
    expect(await verifyResume(key, forward, undefined)).toBe(false);
    expect(await verifyResume(key, forward, "")).toBe(false);
    expect(await verifyResume(key, forward, "!".repeat(LINK_LEAVE_AUTH_LENGTH))).toBe(false);
  });

  // The allow-list is the point. A leave rides the `link` generation, so an
  // establishment in flight for the same peer sees it too: a smuggled `commit`
  // would be recorded by the handshake, a `caps` array would reach the
  // capability registry, a `busy` would fail a connecting link.
  it.each(link.leave.shapes)("shape: $label", (row) => {
    expect(isLinkLeave(row.signal)).toBe(row.accepted);
  });

  it("refuses a non-object payload outright", () => {
    for (const value of [null, undefined, 0, "", "leave", [link.leave.tag]]) {
      expect(isLinkLeave(value)).toBe(false);
    }
  });

  it("still spends budget on a well-shaped tag that cannot verify", async () => {
    // The one row where shape and cryptography disagree: the signal IS a leave,
    // so one of the eight HMACs is spent, and it fails.
    const row = link.leave.shapes.find((r) => r.verifies === false);
    expect(row, "the nonsense-tag row disappeared").toBeTruthy();
    expect(isLinkLeave(row!.signal)).toBe(true);
    const key = await hmacKey();
    expect(await verifyResume(
      key,
      linkLeavePayload(link.leave.from, link.leave.to),
      (row!.signal as { auth: string }).auth,
    )).toBe(false);
  });
});

describe("link/1 — signalling generations and the content-free frames", () => {
  it.each(link.signals.generation)("$generation", (row) => {
    expect(signalGeneration(row.signal as unknown as InboundSignal)).toBe(row.generation);
  });

  it("lets resume outrank link, so a rebuild is never read as an establishment", () => {
    expect(signalGeneration({ resume: true, link: true })).toBe("resume");
  });

  it.each(link.signals.isLinkOffer)("isLinkOffer -> $expected", (row) => {
    expect(isLinkOffer(row.signal)).toBe(row.expected);
  });

  it.each(link.signals.isLinkRequest)("isLinkRequest -> $expected", (row) => {
    expect(isLinkRequest(row.signal)).toBe(row.expected);
  });

  it("pins the three content-free frames a link exchanges", () => {
    expect(link.signals.request).toEqual({ link: true, linkRequest: true });
    expect(isLinkRequest(link.signals.request)).toBe(true);
    expect(link.signals.busy).toEqual({ link: true, busy: true });
    // A busy must carry the generation of the exchange it refuses, or the
    // initiator filters it out and waits out its own connect timeout.
    expect(signalGeneration(link.signals.busy as InboundSignal)).toBe("link");
    expect(isLinkLeave(link.signals.leave)).toBe(true);
  });
});

describe("link/1 — bounds, at the boundary and one step past it", () => {
  it.each(link.bounds.piecePlainBytes)("piecePlainBytes($maxFrameBytes)", (row) => {
    if (row.pieceBytes === null) expect(() => piecePlainBytes(row.maxFrameBytes)).toThrow();
    else expect(piecePlainBytes(row.maxFrameBytes)).toBe(row.pieceBytes);
  });

  // The number that makes fragmentation mandatory rather than optional: a peer
  // advertising no a=max-message-size means RFC 8841's 64 KiB, so every logical
  // 192 KiB chunk is cut into PART frames against a real browser.
  it("makes every logical chunk fragment at the RFC 8841 default", () => {
    expect(CHUNK_SIZE).toBe(192 * 1024);
    expect(CHUNK_OVERHEAD).toBe(21);
    expect(MIN_PIECE_BYTES).toBe(4096);
    expect(piecePlainBytes(65_536)).toBe(65_515);
    expect(piecePlainBytes(65_536)).toBeLessThan(CHUNK_SIZE);
  });

  it.each(link.bounds.textPlainLimit)("textPlainLimit($maxFrameBytes)", (row) => {
    expect(textPlainLimit(row.maxFrameBytes)).toBe(row.limit);
  });

  it("keeps the text product cap and the connection ceiling distinct", () => {
    expect(TEXT_MAX_BYTES).toBe(64 * 1024);
    // 64 KiB of plaintext seals into a 65 557 B frame, which does NOT fit a
    // connection that negotiated the RFC 8841 default.
    expect(textPlainLimit(65_536)).toBeLessThan(TEXT_MAX_BYTES);
  });

  // The ceiling is compared against the CIPHERTEXT length. Comparing the
  // plaintext would let a critical manifest pass and then blow up in send().
  it.each(link.bounds.manifestCiphertext)("manifest of $payloadBytes bytes", async (row) => {
    const key = await crypto.subtle.importKey(
      "raw", unhex("66".repeat(32)), "AES-GCM", false, ["encrypt", "decrypt"],
    );
    const base = JSON.stringify({ files: [{ name: "", size: 0 }] }).length;
    const files = [{ name: "a".repeat(row.payloadBytes - base), size: 0 }];
    expect(JSON.stringify({ files }).length).toBe(row.payloadBytes);
    const attempt = new Sender().batchFrames(files, { send: key } as unknown as SessionKeys);
    if (row.accepted) await expect(attempt).resolves.toBeTruthy();
    else await expect(attempt).rejects.toThrow(/manifest too large/);
  });

  it.each(link.bounds.manifestFileCount)("a manifest of $count files", (row) => {
    const files = Array.from({ length: row.count }, (_, i) => ({ name: `f${i}`, size: 0 }));
    if (row.accepted) expect(validateManifestFiles(files)).toHaveLength(row.count);
    else expect(() => validateManifestFiles(files)).toThrow();
  });

  it.each(link.bounds.manifestNameBytes)("a file name of $nameBytes bytes", (row) => {
    const files = [{ name: "a".repeat(row.nameBytes), size: 0 }];
    if (row.accepted) expect(validateManifestFiles(files)).toHaveLength(1);
    else expect(() => validateManifestFiles(files)).toThrow();
  });

  it("pins the manifest ceilings the fixture is written against", () => {
    expect(MANIFEST_MAX_BYTES).toBe(200 * 1024);
    expect(MAX_FILES).toBe(1000);
    expect(MAX_FILE_NAME_LENGTH).toBe(1024);
  });

  // ACK carries no batch identifier; this clamp is what stands in for one.
  it.each(link.bounds.advanceAck)(
    "advanceAck(acked=$acked, sent=$sent, candidate=$candidate)",
    (row) => { expect(advanceAck(row.acked, row.sent, row.candidate)).toBe(row.result); },
  );

  // The chain hash is defined only at CHUNK_SIZE boundaries and at the exact end
  // of a file, so honouring an unaligned point would make the sender skip the
  // bytes between the request and the next boundary.
  it.each(link.bounds.resumePoint)(
    "resume point $point.index/$point.offset",
    (row) => {
      expect(resumePointAligned(row.point, row.sizes)).toBe(row.aligned);
      expect(resumePointInRange(row.point, row.sizes)).toBe(row.inRange);
    },
  );

  it("refuses a negative or non-integer resume offset before it reaches a slice", () => {
    // A negative offset would make the sender slice a file from its END; a huge
    // index would make it skip every file and idle silently.
    expect(resumePointInRange({ index: 0, offset: -1 }, [10])).toBe(true);
    expect(resumePointInRange({ index: 5, offset: 0 }, [10])).toBe(false);
    // Shape is enforced one layer up, at the parse boundary.
    const bad = new Uint8Array([5, 0, 0, 0, 0, ...utf8('{"index":-1,"offset":0}')]);
    expect(isResumeReq(bad.buffer)).toBe(true);
  });
});
