// The Web half of the cross-language link-session state-machine vectors
// (W-N18 A08e), and the AUTHORITY half: `link-session-vectors.json` is written
// from this implementation, and this suite is what proves it still behaves as
// written.
//
// Each scenario drives the REAL `createMixedFileSession` /
// `createMixedTextSession` on a fake link. The other end is a scripted peer that
// seals every frame with the shipped `Sender` / `TextSender` under the peer's
// real session keys, so the subject's own demux, codecs and timers see exactly
// what a live peer would send. Timers are vitest fake timers; nothing here
// re-implements a lane rule.
//
// Regenerate the fixture with `npm run gen:vectors` (from web/); the generator
// is `web/scripts/gen-link-session-vectors.mjs`.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_MAX_MESSAGE_BYTES } from "./wire-limit";
import { deriveSession, generateKeyPair, ready, type SessionKeys } from "./crypto";
import {
  createMixedFileSession,
  MIXED_FILE_CONSENT_TIMEOUT_MS,
  MIXED_FILE_DRAIN_TIMEOUT_MS,
  MIXED_FILE_REPLAY_DELAY_MS,
  type MixedFileSession,
} from "./mixed-file-session.svelte";
import {
  createMixedTextSession,
  MIXED_TEXT_CONSENT_TIMEOUT_MS,
  MIXED_TEXT_END_ACK_TIMEOUT_MS,
  type MixedTextSession,
} from "./mixed-text-session.svelte";
import type { SaveTarget } from "./filesink";
import type { MixedPeerLink } from "./peer-link.svelte";
import {
  ACCEPT, BATCH_ABORT, COMPLETE, FILE_BUSY, REJECT, Receiver, Sender,
} from "./transfer";
import { TEXT_END, TEXT_REQUEST, TextReceiver, TextSender } from "./text-wire";
import { StoredKeysReceiver, StoredKeysSender } from "./preupload-handoff";
import {
  CAP_LINK, CapsAnnouncer, LINK_CAPS_ANNOUNCE_ATTEMPTS, LINK_CAPS_RETRY_INTERVAL_MS, capsSignal,
} from "./peer-caps.svelte";
import { isCliHandshakeSignal } from "./cli-peer.svelte";

const FIXTURE = "../apps/RelayiumKit/Tests/Fixtures/link-session-vectors.json";

interface Expect { emit: string[]; state: string }
interface Step { do: string; auto?: string[]; expect: Expect }
interface Divergence { consumer: string; step: number; expect: Expect; stopAfter?: boolean; followUp: string }
interface Scenario {
  name: string;
  role: "initiator" | "responder";
  consumers: string[];
  skip?: Record<string, string>;
  steps: Step[];
  divergences?: Divergence[];
}

const vectors = JSON.parse(readFileSync(FIXTURE, "utf8"));
const ME = "web";

// ── the plan a consumer executes: auto-merge, then divergences ──────────────

interface Planned { index: number; do: string; expect: Expect; stopAfter: boolean }

/** The shared reading of `stepSemantics` (fixture) for one consumer. */
function planFor(s: Scenario, me: string): Planned[] {
  const out: Planned[] = [];
  s.steps.forEach((st, index) => {
    const auto = (st.auto ?? []).includes(me);
    if (auto) {
      if (out.length === 0) throw new Error(`${s.name}: step ${index} is auto for ${me} but has no previous step`);
      const prev = out[out.length - 1];
      prev.expect = { emit: [...prev.expect.emit, ...st.expect.emit], state: st.expect.state };
      return;
    }
    out.push({ index, do: st.do, expect: { emit: [...st.expect.emit], state: st.expect.state }, stopAfter: false });
  });
  for (const d of s.divergences ?? []) {
    if (d.consumer !== me) continue;
    const at = out.find((p) => p.index === d.step);
    if (!at) throw new Error(`${s.name}: divergence names step ${d.step}, which ${me} does not perform`);
    at.expect = { emit: [...d.expect.emit], state: d.expect.state };
    at.stopAfter = !!d.stopAfter;
  }
  return out;
}

// ── real-time settling under fake timers ─────────────────────────────────────

// Captured BEFORE fake timers are installed: settling has to wait out real
// WebCrypto work, which no fake clock advances.
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

async function settle(snapshot: () => string) {
  let last = snapshot();
  let stable = 0;
  for (let i = 0; i < 500 && stable < 10; i++) {
    await realWait(4);
    const now = snapshot();
    if (now === last) stable++;
    else { stable = 0; last = now; }
  }
}

// ── fake channels: record what the subject sends, deliver what the peer sends ─

interface FakeChannel {
  sent: Uint8Array[];
  readyState: RTCDataChannelState;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

function fakeChannel(): FakeChannel {
  return {
    sent: [],
    readyState: "open",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    binaryType: "arraybuffer",
    onmessage: null,
    onclose: null,
    onbufferedamountlow: null,
    send(data) {
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.sent.push(view.slice());
    },
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.onclose?.();
    },
  };
}

function deliver(ch: FakeChannel, bytes: Uint8Array) {
  const copy = bytes.slice().buffer as ArrayBuffer;
  ch.onmessage?.(new MessageEvent("message", { data: copy }));
}

// ── abstract emission tokens (fixture `tokens`) ──────────────────────────────

function fileTokens(frames: Uint8Array[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    if (f.length === 1) {
      const name = { 0xfe: "ACCEPT", 0xff: "REJECT", 0xfd: "COMPLETE", 0xf9: "BUSY", 0xf8: "BATCH_ABORT" }[f[0]];
      out.push(name ?? `CTRL(0x${f[0].toString(16)})`);
      continue;
    }
    switch (f[0]) {
      case 11: case 10: continue; // parts are counted with their final frame
      case 7: out.push("MANIFEST"); break;
      case 1: out.push("CHUNK"); break;
      case 8: out.push("DONE"); break;
      case 6: out.push("ACK"); break;
      default: out.push(`KIND(${f[0]})`);
    }
  }
  return out;
}

function textTokens(frames: Uint8Array[]): string[] {
  return frames.map((f) => {
    if (f.length === 1) {
      return { 0xfa: "REQUEST", 0xfe: "ACCEPT", 0xff: "REJECT", 0xfb: "END" }[f[0]] ?? `CTRL(0x${f[0].toString(16)})`;
    }
    return f[0] === 9 ? "MESSAGE" : `KIND(${f[0]})`;
  });
}

// ── a keyed link pair ────────────────────────────────────────────────────────

async function keyedPair(role: "initiator" | "responder") {
  const mine = generateKeyPair();
  const theirs = generateKeyPair();
  const peerRole = role === "initiator" ? "responder" : "initiator";
  const keys = await deriveSession(role, mine, theirs.publicKey);
  const peerKeys = await deriveSession(peerRole, theirs, mine.publicKey);
  const file = fakeChannel();
  const text = fakeChannel();
  const link: MixedPeerLink = {
    peerId: "peer",
    role,
    conn: { close: vi.fn(), maxFrameBytes: () => CHROME_MAX_MESSAGE_BYTES } as unknown as MixedPeerLink["conn"],
    fileChannel: file as unknown as RTCDataChannel,
    textChannel: text as unknown as RTCDataChannel,
    keys,
    sas: "000000",
    fileSender: new Sender(),
    fileReceiver: new Receiver(),
    textSender: new TextSender(),
    textReceiver: new TextReceiver(),
    storedKeysSender: new StoredKeysSender(),
    storedKeysReceiver: new StoredKeysReceiver(),
  };
  return { link, file, text, peerKeys };
}

function memoryTarget(): SaveTarget {
  return {
    label: "memory",
    async file() {
      return { async write() {}, async close() {} };
    },
  };
}

const PEER_FILE = { name: "hello.txt", size: 5 };
const BODY = "hello";

/** The scripted file-lane peer: the shipped Sender, the peer's own keys. */
class FilePeer {
  #sender = new Sender();
  #frames: AsyncGenerator<Uint8Array> | null = null;
  #contentSeq = -1;
  constructor(private readonly keys: SessionKeys, private readonly ch: FakeChannel) {}

  #seq(): number { return (this.#sender as unknown as { seq: number }).seq; }

  async manifest(deliverIt = true) {
    const frames = await this.#sender.batchFrames([PEER_FILE], this.keys);
    if (deliverIt) for (const f of frames) deliver(this.ch, f);
    this.#frames = this.#sender.dataFrames([new File([BODY], PEER_FILE.name)], this.keys);
    this.#contentSeq = this.#seq();
  }

  async next(): Promise<Uint8Array> {
    if (!this.#frames) throw new Error("scripted peer: no batch announced");
    const r = await this.#frames.next();
    if (r.done) throw new Error("scripted peer: batch has no more frames");
    return r.value;
  }

  async content() { deliver(this.ch, await this.next()); }
  async done() { deliver(this.ch, await this.next()); }

  /** A DONE at the right sequence whose digest is for different bytes. */
  async doneMismatch() {
    const twin = new Sender();
    (twin as unknown as { seq: number }).seq = this.#contentSeq;
    const gen = twin.dataFrames([new File(["hellp"], PEER_FILE.name)], this.keys);
    await gen.next(); // the twin's chunk, never delivered
    const wrong = (await gen.next()).value as Uint8Array;
    await this.next(); // keep the real sender's sequence where the wire now is
    deliver(this.ch, wrong);
  }

  async contentUnannounced() {
    await this.manifest(false);
    await this.content();
  }

  control(bytes: Uint8Array) { deliver(this.ch, bytes); }
}

// ── the subject's abstract state ─────────────────────────────────────────────

function fileState(s: MixedFileSession, ch: FakeChannel): string {
  if (s.errorKey === "failed" || ch.readyState !== "open") return "Ended";
  if (s.incoming && !(s.recv && !s.recv.done)) return "InPrompt";
  if (s.recv && !s.recv.done) return "InRecv";
  if (s.recv?.done && !s.recv.ok && s.active() && !(s.send && !s.send.done)) return "InDrain";
  if (s.send && !s.send.done) {
    if (s.send.status === "sending") return "OutSend";
    if (s.send.status === "finishing") return "OutFinish";
    // "connecting" is a launch in progress (e.g. the responder's 250 ms glare
    // replay): nothing is on the wire yet, so the lane is still Idle.
    if (s.send.status === "connecting") return "Idle";
    return "OutWait";
  }
  return "Idle";
}

function textState(s: MixedTextSession): string {
  switch (s.status) {
    case "waitingAccept": return "WaitAccept";
    case "incomingRequest": return "Incoming";
    case "open": return "Open";
    case "failed": return "Failed";
    case "ended": return s.active() ? "EndWait" : "Idle";
    default: return "Idle";
  }
}

// ── bounds: every consumer maps the fixture's keys onto its own constants ────

const BOUND_CONSTANTS: Record<string, number> = {
  fileConsent: MIXED_FILE_CONSENT_TIMEOUT_MS,
  fileDrain: MIXED_FILE_DRAIN_TIMEOUT_MS,
  fileReplay: MIXED_FILE_REPLAY_DELAY_MS,
  textConsent: MIXED_TEXT_CONSENT_TIMEOUT_MS,
  textEndAck: MIXED_TEXT_END_ACK_TIMEOUT_MS,
  helloInterval: LINK_CAPS_RETRY_INTERVAL_MS,
};

function timerMs(name: string): number {
  const ms = vectors.bounds[name];
  if (typeof ms !== "number") throw new Error(`fixture has no bound ${name}`);
  return ms;
}

// ── runners ──────────────────────────────────────────────────────────────────

async function runFile(s: Scenario) {
  const { link, file, peerKeys } = await keyedPair(s.role);
  const subject = createMixedFileSession({
    ensureLink: async () => link,
    pickSaveTarget: async () => memoryTarget(),
    now: () => Date.now(),
  });
  subject.attach(link);
  const peer = new FilePeer(peerKeys, file);
  const snap = () => `${file.sent.length}|${fileState(subject, file)}|${JSON.stringify(subject.send)}|${JSON.stringify(subject.recv)}`;

  for (const p of planFor(s, ME)) {
    const before = file.sent.length;
    const op = p.do;
    if (op === "local:offer") subject.enqueue("peer", [{ file: new File([BODY], "out.txt") }]);
    else if (op === "local:accept") subject.accept();
    else if (op === "local:reject") subject.reject();
    else if (op === "local:cancel-in") subject.cancel("recv");
    else if (op === "local:cancel-out") subject.cancel("send");
    else if (op === "peer:manifest") await peer.manifest();
    else if (op === "peer:content") await peer.content();
    else if (op === "peer:done") await peer.done();
    else if (op === "peer:done-mismatch") await peer.doneMismatch();
    else if (op === "peer:content-unannounced") await peer.contentUnannounced();
    else if (op === "peer:ACCEPT") peer.control(ACCEPT);
    else if (op === "peer:REJECT") peer.control(REJECT);
    else if (op === "peer:BUSY") peer.control(FILE_BUSY);
    else if (op === "peer:BATCH_ABORT") peer.control(BATCH_ABORT);
    else if (op === "peer:COMPLETE") peer.control(COMPLETE);
    else if (op.startsWith("timer:")) vi.advanceTimersByTime(timerMs(op.slice(6)));
    else throw new Error(`${s.name}: the Web file consumer cannot map step "${op}"`);
    await settle(snap);
    const got = { emit: fileTokens(file.sent.slice(before)), state: fileState(subject, file) };
    expect(got, `${s.name} step ${p.index} (${op})`).toEqual(p.expect);
    if (p.stopAfter) break;
  }
  subject.reset();
}

async function runText(s: Scenario) {
  const { link, text, peerKeys } = await keyedPair(s.role);
  const subject = createMixedTextSession({ ensureLink: async () => link, now: () => Date.now() });
  subject.attach(link);
  const peerSender = new TextSender();
  const snap = () => `${text.sent.length}|${textState(subject)}|${subject.history.length}`;

  for (const p of planFor(s, ME)) {
    const before = text.sent.length;
    const op = p.do;
    if (op === "local:request") void subject.openWith("peer");
    else if (op === "local:accept") subject.accept();
    else if (op === "local:reject") subject.reject();
    else if (op === "local:end") subject.end();
    else if (op === "local:send") void subject.send("hi there");
    else if (op === "peer:REQUEST") deliver(text, TEXT_REQUEST);
    else if (op === "peer:ACCEPT") deliver(text, ACCEPT);
    else if (op === "peer:REJECT") deliver(text, REJECT);
    else if (op === "peer:END") deliver(text, TEXT_END);
    else if (op === "peer:message") deliver(text, await peerSender.frame("from peer", peerKeys.textSend));
    else if (op === "peer:unknown") deliver(text, new Uint8Array([0x0d, 0x00]));
    else if (op === "peer:short9") deliver(text, new Uint8Array([0x09, 0x00, 0x00]));
    else if (op.startsWith("timer:")) vi.advanceTimersByTime(timerMs(op.slice(6)));
    else throw new Error(`${s.name}: the Web text consumer cannot map step "${op}"`);
    await settle(snap);
    const got = { emit: textTokens(text.sent.slice(before)), state: textState(subject) };
    expect(got, `${s.name} step ${p.index} (${op})`).toEqual(p.expect);
    if (p.stopAfter) break;
  }
  subject.detach();
}

beforeEach(async () => {
  await ready();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("link-session vectors: fixture shape", () => {
  it("is the format this consumer reads, with the Web as the authority", () => {
    expect(vectors.format).toBe("relayium-link-session-vectors/1");
    expect(vectors.authority).toBe("web");
  });

  it("names bounds that are exactly the Web's constants", () => {
    for (const [key, value] of Object.entries(BOUND_CONSTANTS)) {
      expect(vectors.bounds[key], `bound ${key}`).toBe(value);
    }
    expect(Object.keys(vectors.bounds).sort()).toEqual(Object.keys(BOUND_CONSTANTS).sort());
  });

  it("gives every scenario an explicit decision for this consumer", () => {
    for (const s of [...vectors.file, ...vectors.text] as Scenario[]) {
      const listed = s.consumers.includes(ME);
      const skipped = !!s.skip?.[ME];
      expect(listed !== skipped, `${s.name}: web must be listed or skipped with a reason, not both/neither`).toBe(true);
      for (const d of s.divergences ?? []) expect(d.followUp, `${s.name}: divergence without a follow-up`).toBeTruthy();
    }
  });
});

describe("link-session vectors: file lane (web)", () => {
  for (const s of (vectors.file as Scenario[]).filter((x) => x.consumers.includes(ME))) {
    it(s.name, async () => { await runFile(s); });
  }
});

describe("link-session vectors: text lane (web)", () => {
  for (const s of (vectors.text as Scenario[]).filter((x) => x.consumers.includes(ME))) {
    it(s.name, async () => { await runText(s); });
  }
});

describe("link-session vectors: app peer models (web)", () => {
  it(vectors.appPeers.helloAtRosterGain.name, () => {
    const model = vectors.appPeers.helloAtRosterGain;
    expect(model.consumers).toContain(ME);
    expect(capsSignal().caps).toContain(model.helloCarries);
    expect(model.helloCarries).toBe(CAP_LINK);
    // The announcer's own injected-timer seam: a tick is the one retry timer firing.
    const timer: { pending: (() => void) | null } = { pending: null };
    const sent: string[] = [];
    const announcer = new CapsAnnouncer(
      (peerId) => { sent.push(peerId); },
      { setTimer: (fn, ms) => { expect(ms).toBe(timerMs("helloInterval")); timer.pending = fn; return 1; }, clearTimer: () => { timer.pending = null; } },
    );
    expect(LINK_CAPS_ANNOUNCE_ATTEMPTS).toBe(3);
    for (const [i, st] of (model.steps as { do: string; peers?: string[]; peer?: string; expect: { hello: string[] } }[]).entries()) {
      sent.length = 0;
      if (st.do === "roster") announcer.rosterChanged(st.peers!);
      else if (st.do === "tick") { const fn = timer.pending; timer.pending = null; fn?.(); }
      else if (st.do === "heard") announcer.didHearFrom(st.peer!);
      else throw new Error(`cannot map ${st.do}`);
      expect(sent, `step ${i} (${st.do})`).toEqual(st.expect.hello);
    }
  });

  it(vectors.appPeers.kindLatchesCli.name, () => {
    const model = vectors.appPeers.kindLatchesCli;
    expect(model.consumers).toContain(ME);
    for (const c of model.cases as { signal: unknown; cli: boolean }[]) {
      expect(isCliHandshakeSignal(c.signal), JSON.stringify(c.signal)).toBe(c.cli);
    }
  });
});
