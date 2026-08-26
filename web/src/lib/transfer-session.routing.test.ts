import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTransferSession, createLaneClaim, createRosterDepartures, routeOffer } from "./transfer-session.svelte";
import type { RoomIceGate, SessionDeps } from "./transfer-session.svelte";
// 本文件末尾的跨道测试是唯一同时拿着两条道的地方（App 里也是它把同一个 gate 交给
// 两边），所以跨道的事实只能在这里执行——单条道各自的测试看不见对方。
import { createTextLink } from "./text-link";
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
/** 连构造都失败的那一次也要记账：赢家建连失败之后不能把认领槽带走。 */
const attempted: RtcConfig[] = [];
let pcFails = false;

// A minimal RTCPeerConnection so the positive control lands on "connecting"
// rather than on the error path — otherwise the control would pass for the wrong
// reason and stop proving anything. 构造函数记账，因为"没建"和"建了一条空的"在
// session.recv 上看不出区别。
class FakePC {
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = "new";
  constructor(config: RtcConfig) {
    attempted.push(config);
    if (pcFails) throw new Error("relayium test: transport unavailable");
    built.push(config);
  }
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
  // App 的那一格本身，不是它的仿制品：认领是"哪条道先醒"这件事唯一的裁判，
  // 而一个只会说 true 的假货会让下面每条断言都因为错误的原因通过。
  const claim = createLaneClaim();
  const wake = (live: boolean) => {
    const parked = waiters;
    waiters = [];
    for (const cb of parked) cb(live);
  };
  return {
    claim,
    gate: {
      pending: () => pending,
      whenReady: () => (pending ? new Promise<boolean>((r) => waiters.push(r)) : Promise.resolve(true)),
      claimLane: (lane) => claim.claim(lane),
      releaseLane: (lane) => claim.release(lane),
      laneClaimedByOther: (lane) => claim.heldByOther(lane),
    } satisfies RoomIceGate,
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
  attempted.length = 0;
  pcFails = false;
  vi.stubGlobal("RTCPeerConnection", FakePC);
});

// listenForIncoming's handler is async and beginReceive awaits, so state lands a
// microtask later than the injection.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
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

  // ── 认领槽：同一个冲突提前一步的样子 ─────────────────────────────────────────
  // 消息道在握手中时占有房间唯一的旧版道，而它自己的会话状态还读作空闲，busy 看不见
  // 它——laneClaimed 是 busy 看不见的那一半答案。见 createLaneClaim。
  it("answers busy to a claimed lane, whatever the room's configuration is doing", () => {
    expect(routeOffer(offer, { ...idle, laneClaimed: true })).toBe("busy");
    // 认领排在 park 之前：窗口里被认领同样是冲突，不是停等。
    expect(routeOffer(offer, { ...pending, laneClaimed: true })).toBe("busy");
  });

  // 续传的优先级在认领槽之前，和它在 busy 之前是同一条规则：暂停中的接收等的就是
  // 这条 offer，而认领槽讲的是另一条道的事。
  it("still lets a resume outrank the claim", () => {
    expect(routeOffer({ ...offer, resume: true }, { ...paused, laneClaimed: true })).toBe("resume");
    // 没人认领的时候，这个字段一个判定都不改。
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

// ── 两条旧版道**同时**醒过来的那一瞬间 ─────────────────────────────────────────
//
// 停等把入站 offer 挂在本房间的 `/api/ice` 答复上，而一间房里可以同时挂着一条文件
// offer 和一条消息 offer。答复落地时两条都在同一个 turn 里被唤醒——于是第二个跑起来
// 的那条，去问一个"第一条还没来得及写进去"的互斥量。
//
// 消息道尤其如此：`link()` 要跑完整套 commit-reveal 才会把连接交给会话状态机，在那
// 之前 `canAccept` 读到的会话是**空闲**的。文件道于是看到 busy 为假，拿同一个房间又
// new 了一条 RTCPeerConnection：两条传输、两串 SAS、一间房。
//
// 这个缝隙一直都在，原来只有一次预检那么宽；提前加入房间把它拉成了整整一个 HTTP 往返，
// 并且让它**由构造保证可达**。所以下面这些断言全部落在两个可观测量上：
// RTCPeerConnection 被 new 了几次，以及输家收到的是不是一条它那个世代认得的 busy。

/**
 * 一间房的两条旧版道，按 App 里的接法接起来。
 *
 * 两处依赖是**照抄 App 的**，因为这个 bug 就住在它们里面：
 *  - 文件道的 `textActive` 读的是 `textSession.active()`——而会话是在 `onOffer` 把
 *    连接交过去之后才变成 active 的；
 *  - 消息道的 `canAccept` 读的是 `canAcceptFrom`，其中一项就是 `session.transferActive`。
 * 所以这里的 `textOwned` 只在 onOffer 里置真，正是"握手落地之前谁也看不见"。
 */
function makeRoom(ice: ReturnType<typeof fakeRoomIce>) {
  const sig = fakeSignaling();
  const rtcConfig = () => (ice.gate.pending() ? EMPTY_CONFIG : ROOM_CONFIG);
  let textOwned = false;
  const session = createTransferSession({
    signaling: () => sig.client as never,
    rtcConfig,
    t: () => messages.en,
    flash: () => {},
    textActive: () => textOwned,
    roomIce: ice.gate,
  });
  const textLink = createTextLink({
    signaling: () => sig.client as never,
    rtcConfig,
    canAccept: () => !textOwned && !session.transferActive,
    roomIce: ice.gate,
  });
  session.listenForIncoming();
  textLink.listen(() => { textOwned = true; });
  const laneRoster = createRosterDepartures([session, textLink]);
  return { sig, session, textLink, laneRoster };
}

// 赢家的握手会经由信令发出自己的 answer（commit/caps 随行）——那是它该做的事。
// 这里要审的是 busy 纪律：谁收到了 busy、带没带对世代标记。所以建连之后的断言
// 一律按 busy 过滤；"窗口里一个字都不回"的断言不在此列，那时没人建连。
const busyTo = (sig: ReturnType<typeof fakeSignaling>) =>
  sig.sent.filter((s) => s.data.busy === true);

describe("one parked file offer and one parked text offer wake in the same turn", () => {
  // 输家收到的 busy 必须是**它那个世代认得的**：文件世代不带标记，消息世代必须带
  // text——否则发起方按世代把这条信令丢掉，白等一个 ICE 超时才失败。
  it("builds exactly one transport when the message lane parks first", async () => {
    const ice = fakeRoomIce();
    const { sig, session } = makeRoom(ice);
    sig.inject("p2", TEXT_OFFER); // 先停的是消息道
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([]); // 窗口里一个字都不回：busy 对发起方是终局
    ice.install();
    await settle();
    // 这就是那个缺口本身：消息道已经在跑握手，但它的会话状态机还没被交过连接，
    // 所以文件道重问互斥量得到的是"空闲"。认领槽是这里唯一还说得出真话的东西。
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv).toBe(null); // 文件道一条都没建，也没留下卡片
    expect(busyTo(sig)).toEqual([{ to: "p1", data: { busy: true } }]);
  });

  it("builds exactly one transport when the file lane parks first", async () => {
    const ice = fakeRoomIce();
    const { sig, session } = makeRoom(ice);
    sig.inject("p1", FILE_OFFER); // 反过来的插入顺序
    sig.inject("p2", TEXT_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    ice.install();
    await settle();
    // 停等顺序不决定唤醒后的执行顺序：两条 continuation 在同一个 turn 里醒来，谁先
    // 跑到认领那一句是调度细节——当前工具链下 .svelte.ts（经 Svelte 编译）的 await
    // 比普通 .ts 的多一跳微任务，文件道固定后到。认领槽存在的意义正是让两种顺序都
    // 安全，所以这里钉死的是不变量本身：恰好一条连接、恰好一个输家、输家收到的是
    // 它那个世代认得的 busy——而不是钉死哪条道赢。
    expect(built).toEqual([ROOM_CONFIG]);
    const busies = busyTo(sig);
    expect(busies.length).toBe(1);
    if (busies[0].to === "p1") {
      // 消息道赢了：文件道的 busy 不带标记，也没留下卡片。
      expect(busies[0].data).toEqual({ busy: true });
      expect(session.recv).toBe(null);
    } else {
      // 文件道赢了：消息道的 busy 必须带 text 标记。
      expect(busies[0]).toEqual({ to: "p2", data: { busy: true, text: true } });
      expect(session.recv!.peer).toBe("p1");
    }
  });

  // 同一个对端两条道一起来，也是同一件事：一间房只有一条旧版道。
  it("keeps one transport when both offers come from the same peer", async () => {
    const ice = fakeRoomIce();
    const { sig } = makeRoom(ice);
    sig.inject("p2", TEXT_OFFER);
    sig.inject("p2", FILE_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    // 输家也是发给同一个人的一条 busy。世代对不对，上面两条各自钉死了。
    const busies = busyTo(sig);
    expect(busies.map((b) => b.to)).toEqual(["p2"]);
  });

  // 认领槽不是只管唤醒那一个 turn 的：赢家的握手要跑完一整套 commit-reveal，这期间
  // 到达的**新** offer 面对的是同一个还没发布出去的会话。
  it("answers an offer that arrives while the winner is still shaking hands", async () => {
    const ice = fakeRoomIce();
    const { sig, session } = makeRoom(ice);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 消息道的那一条，握手还没落地
    sig.inject("p1", FILE_OFFER); // 窗口已经关了，走的是普通那条路
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 仍然是一条
    expect(session.recv).toBe(null);
    expect(busyTo(sig)).toEqual([{ to: "p1", data: { busy: true } }]);
  });

  // 单条道的行为一个字都不该变：没有对手，认领槽就是一次必然成功的取用。
  it("leaves a room with only one parked lane exactly as it was", async () => {
    const ice = fakeRoomIce();
    const { sig, session } = makeRoom(ice);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(built).toEqual([]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p1");
    expect(busyTo(sig)).toEqual([]);
  });
});

describe("the winner cannot take the room's legacy lane away with it", () => {
  // 建连失败：`link()` 的两条出口（reject 和 onOffer）都要把槽还回去，否则这间房
  // 的另一条道从此对每一条 offer 都回 busy——而那对发起方同样是终局。
  it("releases the claim when the winning handshake fails to build at all", async () => {
    const ice = fakeRoomIce();
    const { sig, session } = makeRoom(ice);
    pcFails = true;
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(attempted).toEqual([ROOM_CONFIG]); // 试过了
    expect(built).toEqual([]);                // 没建成
    expect(ice.claim.heldByOther("file")).toBe(false);
    // 槽真的回来了：下一条 offer 照常建连，而不是挨一个不该有的 busy。
    pcFails = false;
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p1");
    expect(busyTo(sig)).toEqual([]);
  });

  // 握手可能一直不落地（对端的 reveal 永远不来）。那条路自己是有界的——webrtc 的
  // SETUP_DEADLINE_MS/KEY_REVEAL_TIMEOUT_MS——但房间边界不必等它：每一条作废路径都
  // 顺手把槽还回去，所以槽不会活得比房间长。
  it("releases the claim at every boundary that ends the room", async () => {
    for (const retire of [
      (r: ReturnType<typeof makeRoom>, i: ReturnType<typeof fakeRoomIce>) => { void i; r.textLink.retireParkedInbound(); },
      (r: ReturnType<typeof makeRoom>, i: ReturnType<typeof fakeRoomIce>) => { void i; r.textLink.peerGone("p2"); },
      // App 的换房间：`resetRelaySelection` 无条件清空。
      (r: ReturnType<typeof makeRoom>, i: ReturnType<typeof fakeRoomIce>) => { void r; i.claim.clear(); },
    ]) {
      built.length = 0;
      const ice = fakeRoomIce();
      const room = makeRoom(ice);
      room.sig.inject("p2", TEXT_OFFER);
      await settle();
      ice.install();
      await settle();
      expect(built).toEqual([ROOM_CONFIG]); // 握手在跑，槽被它拿着
      expect(ice.claim.heldByOther("file")).toBe(true);
      retire(room, ice);
      retire(room, ice); // 每一条都必须幂等
      expect(ice.claim.heldByOther("file")).toBe(false);
      // 而且是真的能用，不只是标志位变了。
      room.sig.inject("p1", FILE_OFFER);
      await settle();
      expect(built).toEqual([ROOM_CONFIG, ROOM_CONFIG]);
      expect(room.session.recv!.peer).toBe("p1");
    }
  });

  // 走的是**别人**，不是槽的主人：赢家的握手还在跑，槽不能被别人的离开顺手还掉。
  it("keeps the claim when a different peer leaves", async () => {
    const ice = fakeRoomIce();
    const { sig, textLink } = makeRoom(ice);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.install();
    await settle();
    textLink.peerGone("p9");
    expect(ice.claim.heldByOther("file")).toBe(true);
    sig.inject("p1", FILE_OFFER);
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(busyTo(sig)).toEqual([{ to: "p1", data: { busy: true } }]);
  });
});

// ── 名册是"这个人走了"唯一保证会到的证据 ────────────────────────────────────────
//
// hub 会为物理断开发一条 `left`，但这个页面**可能收不到**：它自己的 socket 一断，
// 重连时拿到的那份名册就是"我不在的时候谁走了"的第一手也是最后一手消息。而窗口期
// 里，一条 offer 正停在某个对端名下等答复——名册换人或不再提名，就是它该作废的信号。
//
// 没有这条 diff，那条 offer 会活过它的对端，并在答复落地时**真的建起来**：一条打给
// hub 已经不再路由的 id 的传输、一次白占的 TURN 分配、一张点不动的接收卡片，同时把
// 这间房唯一的旧版道占住，挡着刚刚顶替它的那个对端。
describe("a peer that only the roster reports as gone", () => {
  it("retires both lanes' parked work, and lets the replacement park and build", async () => {
    const ice = fakeRoomIce();
    const { sig, session, laneRoster } = makeRoom(ice);
    expect(laneRoster.note(["p1", "p2"])).toEqual([]); // 先有名册，才谈得上不再提名
    sig.inject("p1", FILE_OFFER);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    expect(built).toEqual([]);
    // 一条名册帧同时带走两个人、带来一个新人。没有 `left`，一条都没有。
    expect(laneRoster.note(["p3"])).toEqual(["p1", "p2"]);
    // 顶替者照常停等——两条道的位子都必须是真的腾出来了，否则它挨的是一个不该有的
    // busy，而那对发起方是终局。
    sig.inject("p3", FILE_OFFER);
    await settle();
    expect(sig.sent).toEqual([]);
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]); // 一条，而且是顶替者那条
    expect(session.recv!.peer).toBe("p3");
  });

  it("builds nothing at all when the replacement never offers", async () => {
    const ice = fakeRoomIce();
    const { sig, session, laneRoster } = makeRoom(ice);
    laneRoster.note(["p1", "p2"]);
    sig.inject("p1", FILE_OFFER);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    laneRoster.note(["p3"]);
    ice.install();
    await settle();
    expect(built).toEqual([]);
    expect(session.recv).toBe(null);
    expect(sig.sent).toEqual([]);
  });

  // 名册的规则不因为答复已经装好而停用：赢家的握手还在跑，它的对端已经走了，那条槽
  // 必须跟着它走——否则顶替者对上的是一条永远不会落地的握手。
  it("releases a claim held on behalf of a peer the roster no longer names", async () => {
    const ice = fakeRoomIce();
    const { sig, session, laneRoster } = makeRoom(ice);
    laneRoster.note(["p2"]);
    sig.inject("p2", TEXT_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(ice.claim.heldByOther("file")).toBe(true);
    expect(laneRoster.note(["p3"])).toEqual(["p2"]);
    expect(ice.claim.heldByOther("file")).toBe(false);
    sig.inject("p3", FILE_OFFER);
    await settle();
    expect(built).toEqual([ROOM_CONFIG, ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p3");
  });

  // 显式 `left` 和名册讲的是同一件事，而且两条都会到。作废按身份进行，所以第二次
  // 是彻底的空操作——一条都不能因此漏掉，也一条都不能因此多做。
  it("is idempotent with an explicit left, in either order", async () => {
    const ice = fakeRoomIce();
    const { sig, session, textLink, laneRoster } = makeRoom(ice);
    laneRoster.note(["p1"]);
    sig.inject("p1", FILE_OFFER);
    await settle();
    session.peerGone("p1"); // App 的 onPeerLeft
    textLink.peerGone("p1");
    expect(laneRoster.note([])).toEqual(["p1"]); // …紧跟着的名册帧
    expect(laneRoster.note([])).toEqual([]);     // 再来一次什么也不该发生
    // 反过来的顺序同样是空操作。
    session.peerGone("p1");
    laneRoster.note(["p2"]);
    sig.inject("p2", FILE_OFFER);
    await settle();
    ice.install();
    await settle();
    expect(built).toEqual([ROOM_CONFIG]);
    expect(session.recv!.peer).toBe("p2");
    expect(busyTo(sig)).toEqual([]);
  });

  it("forgets the previous room's membership rather than reporting it as departed", () => {
    const gone: string[] = [];
    const roster = createRosterDepartures([{ peerGone: (id) => gone.push(id) }]);
    roster.note(["p1", "p2"]);
    roster.reset(); // 换房间：新房间的 id 与上一间房的成员没有关系
    expect(roster.note(["p9"])).toEqual([]);
    expect(gone).toEqual([]);
    // 而新房间自己的 diff 照常工作。
    expect(roster.note([])).toEqual(["p9"]);
    expect(gone).toEqual(["p9"]);
  });

  it("routes a departure through every lane it was given", () => {
    const a: string[] = [], b: string[] = [];
    const roster = createRosterDepartures([
      { peerGone: (id) => a.push(id) },
      { peerGone: (id) => b.push(id) },
    ]);
    roster.note(["p1", "p2", "p3"]);
    expect(roster.note(["p2"])).toEqual(["p1", "p3"]);
    expect(a).toEqual(["p1", "p3"]);
    expect(b).toEqual(["p1", "p3"]);
    // 还在名册上的那个一次都没被作废过。
    expect(a).not.toContain("p2");
  });
});
