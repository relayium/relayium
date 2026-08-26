import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isTextOffer, createTextLink } from "./text-link";
import type { InboundSignal, RtcConfig } from "./webrtc";
import { ready } from "./crypto";

describe("isTextOffer", () => {
  it("accepts a text-generation offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(true);
  });

  // Untagged is the file generation, which listenForIncoming owns. Claiming one
  // here would start a message session on someone else's file transfer.
  it("rejects an untagged offer", () => {
    expect(isTextOffer({ sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // A resume never runs a handshake, so it can never open a message session.
  it("rejects a resume, tagged or not", () => {
    expect(isTextOffer({ resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // An answer or a candidate belongs to a connection that already exists.
  it("rejects anything that is not an offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "answer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, ice: { candidate: "c" } })).toBe(false);
    expect(isTextOffer({ text: true })).toBe(false);
  });

  it("rejects the other piggybacks that share this envelope", () => {
    expect(isTextOffer({ caps: ["text/1"] })).toBe(false);
    expect(isTextOffer({ rename: "Bob" })).toBe(false);
    expect(isTextOffer({ relayRtt: { r1: 9 } })).toBe(false);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 0, "", "text", [], { text: "yes" }, { text: 1 }]) {
      expect(isTextOffer(junk), JSON.stringify(junk) ?? "undefined").toBe(false);
    }
  });
});

function fakeSignaling() {
  const cbs: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  return {
    sent,
    client: {
      onSignal(cb: (from: string, data: unknown) => void) { cbs.push(cb); return () => cbs.splice(cbs.indexOf(cb), 1); },
      sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
    },
    inject(from: string, data: InboundSignal) { cbs.forEach((cb) => cb(from, data)); },
  };
}
const TEXT_OFFER: InboundSignal = { text: true, sdp: { type: "offer", sdp: "v=0" } };

describe("createTextLink listen", () => {
  // 拒绝要发生在**握手之前**：等到会话状态机拿到连接再关掉，等于白跑一次
  // commit-reveal，跨网络上还白占一次 TURN 分配。
  it("does not connect when the session cannot accept, and tells the peer it is busy", () => {
    const sig = fakeSignaling();
    const canAccept = vi.fn(() => false);
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }), canAccept });
    link.listen(() => { throw new Error("must not be handed a connection"); });
    // RTCPeerConnection 没有 stub：真去建连就会抛，所以"没抛"本身也是断言的一部分。
    sig.inject("p2", TEXT_OFFER);
    expect(canAccept).toHaveBeenCalledWith("p2");
    // busy 回包必须带 text 标记，否则发起方按世代把它丢掉，白等 30 秒的 ICE 超时。
    expect(sig.sent).toEqual([{ to: "p2", data: { busy: true, text: true } }]);
  });

  it("does not reply busy to a signal that is not a text offer", () => {
    const sig = fakeSignaling();
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }), canAccept: () => false });
    link.listen(() => {});
    for (const d of [{ sdp: { type: "offer", sdp: "v=0" } }, { caps: ["text/1"] }, { text: true, resume: true, sdp: { type: "offer", sdp: "v=0" } }] as InboundSignal[]) {
      sig.inject("p2", d);
    }
    expect(sig.sent).toEqual([]);
  });

  it("treats a missing canAccept as permission, so nothing existing has to pass one", () => {
    const sig = fakeSignaling();
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }) });
    link.listen(() => {});
    sig.inject("p2", TEXT_OFFER);
    // 没有 canAccept 就不该发 busy——它会去建连（这里必然失败，被 catch 记日志）。
    expect(sig.sent).toEqual([]);
  });
});

// ── 这间房还没拿到自己的 /api/ice 答复 ────────────────────────────────────────
//
// 房间是**先加入、后拿配置**的（见 App 的 applyRoomIce）。这个窗口里 rtcConfig() 是
// 一份默认配置：没有 ICE 服务器、没有中继池、没有 TURN 凭据。拿它建出来的连接，会带着
// 这份空配置活完整条连接的一生。
//
// 而"还没拿到配置"绝不能冒充 busy：establish 把 busy 变成 PeerBusyError，发起方直接
// 进 peerBusy 就不再重试了。于是一间"提前一个往返加入"的房间，会对一个**本来就已经在
// 等**的旧版对端造成一次确定性的建连失败。安全地拒绝不等于接受，所以这里停等。
//
// 真的去数 RTCPeerConnection 被 new 了几次、用的是哪份配置：这条道最后要保证的就是
// "在答复到达之前 0 条，之后恰好 1 条，且用的是装好的那份"。
const ROOM_CONFIG: RtcConfig = { iceServers: [{ urls: "turn:relay.example:3478" }] };
const EMPTY_CONFIG: RtcConfig = { iceServers: [] };
const built: RtcConfig[] = [];
class CountingPC {
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = "new";
  constructor(config: RtcConfig) { built.push(config); }
  createDataChannel() { return { binaryType: "", bufferedAmountLowThreshold: 0, readyState: "connecting", onopen: null, onmessage: null, onclose: null, send() {}, close() {} }; }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.connectionState = "closed"; }
}

/** App 的 roomIcePending / whenRoomIce / settleRoomIce，缩到测试能驱动的三个动作。 */
function fakeRoomIce() {
  let pending = true;
  let waiters: ((live: boolean) => void)[] = [];
  const wake = (live: boolean) => {
    const parked = waiters;
    waiters = [];
    for (const cb of parked) cb(live);
  };
  return {
    gate: {
      pending: () => pending,
      whenReady: () => (pending ? new Promise<boolean>((r) => waiters.push(r)) : Promise.resolve(true)),
    },
    /** 本房间的答复装好了（App 里是 applyRoomIce）。 */
    install() { pending = false; wake(true); },
    /** 换房间：停在旧房间上的活全部作废，而新房间又开着自己的窗口
     *  （App 里是 resetRelaySelection：settleRoomIce(false) 之后 roomIcePending 再置真）。 */
    supersede() { wake(false); },
  };
}

describe("createTextLink while the room has no ICE configuration", () => {
  // link() 第一句就是 generateKeyPair()，libsodium 没初始化会抛——那样下面每条断言
  // 都会因为错误的原因通过。
  beforeEach(async () => {
    await ready();
    built.length = 0;
    vi.stubGlobal("RTCPeerConnection", CountingPC);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  // 建连是同步开始的（establish 的第一句就是 new RTCPeerConnection），但入站处理里隔了
  // 几个 await，所以统一让出几拍。
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  function makeLink(ice?: ReturnType<typeof fakeRoomIce>, canAccept = () => true) {
    const sig = fakeSignaling();
    const link = createTextLink({
      signaling: () => sig.client as never,
      // 窗口里就是空配置——这正是不能拿去建连的那一份。
      rtcConfig: () => (ice?.gate.pending() ? EMPTY_CONFIG : ROOM_CONFIG),
      canAccept,
      roomIce: ice?.gate,
    });
    link.listen(() => {});
    return { sig, link };
  }
  const busyTo = (sig: ReturnType<typeof fakeSignaling>) =>
    sig.sent.filter((s) => s.data.busy === true).map((s) => s.to);

  it("parks an inbound offer instead of telling the sender it is busy", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    // busy 对发起方是终局，它不会重试——所以这里一个字都不能回。
    expect(sig.sent).toEqual([]);
    expect(built).toEqual([]);
  });

  it("builds exactly one connection, from the configuration that was installed", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.install();
    await settle();
    // 一条，而且用的是装好的那份而不是窗口里的空配置。
    expect(built).toEqual([ROOM_CONFIG]);
    expect(busyTo(sig)).toEqual([]);
  });

  it("builds nothing however long the answer takes", async () => {
    vi.useFakeTimers();
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    // 五秒是中继选优自己那条期限；它管的是"对端会不会说话"，不是"配置到没到"。
    // 时间在这条道上不该有任何投票权。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(built).toEqual([]);
    expect(sig.sent).toEqual([]);
  });

  it("still answers busy for a real conflict, pending room or not", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice, () => false);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    expect(sig.sent).toEqual([{ to: "p2", data: { busy: true, text: true } }]);
    ice.install();
    await settle();
    expect(built).toEqual([]);
  });

  it("re-asks the precheck when it wakes: a conflict that started during the wait wins", async () => {
    const ice = fakeRoomIce();
    let free = true;
    const { sig } = makeLink(ice, () => free);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    // 一整个 HTTP 往返过去了，这中间完全可能开始一次文件传输。
    free = false;
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(sig.sent).toEqual([{ to: "p2", data: { busy: true, text: true } }]);
  });

  it("parks at most one: a second peer gets the busy the first one did not", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    sig.inject("p3", TEXT_OFFER);
    await settle();
    expect(busyTo(sig)).toEqual(["p3"]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 一条，不是两条
  });

  it("lets the same peer's newer offer supersede its own parked one", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    sig.inject("p2", { ...TEXT_OFFER, sdp: { type: "offer", sdp: "v=0 retry" } });
    await settle();
    // 同一个对端重试不是冲突，别回它 busy。
    expect(busyTo(sig)).toEqual([]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 顶掉，不是各建一条
  });

  it("retires a parked offer when its peer leaves, and only that peer's", async () => {
    const ice = fakeRoomIce();
    const { sig, link } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    link.peerGone("p9"); // 别人走了，与它无关
    link.peerGone("p2");
    link.peerGone("p2"); // 作废是幂等的：第二次什么也不该发生
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(sig.sent).toEqual([]);
  });

  it("retires a parked offer when the socket it was parked on closes", async () => {
    const ice = fakeRoomIce();
    const { sig, link } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    link.retireParkedInbound();
    link.retireParkedInbound();
    ice.install();
    await settle();
    expect(built).toEqual([]);
  });

  it("abandons on a room switch without holding the slot against the next room", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeLink(ice);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.supersede(); // 换房间：这条停等作废，而新房间自己的窗口开着
    await settle();
    expect(built).toEqual([]);
    // 位子必须真的腾出来：否则新房间的第一条 offer 会因为上一间房留下的记录挨一个
    // 不该有的 busy，而那对发起方同样是终局。
    sig.inject("p3", TEXT_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
  });

  it("builds immediately when no gate is passed at all", async () => {
    // 反面对照，也是这条闸门的变异证明：把 roomIce 拿掉，上面第一条就必然变红。
    const { sig } = makeLink(undefined);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
  });
});
