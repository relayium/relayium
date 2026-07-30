import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTransferSession, routeOffer } from "./transfer-session.svelte";
import type { SessionDeps } from "./transfer-session.svelte";
import type { InboundSignal } from "./webrtc";
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

// A minimal RTCPeerConnection so the positive control lands on "connecting"
// rather than on the error path — otherwise the control would pass for the wrong
// reason and stop proving anything.
class FakePC {
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: unknown = null;
  connectionState = "new";
  createDataChannel() { return { binaryType: "", bufferedAmountLowThreshold: 0, readyState: "connecting", onopen: null, onmessage: null, onclose: null, send() {}, close() {} }; }
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async createAnswer() { return { type: "answer", sdp: "answer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.connectionState = "closed"; }
}

function makeSession(textActive = false) {
  const sig = fakeSignaling();
  const deps: SessionDeps = {
    signaling: () => sig.client as never,
    rtcConfig: () => ({ iceServers: [] }),
    t: () => messages.en,
    flash: () => {},
    textActive: () => textActive,
  };
  const session = createTransferSession(deps);
  session.listenForIncoming();
  return { session, sig };
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
  vi.stubGlobal("RTCPeerConnection", FakePC);
});

// listenForIncoming's handler is async and beginReceive awaits, so state lands a
// microtask later than the injection.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { vi.unstubAllGlobals(); });

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
});
