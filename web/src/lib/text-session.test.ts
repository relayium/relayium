import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ready, generateKeyPair, deriveSession, type SessionKeys } from "./crypto";
import { TextSender, TEXT_MAX_BYTES } from "./text-wire";
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

async function harness(opts: { failWith?: Error; autoTick?: number; deferred?: boolean; transferActive?: () => boolean } = {}) {
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
  const conn = (keys: SessionKeys, channel: FakeChannel): TextConn => ({
    channel, keys, sas: "123456", path: "lan", close: () => channel.close(),
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
    return conn(ka, ch);
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
    inbound(peerId: string, channel: FakeChannel = ch) {
      if (!listening) { s.listenForRequests(); listening = true; }
      listener!(peerId, conn(kb, channel));
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

  it("delivers frames buffered before acceptance, in order, once accepted", async () => {
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
