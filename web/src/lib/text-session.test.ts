import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ready, generateKeyPair, deriveSession, type SessionKeys } from "./crypto";
import { TextSender, TEXT_FRAME_OVERHEAD, TEXT_MAX_BYTES } from "./text-wire";
import { CONSERVATIVE_MAX_MESSAGE_BYTES } from "./wire-limit";
import { ACCEPT, REJECT, COMPLETE } from "./transfer";
import { PeerBusyError } from "./webrtc";
import { recordPeerCaps, resetPeerCaps, CAP_TEXT } from "./peer-caps.svelte";
import {
  createTextSession, TEXT_HISTORY_MAX, TEXT_SESSION_MAX_MESSAGES, TEXT_SESSION_MAX_BYTES,
  TEXT_BURST, TEXT_IDLE_MS, TEXT_SEND_BUFFER_MAX, type TextConn,
} from "./text-session.svelte";

// A stand-in for the DataChannel: records what was sent, lets a test inject
// inbound frames, and never touches the network.
function fakeChannel() {
  return {
    sent: [] as ArrayBuffer[],
    readyState: "open" as string,
    bufferedAmount: 0,
    send(b: ArrayBuffer | Uint8Array) {
      this.sent.push(b instanceof Uint8Array ? (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) : b);
    },
    close() { this.readyState = "closed"; },
    onmessage: null as ((e: { data: ArrayBuffer }) => void) | null,
    onclose: null as (() => void) | null,
  };
}
type FakeChannel = ReturnType<typeof fakeChannel>;

const oneByte = (b: ArrayBuffer) => new Uint8Array(b)[0];

// Inbound frames run through a serialising chain whose links await Web Crypto,
// which resolves off the macrotask queue. Drain it the way webrtc.test.ts does.
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Drain the inbound chain until a condition holds, without a fixed tick count. */
async function drainUntil(pred: () => boolean, maxTicks = 4000) {
  for (let i = 0; i < maxTicks && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Stands in for the transport's bounded pre-ownership capture, as text-link
 * hands it to the session: ONE atomic drain that never replays.
 *
 * `frames` is filled by the test before the connection lands, because that is
 * when the real frames arrive — while deps.connect() is still resolving. The
 * probe also records the handler the channel had at the instant of the drain,
 * which is the ordering the whole handoff rests on.
 */
function makeCapture(overflow = false) {
  const frames: ArrayBuffer[] = [];
  const seen = { calls: 0, handlerAtDrain: undefined as unknown };
  return {
    frames,
    seen,
    take(channel: FakeChannel) {
      seen.calls++;
      seen.handlerAtDrain = channel.onmessage;
      return { frames: seen.calls === 1 ? frames.splice(0) : [], overflow };
    },
  };
}
type Capture = ReturnType<typeof makeCapture>;

async function harness(opts: { failWith?: Error; autoTick?: number; deferred?: boolean; transferActive?: () => boolean; maxFrameBytes?: number; capture?: Capture } = {}) {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const ka = await deriveSession("initiator", a, b.publicKey);
  const kb = await deriveSession("responder", b, a.publicKey);
  const ch = fakeChannel();
  let listener: ((peerId: string, conn: TextConn) => void) | undefined;
  let listening = false;
  // now() can auto-advance, so a test that needs the rate bucket to refill between
  // *processing* steps does not have to interleave ticks with injection.
  let clock = 0;
  const autoTick = opts.autoTick ?? 0;
  const now = () => { clock += autoTick; return clock; };
  const conn = (keys: SessionKeys, channel: FakeChannel, capture?: Capture): TextConn => ({
    channel, keys, sas: "123456", path: "lan", close: () => channel.close(),
    ...(capture ? { takeCaptured: () => capture.take(channel) } : {}),
    ...(opts.maxFrameBytes === undefined ? {} : { maxFrameBytes: () => opts.maxFrameBytes! }),
  });
  // deferred 模式：每次 connect 都挂起，测试自己决定什么时候、以什么顺序落地。
  const attempts: { ch: FakeChannel; resolve: () => void; reject: (e: Error) => void }[] = [];
  const connectFn = vi.fn(async () => {
    if (opts.deferred) {
      const channel = fakeChannel();
      return await new Promise<TextConn>((res, rej) => {
        attempts.push({
          ch: channel,
          resolve: () => res(conn(ka, channel)),
          reject: (e) => rej(e),
        });
      });
    }
    if (opts.failWith) throw opts.failWith;
    return conn(ka, ch, opts.capture);
  });
  const s = createTextSession({
    connect: connectFn,
    listen: (cb) => { listener = cb; return () => { listener = undefined; }; },
    transferActive: opts.transferActive,
    now,
  });
  return {
    s, ch, ka, kb, connectFn, attempts,
    /** Deliver an inbound text connection the way App.svelte's listener will. */
    inbound(peerId: string, channel: FakeChannel = ch, capture?: Capture) {
      if (!listening) { s.listenForRequests(); listening = true; }
      listener!(peerId, conn(kb, channel, capture));
    },
    /** Drive the initiator to "open" the way a real peer does: an ACCEPT byte. */
    async peerAccepts() {
      ch.onmessage!({ data: ACCEPT.buffer.slice(0) as ArrayBuffer });
      await Promise.resolve();
    },
  };
}

beforeEach(async () => { await ready(); resetPeerCaps(); });
afterEach(() => { vi.useRealTimers(); });

describe("text session", () => {
  // ── the capability gate ────────────────────────────────────────────────────
  it("refuses to open toward a peer that never announced text support", async () => {
    const { s } = await harness();
    await s.openWith("p1");
    expect(s.status).toBe("unsupported");
    expect(s.errorKey).toBe("unsupported");
    expect(s.history.length).toBe(0);
  });

  it("does not even attempt a connection to an unannounced peer", async () => {
    const { s, connectFn } = await harness();
    await s.openWith("p1");
    // The whole point of the roster-level hello: an older peer is never offered
    // a connection it would misread as a file transfer.
    expect(connectFn).not.toHaveBeenCalled();
  });

  it("opens toward a peer that announced, and reports the SAS and path", async () => {
    const { s } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(s.status).toBe("waitingAccept");
    expect(s.sasCode).toBe("123456");
    expect(s.path).toBe("lan");
    expect(s.peerId).toBe("p1");
  });

  it("surfaces a busy peer as its own state, not a failure", async () => {
    const { s } = await harness({ failWith: new PeerBusyError() });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(s.status).toBe("peerBusy");
    expect(s.errorKey).toBe("peerBusy");
  });

  it("surfaces any other connect failure as failed", async () => {
    const { s } = await harness({ failWith: new Error("ice timeout") });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(s.status).toBe("failed");
    expect(s.errorKey).toBe("failed");
  });

  // ── the accept handshake ───────────────────────────────────────────────────
  it("cannot send until the peer accepts", async () => {
    const { s, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await s.send("too early");
    expect(ch.sent.length).toBe(0);
    expect(s.history.length).toBe(0);
  });

  it("an ACCEPT byte from the peer opens the session", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    expect(s.status).toBe("open");
  });

  it("a REJECT byte from the peer ends it as refused", async () => {
    const { s, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    ch.onmessage!({ data: REJECT.buffer.slice(0) as ArrayBuffer });
    await Promise.resolve();
    expect(s.status).toBe("refused");
    expect(ch.readyState).toBe("closed");
  });

  // The channel is ordered, so a message before ACCEPT cannot happen honestly.
  it("treats a message arriving before acceptance as a protocol failure", async () => {
    const { s, ch, kb } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    const peer = new TextSender();
    ch.onmessage!({ data: (await peer.frame("jumped the gun", kb.textSend)).buffer as ArrayBuffer });
    await settle();
    expect(s.status).toBe("failed");
    expect(s.history.length).toBe(0);
  });

  it("ignores a stray COMPLETE byte from the file protocol", async () => {
    const { s, peerAccepts, ch } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    ch.onmessage!({ data: COMPLETE.buffer.slice(0) as ArrayBuffer });
    await Promise.resolve();
    expect(s.status).toBe("open");
  });

  // ── sending ────────────────────────────────────────────────────────────────
  it("records a sent message and puts a sealed frame on the channel", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("  hello\n\tworld  ");
    expect(s.history.at(-1)).toMatchObject({ dir: "out", body: "  hello\n\tworld  ", failed: false });
    expect(ch.sent.length).toBe(1);
    expect(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(ch.sent[0])))
      .not.toContain("hello");
  });

  it("refuses an over-limit message and adds nothing to history", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("a".repeat(TEXT_MAX_BYTES + 1));
    expect(ch.sent.length).toBe(0);
    expect(s.history.length).toBe(0);
    expect(s.errorKey).toBe("tooLong");
  });

  // A 64 KiB message is inside the product cap but seals into a 65 557 B frame,
  // which a peer that negotiated the RFC 8841 default of 65 536 cannot take.
  // send() would throw and the channel would be gone; refuse it instead.
  it("refuses a message this connection cannot carry, and stays open", async () => {
    const { s, ch, peerAccepts } = await harness({ maxFrameBytes: CONSERVATIVE_MAX_MESSAGE_BYTES });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("a".repeat(TEXT_MAX_BYTES));
    expect(s.errorKey).toBe("tooLong");
    expect(ch.sent.length).toBe(0);
    expect(s.history.length).toBe(0);
    expect(s.status).toBe("open");
    await s.send("a".repeat(TEXT_MAX_BYTES - TEXT_FRAME_OVERHEAD)); // the largest that fits
    expect(s.errorKey).toBe("");
    expect(s.history.length).toBe(1);
  });

  it("clears a previous error once a send succeeds", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("a".repeat(TEXT_MAX_BYTES + 1));
    expect(s.errorKey).toBe("tooLong");
    await s.send("fine");
    expect(s.errorKey).toBe("");
  });

  // Concurrency, and the reason the plan was amended: TextSender.frame takes its
  // seq before awaiting seal, so unserialised sends can reach the wire in the
  // wrong seq order and the peer hard-fails the session.
  it("serialises concurrent sends so the wire seq order is monotonic", async () => {
    const { s, ch, peerAccepts, kb } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await Promise.all(["one", "two", "three", "four", "five"].map((m) => s.send(m)));
    const seqs = ch.sent.map((b) => new DataView(b).getUint32(1));
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    // And they open in that order against a fresh receiver.
    const { TextReceiver } = await import("./text-wire");
    const r = new TextReceiver();
    const got: string[] = [];
    for (const b of ch.sent) got.push(await r.feed(new Uint8Array(b) as Uint8Array<ArrayBuffer>, kb.textRecv));
    expect(got).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("refuses to send when the peer has stopped draining, and says so", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    ch.bufferedAmount = TEXT_SEND_BUFFER_MAX + 1;
    await s.send("into a full buffer");
    expect(ch.sent.length).toBe(0);
    // Recorded as failed, not dropped: plaintext the user believes was delivered
    // is the outcome to avoid.
    expect(s.history.at(-1)).toMatchObject({ dir: "out", failed: true });
  });

  // ── consent ────────────────────────────────────────────────────────────────
  it("shows no content before the user accepts an inbound request", async () => {
    const { s, ch, inbound } = await harness();
    inbound("p2");
    expect(s.status).toBe("incomingRequest");
    expect(s.peerId).toBe("p2");
    expect(s.sasCode).toBe("123456");
    expect(s.history.length).toBe(0);
    // Nothing is attached, so nothing can be decrypted or rendered.
    expect(ch.onmessage).toBe(null);
  });

  it("delivers the peer's messages in order once accepted", async () => {
    const { s, ch, ka, inbound } = await harness();
    inbound("p2");
    s.accept();
    expect(oneByte(ch.sent[0])).toBe(0xfe); // the peer is told
    const peer = new TextSender();
    for (const m of ["first", "second", "third"]) {
      ch.onmessage!({ data: (await peer.frame(m, ka.textSend)).buffer as ArrayBuffer });
    }
    await settle();
    expect(s.history.map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(s.history.every((m) => m.dir === "in")).toBe(true);
  });

  it("closes the channel on reject, tells the peer, and refuses later offers from it", async () => {
    const { s, ch, inbound } = await harness();
    inbound("p2");
    s.reject();
    expect(oneByte(ch.sent[0])).toBe(0xff);
    expect(ch.readyState).toBe("closed");
    expect(s.status).toBe("idle");
    const ch2 = fakeChannel();
    inbound("p2", ch2);
    expect(s.status).toBe("idle");
    expect(ch2.readyState).toBe("closed");
    expect(ch2.onmessage).toBe(null);
  });

  it("still accepts an offer from a different peer after refusing one", async () => {
    const { s, inbound } = await harness();
    inbound("p2");
    s.reject();
    const ch3 = fakeChannel();
    inbound("p3", ch3);
    expect(s.status).toBe("incomingRequest");
  });

  it("refuses a second inbound request while a session is live", async () => {
    const { s, inbound } = await harness();
    inbound("p2");
    s.accept();
    const ch2 = fakeChannel();
    inbound("p3", ch2);
    expect(s.peerId).toBe("p2");
    expect(ch2.readyState).toBe("closed");
  });

  // ── lifecycle ──────────────────────────────────────────────────────────────
  it("ends the session when the connection drops, keeping history visible", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("kept");
    ch.onclose!();
    expect(s.status).toBe("ended");
    expect(s.history.map((m) => m.body)).toEqual(["kept"]);
  });

  it("end() closes the connection and stops the session", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    s.end();
    expect(s.status).toBe("ended");
    expect(ch.readyState).toBe("closed");
    await s.send("after the end");
    expect(ch.sent.length).toBe(0);
  });

  it("ends the session after the idle timeout with no traffic", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    vi.useFakeTimers();
    await s.openWith("p1");
    await peerAccepts();
    vi.advanceTimersByTime(TEXT_IDLE_MS + 1);
    expect(s.status).toBe("ended");
  });

  it("traffic pushes the idle deadline out", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    vi.useFakeTimers();
    await s.openWith("p1");
    await peerAccepts();
    vi.advanceTimersByTime(TEXT_IDLE_MS - 100);
    expect(s.status).toBe("open");
    await s.send("still here");
    vi.advanceTimersByTime(TEXT_IDLE_MS - 100);
    expect(s.status).toBe("open");
  });

  it("active() covers every state a session is in and no other", async () => {
    const { s, inbound } = await harness();
    expect(s.active()).toBe(false);
    inbound("p2");
    expect(s.active()).toBe(true);
    s.accept();
    expect(s.active()).toBe(true);
    s.end();
    expect(s.active()).toBe(false);
  });

  // ── mutual exclusion with a file transfer ──────────────────────────────────
  // busy() 一直是单向的：消息会话会挡住文件传输，但文件传输挡不住消息会话，因为入站
  // 那一侧只看自己的 active()。结果是对端可以在你正在传文件的时候开一场消息会话，屏幕
  // 上同时挂两串不同的 6 位数——而这正是那条互斥要挡的东西。
  it("refuses an inbound request while a file transfer is active", async () => {
    const { s, ch, inbound } = await harness({ transferActive: () => true });
    inbound("p2", ch);
    expect(s.status).toBe("idle");
    expect(s.active()).toBe(false);
    expect(ch.readyState).toBe("closed");
    expect(ch.onmessage).toBe(null); // nothing attached, so nothing decrypted
    expect(s.history).toEqual([]);
    expect(s.sasCode).toBe("");      // no second SAS ever reaches the UI
  });

  it("refuses to open toward a peer while a file transfer is active", async () => {
    const { s, connectFn } = await harness({ transferActive: () => true });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(connectFn).not.toHaveBeenCalled();
    expect(s.status).toBe("idle");
  });

  it("canAcceptFrom reports the same decision the guard makes", async () => {
    const busy = await harness({ transferActive: () => true });
    expect(busy.s.canAcceptFrom("p2")).toBe(false);

    const free = await harness();
    expect(free.s.canAcceptFrom("p2")).toBe(true);
    free.inbound("p2");
    // Already in a session: a second peer is refused.
    expect(free.s.canAcceptFrom("p3")).toBe(false);
  });

  it("canAcceptFrom refuses a peer that was declined", async () => {
    const { s, inbound } = await harness();
    inbound("p2");
    s.reject();
    expect(s.canAcceptFrom("p2")).toBe(false);
    expect(s.canAcceptFrom("p3")).toBe(true);
  });

  // 正面对照：没有文件传输在跑的时候，一切照旧。
  it("accepts an inbound request normally when no transfer is active", async () => {
    const { s, ch, inbound } = await harness({ transferActive: () => false });
    inbound("p2", ch);
    expect(s.status).toBe("incomingRequest");
    expect(ch.readyState).toBe("open");
    s.accept();
    expect(s.status).toBe("open");
  });

  it("opens normally when no transfer is active", async () => {
    const { s, connectFn } = await harness({ transferActive: () => false });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(s.status).toBe("waitingAccept");
  });

  it("works with no transferActive dep at all, so nothing existing has to pass one", async () => {
    const { s, inbound } = await harness();
    inbound("p2");
    expect(s.status).toBe("incomingRequest");
  });

  // ── the ACCEPT ordering ────────────────────────────────────────────────────
  // acceptEchoesAFrame dispatches a peer frame SYNCHRONOUSLY from inside
  // channel.send(ACCEPT), which is the real race: the peer can answer the instant
  // it sees ACCEPT. A DataChannel message event dispatched with no listener
  // attached is dropped -- there is no replay -- so sending ACCEPT before
  // installing the handler loses the peer's first message. With send-then-attach
  // this test sees an empty history.
  function acceptEchoesAFrame(frame: ArrayBuffer) {
    const ch = fakeChannel();
    const realSend = ch.send.bind(ch);
    ch.send = (b: ArrayBuffer | Uint8Array) => {
      realSend(b);
      const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
      if (bytes.length === 1 && bytes[0] === 0xfe) {
        // No listener yet? Then it is gone, exactly as the transport would.
        ch.onmessage?.({ data: frame });
      }
    };
    return ch;
  }

  it("installs the inbound handler before sending ACCEPT, so the first message survives", async () => {
    const { s, ka, kb, inbound } = await harness();
    const peer = new TextSender();
    const first = await peer.frame("the peer's very first message", ka.textSend);
    void kb;
    const ch = acceptEchoesAFrame(first.buffer as ArrayBuffer);

    inbound("p2", ch);
    expect(ch.onmessage).toBe(null); // nothing attached before consent
    s.accept();
    await settle();

    expect(s.history.map((m) => m.body)).toEqual(["the peer's very first message"]);
    expect(oneByte(ch.sent[0])).toBe(0xfe); // ACCEPT still went out
    expect(s.status).toBe("open");
  });

  // The invariant the ordering change must not weaken: before the user accepts,
  // nothing is attached, so a peer that sends early has its content dropped rather
  // than decrypted or rendered.
  it("drops a pre-consent frame rather than rendering it", async () => {
    const { s, ka, ch, inbound } = await harness();
    const peer = new TextSender();
    const early = await peer.frame("sent before consent", ka.textSend);

    inbound("p2", ch);
    expect(ch.onmessage).toBe(null);
    // The transport would have nowhere to deliver this; assert we never render it.
    expect(s.history).toEqual([]);
    expect(s.status).toBe("incomingRequest");

    // After consent the session works normally -- the early frame is simply gone,
    // which is the safe direction.
    s.accept();
    ch.onmessage!({ data: (await peer.frame("after consent", ka.textSend)).buffer as ArrayBuffer });
    await settle();
    // seq 0 was burned by the dropped frame, so the receiver rejects seq 1 as
    // out-of-order: a peer that jumps the gun breaks its own session, and does so
    // loudly rather than by silently losing content.
    expect(s.status).toBe("failed");
    expect(s.history.map((m) => m.body)).not.toContain("sent before consent");
    void early;
  });

  // ── the window before the initiator owns its channel ───────────────────────
  // The reported LAN failure. The initiator's channel is open long before
  // deps.connect() resolves: the key handshake and the path sample both run
  // after it. A responder that auto-accepts -- the shipped default -- puts its
  // ACCEPT byte on the wire inside that window, and a DataChannel does not
  // replay events delivered with no handler attached. The transport therefore
  // retains those frames under a bound, and the session drains them at the
  // instant it takes ownership.

  it("opens on an ACCEPT that landed before the session took ownership", async () => {
    const capture = makeCapture();
    const { s } = await harness({ capture });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    // Arrives while deps.connect() is still resolving -- the only place it can.
    capture.frames.push(ACCEPT.buffer.slice(0) as ArrayBuffer);

    await s.openWith("p1");
    await drainUntil(() => s.status === "open");
    expect(s.status).toBe("open");
    // Drained exactly once, and only after a live handler was in place: a drain
    // that ran first would leave a gap of its own for the next frame.
    expect(capture.seen.calls).toBe(1);
    expect(typeof capture.seen.handlerAtDrain).toBe("function");
  });

  it("replays a captured ACCEPT and the message behind it in arrival order", async () => {
    const capture = makeCapture();
    const { s, kb } = await harness({ capture });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    const peer = new TextSender();
    // Exactly what a phone does: auto-accept, then the user types immediately.
    capture.frames.push(ACCEPT.buffer.slice(0) as ArrayBuffer);
    capture.frames.push((await peer.frame("first thing they typed", kb.textSend)).buffer as ArrayBuffer);

    await s.openWith("p1");
    await drainUntil(() => s.history.length > 0 || s.status === "failed");
    // Out-of-order replay would deliver the message frame while the session is
    // still waitingAccept, which is a hard failure -- so this also pins FIFO.
    expect(s.status).toBe("open");
    expect(s.history.map((m) => m.body)).toEqual(["first thing they typed"]);
  });

  it("discards frames captured before consent instead of replaying them", async () => {
    const capture = makeCapture();
    const { s, ka, ch, inbound } = await harness();
    const peer = new TextSender();
    capture.frames.push((await peer.frame("sent before consent", ka.textSend)).buffer as ArrayBuffer);

    inbound("p2", ch, capture);
    expect(s.status).toBe("incomingRequest");
    // Retention must not become a way in: the responder throws the frames away
    // as it publishes the request, while nothing is attached to receive them.
    expect(capture.seen.calls).toBe(1);
    expect(capture.seen.handlerAtDrain).toBe(null);
    expect(ch.onmessage).toBe(null);

    s.accept();
    await settle();
    expect(s.status).toBe("open");
    expect(s.history).toEqual([]);
  });

  it("fails closed when the capture overflowed rather than replay a hole", async () => {
    const capture = makeCapture(true);
    const { s, ch } = await harness({ capture });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });

    await s.openWith("p1");
    // A gap in an ordered stream is exactly what the receiver cannot tolerate,
    // and it cannot be told apart from tampering. Say so instead of guessing.
    expect(s.status).toBe("failed");
    expect(s.errorKey).toBe("failed");
    expect(ch.readyState).toBe("closed");
  });

  it("refuses an incoming request whose pre-consent capture overflowed", async () => {
    const capture = makeCapture(true);
    const { s, ka, ch, inbound } = await harness();
    const peer = new TextSender();
    capture.frames.push((await peer.frame("sent before consent", ka.textSend)).buffer as ArrayBuffer);

    inbound("p2", ch, capture);
    await settle();

    // Overflow says the transport dropped an unknown amount of what this peer
    // pushed before anyone was asked. Throwing away what survived is not enough:
    // the request is never published at all, so there is no card to accept, no
    // SAS on screen, and nothing attached that could decrypt a later frame.
    expect(s.status).toBe("idle");
    expect(s.peerId).toBe("");
    expect(s.sasCode).toBe("");
    expect(s.path).toBe(undefined);
    expect(s.history).toEqual([]);
    expect(s.active()).toBe(false);
    expect(ch.onmessage).toBe(null);
    expect(ch.readyState).toBe("closed");

    // And accepting a request that was never published must not resurrect it.
    s.accept();
    await settle();
    expect(s.status).toBe("idle");
    expect(s.history).toEqual([]);
  });

  // ── stale attempts ─────────────────────────────────────────────────────────
  // openWith awaits deps.connect. Anything that ends the session while that await
  // is outstanding -- end(), a room switch, a decline -- must not be undone when
  // the connection finally lands. Before the epoch guard the continuation assigned
  // conn/keys, re-attached handlers and set status back to "waitingAccept",
  // resurrecting a session the user had closed and leaking the connection.
  it("a connection arriving after end() is closed and changes nothing", async () => {
    const { s, attempts } = await harness({ deferred: true });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    const pending = s.openWith("p1");
    expect(s.status).toBe("connecting");

    s.end();
    expect(s.status).toBe("ended");

    attempts[0].resolve();
    await pending;
    await settle();

    expect(s.status).toBe("ended");                  // not resurrected
    expect(attempts[0].ch.readyState).toBe("closed"); // the late connection was closed
    expect(attempts[0].ch.onmessage).toBe(null);      // no handler was attached
    expect(attempts[0].ch.onclose).toBe(null);
    expect(s.history).toEqual([]);
    expect(s.errorKey).toBe("");
    // And the session really is dead, not merely labelled so.
    await s.send("must be impossible");
    expect(attempts[0].ch.sent.length).toBe(0);
    expect(s.history).toEqual([]);
  });

  it("a connect failure arriving after end() does not overwrite the ended state", async () => {
    const { s, attempts } = await harness({ deferred: true });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    const pending = s.openWith("p1");
    s.end();
    attempts[0].reject(new Error("ice timeout"));
    await pending;
    await settle();
    expect(s.status).toBe("ended");
    expect(s.errorKey).toBe("");
  });

  it("a busy rejection arriving after end() does not overwrite it either", async () => {
    const { s, attempts } = await harness({ deferred: true });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    const pending = s.openWith("p1");
    s.end();
    attempts[0].reject(new PeerBusyError());
    await pending;
    await settle();
    expect(s.status).toBe("ended");
    expect(s.errorKey).toBe("");
  });

  // A decline while connecting takes the same path through finish().
  it("a connection arriving after a session was declined is closed", async () => {
    const { s, ch, kb, attempts } = await harness({ deferred: true });
    // An inbound request, declined, and then an unrelated outbound attempt that
    // was already in flight lands late.
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    const pending = s.openWith("p1");
    s.end();
    void ch; void kb;
    attempts[0].resolve();
    await pending;
    await settle();
    expect(s.active()).toBe(false);
    expect(attempts[0].ch.readyState).toBe("closed");
  });

  // Defence in depth against overlap: a second attempt while one is in flight
  // must not tear down or interleave with the first.
  it("refuses a second openWith while one is already in flight", async () => {
    const { s, attempts, connectFn } = await harness({ deferred: true });
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    recordPeerCaps("p2", { caps: [CAP_TEXT] });
    const first = s.openWith("p1");
    await s.openWith("p2");
    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(s.peerId).toBe("p1");
    expect(s.status).toBe("connecting");
    attempts[0].resolve();
    await first;
    expect(s.status).toBe("waitingAccept");
    expect(s.peerId).toBe("p1");
  });

  it("refuses openWith while a session is already open", async () => {
    const { s, peerAccepts, connectFn } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("kept");
    await s.openWith("p1");
    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(s.status).toBe("open");
    expect(s.history.map((m) => m.body)).toEqual(["kept"]); // not wiped
  });

  it("still opens again once a session has ended", async () => {
    const { s, ch, peerAccepts, connectFn } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    ch.onclose!();
    expect(s.status).toBe("ended");
    ch.readyState = "open";
    await s.openWith("p1");
    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(s.status).toBe("waitingAccept");
  });

  // ── history ────────────────────────────────────────────────────────────────
  it("caps retained history and keeps the newest", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    for (let i = 0; i < TEXT_HISTORY_MAX + 5; i++) await s.send(`m${i}`);
    expect(s.history.length).toBe(TEXT_HISTORY_MAX);
    expect(s.history.at(-1)!.body).toBe(`m${TEXT_HISTORY_MAX + 4}`);
    expect(s.history.at(0)!.body).toBe("m5");
  });

  it("gives every message a distinct id, for keyed rendering", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    for (const m of ["a", "b", "c"]) await s.send(m);
    const ids = s.history.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("clearHistory leaves nothing behind", async () => {
    const { s, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("secret");
    s.clearHistory();
    expect(s.history).toEqual([]);
  });

  it("a new session does not inherit the previous one's history or counters", async () => {
    const { s, ch, peerAccepts } = await harness();
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("first session");
    ch.onclose!();
    ch.sent.length = 0;
    ch.readyState = "open";
    await s.openWith("p1");
    await peerAccepts();
    expect(s.history).toEqual([]);
    await s.send("second session");
    expect(new DataView(ch.sent[0]).getUint32(1)).toBe(0); // a fresh seq counter
  });

  // ── abuse bounds ───────────────────────────────────────────────────────────
  it("ends the session on a flooding peer", async () => {
    const { s, ch, ka, inbound } = await harness();
    inbound("p2");
    s.accept();
    const peer = new TextSender();
    for (let i = 0; i < TEXT_BURST + 5; i++) {
      ch.onmessage!({ data: (await peer.frame(`f${i}`, ka.textSend)).buffer as ArrayBuffer });
      await settle();
    }
    expect(s.status).toBe("failed");
    expect(s.errorKey).toBe("flooding");
    expect(ch.readyState).toBe("closed");
    expect(s.history.length).toBeLessThanOrEqual(TEXT_BURST);
  });

  it("bounds a session by message count and by bytes", () => {
    expect(TEXT_SESSION_MAX_MESSAGES).toBe(500);
    expect(TEXT_SESSION_MAX_BYTES).toBe(4 << 20);
    expect(TEXT_HISTORY_MAX).toBe(200);
    expect(TEXT_BURST).toBe(20);
    expect(TEXT_SEND_BUFFER_MAX).toBe(1 << 20);
  });

  it("ends the session when the peer exceeds the session message cap", async () => {
    // autoTick keeps the rate bucket topped up, so what stops this is the session
    // cap and not the flood guard -- a SLOW flood must still be bounded.
    const { s, ch, ka, inbound } = await harness({ autoTick: 1000 });
    inbound("p2");
    s.accept();
    const peer = new TextSender();
    for (let i = 0; i <= TEXT_SESSION_MAX_MESSAGES; i++) {
      ch.onmessage!({ data: (await peer.frame("m", ka.textSend)).buffer as ArrayBuffer });
    }
    await drainUntil(() => s.status !== "open");
    expect(s.status).toBe("failed");
    expect(s.errorKey).not.toBe("flooding");
    expect(ch.readyState).toBe("closed");
  });

  // ── ephemerality ───────────────────────────────────────────────────────────
  it("never writes to localStorage or sessionStorage", async () => {
    const { s, peerAccepts } = await harness();
    const before = { local: localStorage.length, session: sessionStorage.length };
    recordPeerCaps("p1", { caps: [CAP_TEXT] });
    await s.openWith("p1");
    await peerAccepts();
    await s.send("must not persist");
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(before);
    expect(JSON.stringify(localStorage)).not.toContain("must not persist");
  });

});
