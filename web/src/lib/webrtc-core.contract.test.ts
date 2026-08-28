import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { establish, LINK_CHANNEL_LABELS, type CoreOpts, type LinkCoreOpts, type SignalAuth } from "./webrtc-core";
import type { SignalingClient } from "./signaling";

// establish()'s construction rules — which generations can be built, which of
// them carries `auth`, and which lanes a link has — used to live only in
// `CoreOpts`. A type binds TypeScript callers; it does not bind a JavaScript
// one, a test reaching through `as never`, or options that arrived as `any`.
// These tests therefore make real calls with the shapes the union forbids and
// assert on OBSERVABLE refusal: no RTCPeerConnection was constructed and no
// signal was sent. Reading the source for a guard, or asserting that the
// compiler rejects the call, would prove neither.
//
// `as never` (rather than @ts-expect-error) is deliberate: `never` is assignable
// to every field, so each illegal shape below still typechecks. `npm run check`
// stays green whether or not the runtime guards exist, which is what makes these
// tests — and only these tests — the thing that fails when one is deleted.

class FakeDataChannel {
  binaryType = "";
  bufferedAmountLowThreshold = 0;
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(readonly label: string) {}
  send() {}
  close() { this.readyState = "closed"; }
  _open() { this.readyState = "open"; this.onopen?.(); }
}

/** The observable side effect the guards exist to prevent. Every construction
 *  is recorded, so "refused before the peer connection" is an assertion about
 *  this array rather than about the shape of the source. */
class FakePeerConnection {
  static constructed: FakePeerConnection[] = [];
  onicecandidate: ((e: unknown) => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  channels: FakeDataChannel[] = [];
  sctp = null;
  constructor(readonly config?: unknown) { FakePeerConnection.constructed.push(this); }
  createDataChannel(label: string) {
    const ch = new FakeDataChannel(label);
    this.channels.push(ch);
    return ch;
  }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.connectionState = "closed"; }
}

/** The other observable side effect: anything reaching the signalling path. Also
 *  counts subscriptions, so a refused call cannot leave a listener behind. */
function makeSignaling() {
  const state = {
    sent: [] as unknown[],
    subscriptions: 0,
    client: null as unknown as SignalingClient,
  };
  state.client = {
    onSignal(_cb: (from: string, data: unknown) => void) {
      state.subscriptions++;
      return () => {};
    },
    sendSignal(_to: string, data: unknown) {
      state.sent.push(data);
    },
  } as unknown as SignalingClient;
  return state;
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

const authStub = (): SignalAuth => ({
  sign: async () => "MAC",
  verify: async () => true,
});

/** A legal `link` call, used as the base every illegal shape below mutates so
 *  that exactly one rule is under test at a time. Typed as the `link` member
 *  rather than the union, so spreading it does not carry a `resume` branch that
 *  a `{ ...base, auth: undefined }` override would then contradict. */
const linkOpts = (signaling: SignalingClient): LinkCoreOpts => ({
  signaling,
  peerId: "peer",
  role: "initiator",
  generation: "link",
  channelLabels: LINK_CHANNEL_LABELS,
});

/** Call establish() for real with an illegal shape and prove the refusal landed
 *  before anything observable happened. */
async function refuses(build: (signaling: SignalingClient) => CoreOpts, message: RegExp) {
  const signaling = makeSignaling();
  const rejection = expect(establish(build(signaling.client))).rejects.toThrow(message);
  await rejection;
  await flush(); // nothing may surface on a later tick either
  expect(FakePeerConnection.constructed).toHaveLength(0);
  expect(signaling.sent).toEqual([]);
  expect(signaling.subscriptions).toBe(0);
}

beforeEach(() => {
  FakePeerConnection.constructed.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("establish() construction contract", () => {
  // Positive controls. Without these the refusal tests would pass just as
  // happily against an establish() that never constructs anything at all.
  it("constructs a peer connection and sends a tagged offer for a legal link", async () => {
    const signaling = makeSignaling();
    const p = establish(linkOpts(signaling.client));
    await flush();
    expect(FakePeerConnection.constructed).toHaveLength(1);
    expect(signaling.subscriptions).toBe(1);
    for (const ch of FakePeerConnection.constructed[0].channels) ch._open();
    const conn = await p;
    expect(conn.channel.label).toBe(LINK_CHANNEL_LABELS[0]);
    expect(conn.getChannel(LINK_CHANNEL_LABELS[1])?.label).toBe(LINK_CHANNEL_LABELS[1]);
    expect(signaling.sent).toContainEqual(expect.objectContaining({ link: true, sdp: { type: "offer", sdp: "offer" } }));
    conn.close();
  });

  it("constructs a peer connection and signs the offer for a legal resume", async () => {
    const signaling = makeSignaling();
    const p = establish({ ...linkOpts(signaling.client), generation: "resume", auth: authStub() });
    await flush();
    expect(FakePeerConnection.constructed).toHaveLength(1);
    for (const ch of FakePeerConnection.constructed[0].channels) ch._open();
    const conn = await p;
    expect(signaling.sent).toContainEqual(expect.objectContaining({ resume: true, auth: "MAC" }));
    conn.close();
  });

  // ── generation ────────────────────────────────────────────────────────────
  // `file` and `text` are inbound-classification names this build must keep
  // recognising and can never construct. Refusing them under their own name is
  // the point: falling back to `link` is how a retired generation stayed
  // reachable in the first place.
  for (const generation of ["file", "text", "", "link ", "LINK", "resume\n", "unknown"]) {
    it(`refuses generation ${JSON.stringify(generation)} instead of defaulting to link`, async () => {
      await refuses(
        (s) => ({ ...linkOpts(s), generation: generation as never }),
        /cannot establish generation/,
      );
    });
  }

  for (const [name, generation] of [
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { link: true }],
  ] as const) {
    it(`refuses ${name} as a generation`, async () => {
      await refuses(
        (s) => ({ ...linkOpts(s), generation: generation as never }),
        /cannot establish generation/,
      );
    });
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  it("refuses a resume with no auth rather than establishing an unauthenticated one", async () => {
    await refuses(
      (s) => ({ ...linkOpts(s), generation: "resume" as never }),
      /resume generation requires auth/,
    );
  });

  it("refuses a resume whose auth is explicitly undefined", async () => {
    await refuses(
      (s) => ({ ...linkOpts(s), generation: "resume" as never, auth: undefined as never }),
      /resume generation requires auth/,
    );
  });

  it("refuses a resume whose auth cannot sign or verify", async () => {
    // Presence alone would pass a JS caller's `{}` through, and the resulting
    // TypeError inside the send chain is logged, not fatal: a resume that emits
    // no signalling at all rather than one that is authenticated.
    await refuses(
      (s) => ({ ...linkOpts(s), generation: "resume" as never, auth: {} as never }),
      /resume generation requires auth/,
    );
    await refuses(
      (s) => ({ ...linkOpts(s), generation: "resume" as never, auth: { sign: authStub().sign } as never }),
      /resume generation requires auth/,
    );
  });

  it("refuses a link that carries auth it cannot have derived yet", async () => {
    await refuses(
      (s) => ({ ...linkOpts(s), auth: authStub() as never }),
      /link generation cannot carry auth/,
    );
  });

  it("accepts a link whose auth is merely absent-as-undefined", async () => {
    const signaling = makeSignaling();
    const p = establish({ ...linkOpts(signaling.client), auth: undefined });
    await flush();
    expect(FakePeerConnection.constructed).toHaveLength(1);
    for (const ch of FakePeerConnection.constructed[0].channels) ch._open();
    const conn = await p;
    expect(signaling.sent).toContainEqual(expect.objectContaining({ link: true }));
    conn.close();
  });

  // ── channelLabels ─────────────────────────────────────────────────────────
  // The tuple type made length and content compile-time facts only. At runtime
  // `readonly string[]` admitted every list below — including the one-element
  // legacy lane, which is exactly the single-lane connection that must stay
  // unbuildable after its lanes were deleted.
  const wrongTuples: [string, unknown][] = [
    ["the empty list", []],
    ["the legacy single lane", ["relayium"]],
    ["a single text lane", ["relayium-text"]],
    ["the pair in reverse order", ["relayium-text", "relayium"]],
    ["a duplicated primary lane", ["relayium", "relayium"]],
    ["a duplicated text lane", ["relayium-text", "relayium-text"]],
    ["arbitrary labels", ["a", "b"]],
    ["the right lanes plus an extra", ["relayium", "relayium-text", "relayium-extra"]],
    ["a near-miss label", ["relayium", "relayium-Text"]],
    ["a sparse array", [undefined, undefined]],
    ["a string instead of a list", "relayium"],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [name, labels] of wrongTuples) {
    it(`refuses ${name} as channelLabels`, async () => {
      await refuses(
        (s) => ({ ...linkOpts(s), channelLabels: labels as never }),
        /channelLabels must be exactly/,
      );
    });
  }

  it("refuses a wrong tuple on the resume generation too", async () => {
    await refuses(
      (s) => ({ ...linkOpts(s), generation: "resume", auth: authStub(), channelLabels: ["relayium"] as never }),
      /channelLabels must be exactly/,
    );
  });

  it("accepts a fresh array that equals the tuple, since only the labels are the contract", async () => {
    const signaling = makeSignaling();
    const p = establish({ ...linkOpts(signaling.client), channelLabels: [...LINK_CHANNEL_LABELS] as never });
    await flush();
    expect(FakePeerConnection.constructed).toHaveLength(1);
    for (const ch of FakePeerConnection.constructed[0].channels) ch._open();
    (await p).close();
  });
});
