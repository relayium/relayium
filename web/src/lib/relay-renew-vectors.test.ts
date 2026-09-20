import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAP_RENEW,
  RENEW_AUTH_LENGTH,
  RENEW_EPOCH_HARD_CAP_MS,
  RENEW_ICE_PROBE_MS,
  RENEW_MAX_EPOCHS_PER_ROUND,
  RENEW_MAX_HELD_CANDIDATES,
  RENEW_MAX_PROBE_VERIFICATIONS,
  RENEW_NONCE_BYTES,
  RENEW_PREPARE_SILENCE_MS,
  RENEW_PREPARE_TO_READY_MS,
  RENEW_PROBE_FRAME_BYTES,
  RENEW_PROBE_KIND,
  RENEW_PROBE_MAX_SENDS,
  RENEW_PROBE_RETRY_MS,
  RENEW_PROBE_TYPE_ACK,
  RENEW_PROBE_TYPE_PROBE,
  RENEW_PROBE_VERSION,
  RENEW_READY_TO_ANSWER_MS,
  RENEW_TAG_BYTES,
  candidateUfrag,
  decodeRenewProbe,
  encodeRenewProbe,
  inboundCandidateUfrag,
  parseIceGrant,
  parseRenewEnvelope,
  renewAbortPayload,
  renewIcePayload,
  renewPreparePayload,
  renewProbePayload,
  renewReadyPayload,
  renewSdpPayload,
  renewSignalPayload,
  sdpIceUfrag,
  sdpPin,
  sdpPinMatches,
  signRenew,
  signRenewProbe,
  toBase64,
  verifyRenew,
  verifyRenewProbe,
} from "./relay-renew-wire";

// ─────────────────────────────────────────────────────────────────────────────
// This suite is the AUTHORITY for `relay-renew-vectors.json`.
//
// The fixture is the only place the Web, Apple and Android implementations of
// this wire meet: the native ports assert against its bytes rather than
// re-deriving them from a reading of the spec. That makes it a claim about the
// Web implementation — and a claim nothing else can substantiate, because a
// hand-edited fixture and a drifted `relay-renew-wire.ts` produce exactly the
// same green board everywhere else.
//
// So every value below is recomputed from the PRODUCTION module and compared.
// If this file is red, either the fixture is stale or the wire changed; in both
// cases the three clients no longer agree and the answer is never to edit the
// expectation.
//
// The fixture is frozen for cross-author consumption. Changing any committed
// byte is a protocol change and needs the native authors told, not a test edit.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE = "../apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json";

interface PayloadVector {
  case: string;
  from?: string;
  to?: string;
  epoch?: number;
  round?: number;
  sdpType?: string;
  sdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string;
  reason?: string;
  payload: string;
  payloadUtf8Hex: string;
  tag: string;
}

interface ProbeVector {
  case: string;
  type: number;
  epoch: number;
  round: number;
  nonceHex: string;
  nonceBase64: string;
  payload: string;
  payloadUtf8Hex: string;
  tagHex: string;
  frameHex: string;
}

interface Fixture {
  capability: string;
  resumeAuthKeyHex: string;
  peers: { from: string; to: string; gnarly: string };
  constants: Record<string, number>;
  payloads: {
    prepare: PayloadVector[];
    ready: PayloadVector[];
    sdp: PayloadVector[];
    ice: PayloadVector[];
    abort: PayloadVector[];
  };
  probeFrames: ProbeVector[];
  envelopes: {
    accept: { case: string; json: unknown }[];
    reject: { case: string; why: string; json: unknown }[];
  };
  server: {
    request: { case: string; envelope: { type: string; data: { round: number; rid: number } } };
    grants: {
      accept: { case: string; json: Record<string, unknown> }[];
      reject: { case: string; why: string; json: unknown }[];
    };
  };
  sdpPin: {
    case: string;
    sdp: string;
    ufrag: string;
    pin?: { fingerprints: string[]; mids: string[]; setup: string };
    matchesBaselineAsOffer?: boolean;
    matchesBaselineAsAnswer?: boolean;
  }[];
  candidateUfrag: { case: string; candidate: string; ufrag: string }[];
  inboundCandidateUfrag: { case: string; candidate: string; usernameFragment: string; ufrag: string }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.importKey(
    "raw",
    unhex(fixture.resumeAuthKeyHex) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
});

describe("relay-renew fixture: identity", () => {
  it("names the capability this module implements", () => {
    expect(fixture.capability).toBe(CAP_RENEW);
  });

  it("pins every bound the three clients must agree on", () => {
    expect(fixture.constants).toEqual({
      probeKind: RENEW_PROBE_KIND,
      probeVersion: RENEW_PROBE_VERSION,
      probeTypeProbe: RENEW_PROBE_TYPE_PROBE,
      probeTypeAck: RENEW_PROBE_TYPE_ACK,
      probeFrameBytes: RENEW_PROBE_FRAME_BYTES,
      nonceBytes: RENEW_NONCE_BYTES,
      tagBytes: RENEW_TAG_BYTES,
      authLength: RENEW_AUTH_LENGTH,
      maxEpochsPerRound: RENEW_MAX_EPOCHS_PER_ROUND,
      maxProbeVerifications: RENEW_MAX_PROBE_VERIFICATIONS,
      maxHeldCandidates: RENEW_MAX_HELD_CANDIDATES,
      probeRetryMs: RENEW_PROBE_RETRY_MS,
      probeMaxSends: RENEW_PROBE_MAX_SENDS,
      prepareToReadyMs: RENEW_PREPARE_TO_READY_MS,
      readyToAnswerMs: RENEW_READY_TO_ANSWER_MS,
      iceProbeMs: RENEW_ICE_PROBE_MS,
      epochHardCapMs: RENEW_EPOCH_HARD_CAP_MS,
      prepareSilenceMs: RENEW_PREPARE_SILENCE_MS,
    });
  });

  it("uses the same resumeAuth key crypto-vectors.json already publishes", () => {
    const shared = JSON.parse(
      readFileSync("../apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json", "utf8"),
    ) as { resumeAuth: { keyHex: string } };
    // Not decoration: a native port that already loads that value for the leave
    // and resume tags needs no second key to check these vectors.
    expect(fixture.resumeAuthKeyHex).toBe(shared.resumeAuth.keyHex);
  });
});

describe("relay-renew fixture: canonical payloads", () => {
  /** Recompute one vector's payload from the production builder. */
  const rebuild = (kind: keyof Fixture["payloads"], v: PayloadVector): string => {
    const from = v.from as string;
    const to = v.to as string;
    switch (kind) {
      case "prepare": return renewPreparePayload(from, to, v.epoch as number);
      case "ready": return renewReadyPayload(from, to, v.epoch as number, v.round as number);
      case "sdp":
        return renewSdpPayload(
          from, to, v.epoch as number, v.round as number, v.sdpType as string, v.sdp as string,
        );
      case "ice":
        return renewIcePayload(
          from, to, v.epoch as number, v.round as number, v.candidate as string,
          v.sdpMid ?? null, v.sdpMLineIndex ?? null, v.usernameFragment as string,
        );
      case "abort":
        return renewAbortPayload(from, to, v.epoch as number, v.reason as "timeout");
    }
  };

  for (const kind of ["prepare", "ready", "sdp", "ice", "abort"] as const) {
    describe(kind, () => {
      for (const v of fixture.payloads[kind]) {
        it(`${v.case}: renders the committed string`, () => {
          expect(rebuild(kind, v)).toBe(v.payload);
        });
        it(`${v.case}: those exact UTF-8 bytes`, () => {
          // The bytes, not the string: §4.4's escaping rules are about what goes
          // into the HMAC, and a port that round-trips through a different
          // normalisation would still match on the string.
          expect(hex(utf8(v.payload))).toBe(v.payloadUtf8Hex);
        });
        it(`${v.case}: that tag, and it verifies`, async () => {
          expect(await signRenew(key, v.payload)).toBe(v.tag);
          expect(await verifyRenew(key, v.payload, v.tag)).toBe(true);
        });
      }
    });
  }

  it("every escaping rule §4.4 names is exercised by at least one vector", () => {
    const gnarly = fixture.payloads.prepare.find((v) => v.from === fixture.peers.gnarly);
    expect(gnarly, "a vector whose peer id carries the escaping cases").toBeTruthy();
    const rendered = gnarly!.payload;
    // Escaped forms.
    for (const escaped of ['\\"', "\\\\", "\\b", "\\t", "\\n", "\\f", "\\r", "\\u0001"]) {
      expect(rendered, `escapes ${JSON.stringify(escaped)}`).toContain(escaped);
    }
    // Emitted RAW, which is the half a JSON library is most likely to get wrong.
    for (const code of [0x7f, 0x2028, 0x2029]) {
      expect(rendered, `emits U+${code.toString(16)} raw`).toContain(String.fromCharCode(code));
    }
    // Astral: UTF-8, never a surrogate escape.
    expect(rendered).toContain(String.fromCodePoint(0x1f680));
    expect(rendered).not.toContain("\\ud");
  });

  it("the reversed direction is a different payload and a different tag", async () => {
    const forward = fixture.payloads.prepare.find((v) => v.case === "first epoch")!;
    const reversed = fixture.payloads.prepare.find(
      (v) => v.case === "reversed direction is a different payload",
    )!;
    // This is what makes a relay that reflects a signal back at its sender fail:
    // the sender verifies the reversed tuple, which it never signed.
    expect(reversed.payload).not.toBe(forward.payload);
    expect(reversed.tag).not.toBe(forward.tag);
    expect(await verifyRenew(key, forward.payload, reversed.tag)).toBe(false);
  });

  it("a tag over one kind never verifies over another", async () => {
    const prepare = fixture.payloads.prepare.find((v) => v.case === "first epoch")!;
    const ready = fixture.payloads.ready.find((v) => v.case === "round one")!;
    expect(await verifyRenew(key, ready.payload, prepare.tag)).toBe(false);
    expect(await verifyRenew(key, prepare.payload, ready.tag)).toBe(false);
  });

  it("renewSignalPayload agrees with the individual builders", () => {
    const from = fixture.peers.from;
    const to = fixture.peers.to;
    expect(renewSignalPayload({ type: "prepare", epoch: 1 }, from, to))
      .toBe(renewPreparePayload(from, to, 1));
    expect(renewSignalPayload({ type: "ready", epoch: 1, round: 1 }, from, to))
      .toBe(renewReadyPayload(from, to, 1, 1));
    expect(renewSignalPayload({ type: "abort", epoch: 1, reason: "timeout" }, from, to))
      .toBe(renewAbortPayload(from, to, 1, "timeout"));
  });
});

describe("relay-renew fixture: the data-lane control frame", () => {
  for (const v of fixture.probeFrames) {
    it(`${v.case}: payload, tag and 59 bytes`, async () => {
      const kind = v.type === RENEW_PROBE_TYPE_PROBE ? "link-renew-probe" : "link-renew-ack";
      const payload = renewProbePayload(
        kind, fixture.peers.from, fixture.peers.to, v.epoch, v.round, v.nonceBase64,
      );
      expect(payload).toBe(v.payload);
      expect(hex(utf8(payload))).toBe(v.payloadUtf8Hex);

      const nonce = unhex(v.nonceHex);
      expect(toBase64(nonce)).toBe(v.nonceBase64);

      const tag = await signRenewProbe(key, payload);
      expect(hex(tag)).toBe(v.tagHex);
      expect(await verifyRenewProbe(key, payload, tag)).toBe(true);

      const frame = encodeRenewProbe({
        type: v.type as typeof RENEW_PROBE_TYPE_PROBE,
        epoch: v.epoch,
        round: v.round,
        nonce,
        tag,
      });
      expect(frame.byteLength).toBe(RENEW_PROBE_FRAME_BYTES);
      expect(hex(new Uint8Array(frame))).toBe(v.frameHex);
    });

    it(`${v.case}: decodes back to the same fields`, () => {
      const frame = unhex(v.frameHex);
      const decoded = decodeRenewProbe(frame.buffer as ArrayBuffer);
      expect(decoded).toBeTruthy();
      expect(decoded!.type).toBe(v.type);
      expect(decoded!.epoch).toBe(v.epoch);
      expect(decoded!.round).toBe(v.round);
      expect(hex(decoded!.nonce)).toBe(v.nonceHex);
      expect(hex(decoded!.tag)).toBe(v.tagHex);
    });
  }

  it("a probe tag never verifies as its own ack", async () => {
    const probe = fixture.probeFrames.find((v) => v.type === RENEW_PROBE_TYPE_PROBE)!;
    const ack = fixture.probeFrames.find((v) => v.type === RENEW_PROBE_TYPE_ACK)!;
    // Same nonce, same epoch, same round — only the domain-separating `kind`
    // differs. Without it a reflected probe would read as an acknowledgement of
    // itself, which is exactly the proof the deadline advance rests on.
    expect(probe.nonceHex).toBe(ack.nonceHex);
    expect(await verifyRenewProbe(key, ack.payload, unhex(probe.tagHex))).toBe(false);
    expect(await verifyRenewProbe(key, probe.payload, unhex(ack.tagHex))).toBe(false);
  });
});

describe("relay-renew fixture: the signalling envelope", () => {
  for (const v of fixture.envelopes.accept) {
    it(`accepts: ${v.case}`, () => {
      expect(parseRenewEnvelope(v.json)).toBeTruthy();
    });
  }
  for (const v of fixture.envelopes.reject) {
    it(`rejects: ${v.case} — ${v.why}`, () => {
      expect(parseRenewEnvelope(v.json)).toBeNull();
    });
  }

  it("the rejected top-level-SDP envelope really does carry an SDP a handler would apply", () => {
    // Guards the fixture itself: a reject vector that happened to be malformed
    // for some OTHER reason would pass the assertion above while proving nothing
    // about the nesting rule this envelope exists to enforce.
    const hoisted = fixture.envelopes.reject.find((v) => v.case === "sdp hoisted to the top level")!;
    const json = hoisted.json as { sdp?: { type?: string } };
    expect(json.sdp?.type).toBe("offer");
  });
});

describe("relay-renew fixture: the server round envelopes", () => {
  it("the request envelope carries exactly round and rid", () => {
    const { envelope } = fixture.server.request;
    expect(envelope.type).toBe("ice-renew");
    expect(Object.keys(envelope.data).sort()).toEqual(["rid", "round"]);
  });

  for (const v of fixture.server.grants.accept) {
    it(`accepts a grant: ${v.case}`, () => {
      const grant = parseIceGrant(v.json);
      expect(grant).toBeTruthy();
      expect(grant!.status).toBe(v.json.status);
      expect(grant!.round).toBe(v.json.round);
      expect(grant!.rid).toBe(v.json.rid);
    });
  }
  for (const v of fixture.server.grants.reject) {
    it(`rejects a grant: ${v.case} — ${v.why}`, () => {
      expect(parseIceGrant(v.json)).toBeNull();
    });
  }

  it("a stale reply reports a round without granting credentials", () => {
    const stale = fixture.server.grants.accept.find(
      (v) => v.case === "stale reports the server's current round",
    )!;
    const grant = parseIceGrant(stale.json)!;
    expect(grant.status).toBe("stale");
    expect(grant.iceServers).toBeUndefined();
    expect(grant.relays).toBeUndefined();
  });
});

describe("relay-renew fixture: SDP pinning and ufrag binding", () => {
  const baseline = fixture.sdpPin.find((v) => v.case === "baseline")!;

  it("the baseline pin is the committed one", () => {
    expect(sdpPin(baseline.sdp)).toEqual(baseline.pin);
  });

  for (const v of fixture.sdpPin) {
    it(`${v.case}: ufrag`, () => {
      expect(sdpIceUfrag(v.sdp)).toBe(v.ufrag);
    });
    if (v.matchesBaselineAsOffer !== undefined) {
      it(`${v.case}: matches the baseline as an offer = ${v.matchesBaselineAsOffer}`, () => {
        expect(sdpPinMatches(sdpPin(baseline.sdp), sdpPin(v.sdp), false))
          .toBe(v.matchesBaselineAsOffer);
      });
    }
    if (v.matchesBaselineAsAnswer !== undefined) {
      it(`${v.case}: matches the baseline as an answer = ${v.matchesBaselineAsAnswer}`, () => {
        expect(sdpPinMatches(sdpPin(baseline.sdp), sdpPin(v.sdp), true))
          .toBe(v.matchesBaselineAsAnswer);
      });
    }
  }

  it("a renewal changes the ufrag and nothing else about the identity", () => {
    const renewal = fixture.sdpPin.find((v) => v.case.startsWith("renewal offer"))!;
    expect(sdpIceUfrag(renewal.sdp)).not.toBe(sdpIceUfrag(baseline.sdp));
    expect(sdpPin(renewal.sdp).fingerprints).toEqual(sdpPin(baseline.sdp).fingerprints);
  });

  for (const v of fixture.candidateUfrag) {
    it(`candidate ufrag: ${v.case}`, () => {
      expect(candidateUfrag(v.candidate)).toBe(v.ufrag);
    });
  }

  for (const v of fixture.inboundCandidateUfrag) {
    it(`inbound candidate ufrag: ${v.case}`, () => {
      expect(inboundCandidateUfrag(v.candidate, v.usernameFragment)).toBe(v.ufrag);
    });
  }
});
