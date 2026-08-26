import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTransferSession, routeOffer } from "./transfer-session.svelte";
import type { SessionDeps } from "./transfer-session.svelte";
import type { InboundSignal, RtcConfig } from "./webrtc";
import { loadLang, messages } from "./i18n.svelte";
import { ready } from "./crypto";

// 只需要 onSignal / sendSignal 两个方法：listenForIncoming 用到的就是它们。
function fakeSignaling() {
  const cbs: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  return {
    sent,
    client: {
      onSignal(cb: (from: string, data: unknown) => void) {
        cbs.push(cb);
        return () => cbs.splice(cbs.indexOf(cb), 1);
      },
      sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
    },
    inject(from: string, data: InboundSignal) { cbs.forEach((cb) => cb(from, data)); },
  };
}

/**
 * 这间房拿到 `/api/ice` 答复之前的那份配置，和之后的那份。
 *
 * 窗口里 `rtcConfig()` 返回的是一份默认配置：没有 ICE 服务器、没有中继池、没有 TURN
 * 凭据——而拿它建出来的连接会带着这份空配置活完一生。所以"建了几条、用的哪一份"是
 * 这条闸门唯一说了算的事，下面每条断言都落在 `built` 上。
 */
const EMPTY_CONFIG: RtcConfig = { iceServers: [] };
const ROOM_CONFIG: RtcConfig = { iceServers: [{ urls: "turn:relay.example:3478" }] };
const built: RtcConfig[] = [];

// A minimal RTCPeerConnection so the positive control lands on "connecting"
// rather than on the error path — otherwise the control would pass for the wrong
// reason and stop proving anything. 构造函数记账，因为"没建"和"建了一条空的"在
// session.recv 上看不出区别。
class FakePC {
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

function makeSession(textActive = false, roomIce?: SessionDeps["roomIce"]) {
  const sig = fakeSignaling();
  // 可变的一格：互斥状态要能在"停等"的中途改变，那正是一整个 HTTP 往返里会发生的事。
  const state = { textActive };
  const deps: SessionDeps = {
    signaling: () => sig.client as never,
    rtcConfig: () => (roomIce?.pending() ? EMPTY_CONFIG : ROOM_CONFIG),
    t: () => messages.en,
    flash: () => {},
    textActive: () => state.textActive,
    roomIce,
  };
  const session = createTransferSession(deps);
  session.listenForIncoming();
  return { session, sig, state };
}

const FILE_OFFER: InboundSignal = { sdp: { type: "offer", sdp: "v=0" }, commit: btoa("c".repeat(32)) };
const TEXT_OFFER: InboundSignal = { ...FILE_OFFER, text: true };
const RESUME_OFFER: InboundSignal = { ...FILE_OFFER, resume: true };

beforeEach(async () => {
  // beginReceive's first statement is generateKeyPair(), which throws unless
  // libsodium is initialised. Without this the handler rejects before publishing
  // any state and every assertion below passes for the wrong reason.
  await ready();
  await loadLang("en");
  built.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePC);
});

// listenForIncoming's handler is async and beginReceive awaits, so state lands a
// microtask later than the injection.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("listenForIncoming generation routing", () => {
  // 复现的那个 bug：listenForIncoming 只挡掉 resume 世代，没挡 text 世代，所以一次
  // 粘贴触发的 text offer 会在接收端开起一个 0% 的**文件接收**；紧接着 busy() 变真，
  // 真正该处理它的消息监听器被挡在门外，而发起方等到 ICE 超时打出 "text connection
  // failed"。两个后果这里都断言掉：没有 beginReceive 留下的状态，也没有 busy 回包。
  it("ignores a text-generation offer completely", async () => {
    const { session, sig } = makeSession();
    sig.inject("p1", TEXT_OFFER);
    await settle();
    expect(session.recv).toBe(null);      // beginReceive never ran
    expect(session.incoming).toBe(null);
    expect(session.busy).toBe(false);     // and it did not make itself busy
    expect(sig.sent).toEqual([]);         // no answer, and no busy reply
  });

  // busy 回包这一路单独走一遍：那条回包是**不带世代标记**的，所以发起方的 text 连接
  // 按世代把它丢掉，然后白等 30 秒的 ICE 超时——比不回还糟。
  it("sends no busy reply to a text-generation offer, even while busy", async () => {
    const { session, sig } = makeSession(true); // textActive → busy() is true
    expect(session.busy).toBe(true);
    sig.inject("p1", TEXT_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    expect(session.recv).toBe(null);
  });

  // 已有行为的回归：真正的文件 offer 在忙的时候仍然要收到 busy 回包。
  it("still replies busy to a file offer while busy", async () => {
    const { session, sig } = makeSession(true);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([{ to: "p1", data: { busy: true } }]);
    expect(session.recv).toBe(null);
  });

  // 已有行为的回归：没有 pausedRecv 可挂的游离 resume offer 依旧被丢掉。
  it("still ignores a stray resume offer", async () => {
    const { session, sig } = makeSession();
    sig.inject("p1", RESUME_OFFER);
    await settle();
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([]);
  });

  it("ignores an offer tagged both resume and text", async () => {
    const { session, sig } = makeSession();
    sig.inject("p1", { ...FILE_OFFER, resume: true, text: true });
    await settle();
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([]);
  });

  // 正面对照。没有它，一个"把所有 offer 都拒掉"的实现也能让上面几条全绿。
  it("does accept a plain file offer", async () => {
    const { session, sig } = makeSession();
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(session.recv).not.toBe(null);
    expect(session.recv!.peer).toBe("p1");
    expect(session.recv!.status).toBe("connecting");
  });

  it("ignores the piggybacks that are not offers at all", async () => {
    const { session, sig } = makeSession();
    for (const d of [
      { caps: ["text/1"] },
      { rename: "Bob" },
      { relayRtt: { r1: 9 } },
      { ice: { candidate: "c" } },
      { sdp: { type: "answer", sdp: "v=0" } },
    ] as InboundSignal[]) {
      sig.inject("p1", d);
    }
    await settle();
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([]);
  });
});

// routeOffer 是一条入站 offer 的全部路由决策，抽成纯函数才能把 pausedRecv 那条路穷举
// 掉——真要把接收端驱动到"已暂停"状态，得跑完 offer→握手→manifest→接受→落盘→掉线，
// 而那个手架测的是手架本身。同一个理由，同一个文件里的 wouldExceedDeclared 也是导出的。
describe("routeOffer", () => {
  const offer = { sdp: { type: "offer" as const, sdp: "v=0" } };
  const idle = { from: "p1", pausedFrom: null, busy: false };
  const paused = { from: "p1", pausedFrom: "p1", busy: true };

  it("ignores anything that is not an offer", () => {
    expect(routeOffer({}, idle)).toBe("ignore");
    expect(routeOffer({ sdp: { type: "answer", sdp: "v=0" } }, idle)).toBe("ignore");
    expect(routeOffer({ text: true }, idle)).toBe("ignore");
  });

  it("routes a plain file offer to a receive when idle", () => {
    expect(routeOffer(offer, idle)).toBe("receive");
  });

  it("routes a plain file offer to a busy reply when busy", () => {
    expect(routeOffer(offer, { ...idle, busy: true })).toBe("busy");
  });

  // 唯一允许走续传那条路的，是 resume 世代的信令：它是唯一带 resume-auth 签名的世代，
  // 也正是 pausedRecv 在等的东西。
  it("routes a resume-generation offer from the paused peer to resume", () => {
    expect(routeOffer({ ...offer, resume: true }, paused)).toBe("resume");
  });

  it("routes a resume offer to resume even while busy — a paused receive IS busy", () => {
    expect(routeOffer({ ...offer, resume: true }, { from: "p1", pausedFrom: "p1", busy: true })).toBe("resume");
  });

  it("ignores a resume offer from a peer with nothing paused", () => {
    expect(routeOffer({ ...offer, resume: true }, idle)).toBe("ignore");
    expect(routeOffer({ ...offer, resume: true }, { from: "p2", pausedFrom: "p1", busy: true })).toBe("ignore");
  });

  // ── 这次修的那条 ──────────────────────────────────────────────────────────
  // 旧代码的 pausedRecv 快速通道排在世代判定**之前**，而且只比对端身份。于是同一个对端
  // 的一条 text offer（粘贴一下就会产生）会被喂进 pausedRecv.resume()。resume() 第一件
  // 事就是把 pausedRecv 置空并清掉续传窗口的定时器——"认领"这次续传。那条 text offer
  // 没有 resume-auth 签名，会被 establish 的 accept() 丢掉，于是续传连接等到超时失败；
  // 而真正的 resume offer 随后到达时已经无处可挂，也被丢掉。**一次粘贴永久杀掉一次
  // 本来可以续上的文件传输。**
  it("never routes a text-generation offer to resume, even from the paused peer", () => {
    expect(routeOffer({ ...offer, text: true }, paused)).toBe("ignore");
  });

  // 同一个洞的另一半：一条**全新的**文件 offer 也不该劫持续传，它该拿到 busy。
  it("never routes a fresh file offer to resume; it gets the busy reply", () => {
    expect(routeOffer(offer, paused)).toBe("busy");
  });

  it("ignores an offer tagged both resume and text, paused or not", () => {
    // resume 优先（signalGeneration 的既定优先级），所以带 pausedFrom 时它是 resume。
    expect(routeOffer({ ...offer, resume: true, text: true }, idle)).toBe("ignore");
    expect(routeOffer({ ...offer, text: true }, { from: "p1", pausedFrom: "p1", busy: false })).toBe("ignore");
  });

  it("never routes a text offer to receive or busy either", () => {
    for (const ctx of [idle, paused, { ...idle, busy: true }]) {
      expect(routeOffer({ ...offer, text: true }, ctx)).toBe("ignore");
    }
  });

  // ── "还没拿到配置"和"忙"是两个不同的答案 ────────────────────────────────────
  // busy 对发起方是**终局**：它打出 "peer busy" 就不再重试了。对一间只是还没拿到
  // /api/ice 答复的房间回 busy，等于把一次慢 HTTP 变成一次确定性的传输失败——而这条
  // offer 本身完全可以接，缺的只是一份能拿去建连的配置。
  const pending = { ...idle, roomIcePending: true };

  it("parks a plain file offer while the room has no configuration", () => {
    expect(routeOffer(offer, pending)).toBe("park");
  });

  it("still answers busy first: a real conflict is a conflict whatever the room is doing", () => {
    expect(routeOffer(offer, { ...pending, busy: true })).toBe("busy");
  });

  it("keeps resume ahead of the pending room, exactly as it is ahead of busy", () => {
    expect(routeOffer({ ...offer, resume: true }, { ...paused, roomIcePending: true })).toBe("resume");
  });

  it("changes nothing about the generations it never takes", () => {
    expect(routeOffer({ ...offer, text: true }, pending)).toBe("ignore");
    expect(routeOffer({ ...offer, resume: true }, pending)).toBe("ignore");
    expect(routeOffer({}, pending)).toBe("ignore");
    expect(routeOffer({ sdp: { type: "answer", sdp: "v=0" } }, pending)).toBe("ignore");
  });

  it("receives as before once the answer is in, and for a caller that has no gate", () => {
    expect(routeOffer(offer, { ...idle, roomIcePending: false })).toBe("receive");
    expect(routeOffer(offer, idle)).toBe("receive");
  });
});

// ── 停等，而不是拒绝 ─────────────────────────────────────────────────────────
//
// 房间是**先加入、后拿配置**的（见 App 的 applyRoomIce）。窗口里唯一安全的做法是
// 什么都别建；而"安全地拒绝"不等于"接受"：busy 让发起方直接失败并且不再重试，所以
// 一间提前一个往返加入的房间，会对一个本来就已经在等的旧版对端造成一次确定性的建连
// 失败。这一组测的就是"停等"这条路本身：窗口里 0 条连接、答复到了恰好 1 条、用的是
// 装好的那份配置，而每一个房间边界都把停着的活作废掉且只作废一次。
describe("an inbound file offer while the room has no ICE configuration", () => {
  it("parks it instead of answering busy, and stays out of the navigation guard", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);      // 一个字都不能回：busy 是终局
    expect(session.recv).toBe(null);   // beginReceive 没有跑
    expect(session.incoming).toBe(null);
    expect(built).toEqual([]);         // 更没有拿空配置 new 出一条连接
    // 停等不是"在传"。warnsOnLeave 读的就是 busy：一间刚 reset 过的房间里没有任何
    // 传输可言，却会在每次刷新时弹一次"确定要离开吗"，并且压掉更新提示条。
    expect(session.busy).toBe(false);
  });

  it("builds exactly one receive, from the configuration that was installed", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 一条，且不是窗口里那份空的
    expect(session.recv).not.toBe(null);
    expect(session.recv!.peer).toBe("p1");
    expect(session.recv!.status).toBe("connecting");
  });

  it("builds nothing however long the answer takes", async () => {
    vi.useFakeTimers();
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    // 五秒是中继选优自己那条期限，它管的是"对端会不会说话"，不是"配置到没到"。
    // 时间在这条道上没有投票权：这里推 30 秒，仍然是 0 条。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(built).toEqual([]);
    expect(sig.sent).toEqual([]);
    expect(session.recv).toBe(null);
  });

  it("still replies busy to a real conflict while the room is pending", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(true, ice.gate); // 消息会话在跑
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([{ to: "p1", data: { busy: true } }]);
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(session.recv).toBe(null);
  });

  it("re-asks the mutex when it wakes: a conflict that started during the wait wins", async () => {
    const ice = fakeRoomIce();
    const { session, sig, state } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    // 停等横跨一整个 HTTP 往返，消息会话完全可能在这中间开起来。停下来时问过的那次
    // 不算数，醒来要重新问一遍——这也正是 busy 真正该发出去的地方。
    state.textActive = true;
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([{ to: "p1", data: { busy: true } }]);
  });

  it("parks at most one: a second peer gets the busy the first one did not", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    sig.inject("p2", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([{ to: "p2", data: { busy: true } }]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 一条，不是两条
    expect(session.recv!.peer).toBe("p1"); // 先到的那条，不是后来的
  });

  it("lets the same peer's newer offer supersede its own parked one", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    sig.inject("p1", { ...FILE_OFFER, sdp: { type: "offer", sdp: "v=0 retry" } });
    await settle();
    expect(sig.sent).toEqual([]); // 同一个对端重试不是冲突
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 顶掉，不是各建一条
    expect(session.recv!.peer).toBe("p1");
  });

  it("retires a parked offer when its peer leaves, and only that peer's", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    session.peerGone("p9"); // 别人走了，与它无关
    session.peerGone("p1");
    session.peerGone("p1"); // 作废是幂等的
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([]);
  });

  it("retires parked work on a cancellation, a hard reset and a dead socket", async () => {
    for (const retire of [
      (s: ReturnType<typeof makeSession>["session"]) => s.abortAll(),
      (s: ReturnType<typeof makeSession>["session"]) => s.reset(),
      (s: ReturnType<typeof makeSession>["session"]) => s.retireParkedInbound(),
    ]) {
      built.length = 0;
      const ice = fakeRoomIce();
      const { session, sig } = makeSession(false, ice.gate);
      sig.inject("p1", FILE_OFFER);
      await settle();
      retire(session);
      retire(session); // 每一条都必须是幂等的
      ice.install();
      await settle();
      expect(built).toEqual([]);
      expect(session.recv).toBe(null);
    }
  });

  it("abandons on a room switch without holding the slot against the next room", async () => {
    const ice = fakeRoomIce();
    const { session, sig } = makeSession(false, ice.gate);
    sig.inject("p1", FILE_OFFER);
    await settle();
    ice.supersede(); // 换房间：这条停等作废，新房间自己的窗口开着
    await settle();
    expect(built).toEqual([]);
    // 位子要真的腾出来。否则新房间的第一条 offer 会因为上一间房留下的那条记录挨一个
    // 不该有的 busy，而那对发起方同样是终局。
    sig.inject("p2", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p2");
  });

  it("receives immediately when no gate is passed at all", async () => {
    // 反面对照，也是这条闸门的变异证明：把 roomIce 拿掉，这一组的第一条必然变红。
    const { session, sig } = makeSession(false, undefined);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p1");
  });
});
