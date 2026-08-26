// 把 connectText 适配成 text-session 要的那两个依赖（connect / listen）。
//
// 单独一个文件而不是塞进 App.svelte：这里是握手胶水——临时密钥对、deriveSession、
// SAS、等密钥到位——和 transfer-session 里那段等价，而 App.svelte 已经足够大了。
// 状态机不认识 WebRTC，本文件是唯一把两者接起来的地方。

import { generateKeyPair, deriveSession, sas } from "./crypto";
import { connectText } from "./webrtc";
import type { InboundSignal, RtcConfig } from "./webrtc";
import type { SignalingClient } from "./signaling";
import type { TextConn } from "./text-session.svelte";
// 只借类型，编译后这行不存在，所以消息这条道并没有因此依赖文件那条道。
// 它定义在 transfer-session 里，因为那里是两条道共用的那个"入站 offer 怎么走"的判定
// 所在地——同一个窗口、同一条规则，不该有两份各自漂移的定义。
import type { RoomIceGate } from "./transfer-session.svelte";

/**
 * 这条信令是不是"对端想开一次消息会话"。
 *
 * 三个条件都是必要的：带 text 标记（否则它属于文件世代，归 listenForIncoming）、
 * 是 offer（answer/ICE 属于一条已经在跑的连接）、而且不是 resume（resume 世代不跑
 * 握手，也永远不会开消息会话）。
 */
export function isTextOffer(data: unknown): data is InboundSignal {
  if (!data || typeof data !== "object") return false;
  const d = data as InboundSignal;
  return d.text === true && !d.resume && d.sdp?.type === "offer";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TextLinkDeps {
  signaling: () => SignalingClient;
  rtcConfig: () => RtcConfig;
  /** 现在能不能接一场来自这个对端的会话（App 里接的是 textSession.canAcceptFrom）。
   *
   *  在**握手之前**问，因为等到会话状态机拿到连接再关掉，等于白跑一次 commit-reveal，
   *  跨网络上还白占一次 TURN 分配。不传就当作允许。 */
  canAccept?: (from: string) => boolean;
  /** 这间房自己的 `/api/ice` 答复。可选，不传就是"早就到了"。见 RoomIceGate。 */
  roomIce?: RoomIceGate;
}

/** 建一条消息连接并把它包成 TextConn：完整的 commit-reveal，自己的密钥、自己的 SAS。 */
async function link(
  deps: TextLinkDeps,
  peerId: string,
  role: "initiator" | "responder",
  initialSignal?: InboundSignal,
): Promise<TextConn> {
  const self = generateKeyPair();
  let keys: Awaited<ReturnType<typeof deriveSession>> | undefined;
  let code = "";
  let lost = false;

  const conn = await connectText({
    signaling: deps.signaling(),
    peerId,
    selfKey: self.publicKey,
    role,
    config: deps.rtcConfig(),
    initialSignal,
    onPeerKey: (pk) => {
      code = sas(self.publicKey, pk);
      // deriveSession 是异步的；下面的循环等它落地。
      void deriveSession(role, self, pk).then((k) => (keys = k));
    },
    onStateChange: (s) => { if (s === "failed" || s === "closed") lost = true; },
  });

  // 和 transfer-session 一样等密钥：对端的 reveal 跟着 answer 到，掉线就别空转。
  while (!keys) {
    if (lost) { conn.close(); throw new Error("relayium: message connection lost before key exchange"); }
    await sleep(20);
  }

  return {
    // RTCDataChannel 的 onmessage 类型是给 MessageEvent 写的，而状态机只读 .data。
    // establish() 的 arm() 已经把 binaryType 设成 "arraybuffer"，所以运行时 .data
    // 就是 ArrayBuffer——transfer-session 的接收侧也是同一个断言。整条链上只在这一处
    // 收窄，状态机那边就不必认识 DOM 类型。
    channel: conn.channel as unknown as TextConn["channel"],
    // Asked per send, never captured: SCTP settles the number with the peer, and
    // it is the only thing standing between a 64 KiB paste and a dead channel.
    maxFrameBytes: () => conn.maxFrameBytes(),
    // The channel has been open since well before this object exists: the key
    // exchange, the poll above and the path sample below all run on top of an
    // open channel, and the session that owns it attaches later still. The
    // transport retained whatever the peer sent meanwhile; hand that drain to
    // the session, which is the only thing that knows what the frames mean.
    takeCaptured: () => conn.takeCaptured?.("relayium") ?? { frames: [], overflow: false },
    keys,
    sas: code,
    path: await conn.path(),
    close: () => conn.close(),
  };
}

/** The two transport dependencies createTextSession needs. */
export function createTextLink(deps: TextLinkDeps) {
  /**
   * The one inbound offer waiting for this room's configuration.
   *
   * Same rule and same shape as the file lane's (see transfer-session's
   * `parkedOffer`): at most one, retired by identity rather than by a flag, so a
   * retirement and a wake-up can never both build.
   *
   * Parked rather than refused for the reason the busy reply itself gives away:
   * `establish` turns it into a `PeerBusyError` and the initiator goes straight
   * to `peerBusy` — terminal, no retry. Nobody holds this lane during the
   * window; the only thing missing is a configuration to run the commit-reveal
   * on top of, and that always arrives.
   */
  let parked: { from: string; offer: InboundSignal } | null = null;
  /** 明确告诉对端"忙"。**必须带 text 标记**，否则发起方的 text 世代连接会把这条信令
   *  按世代丢掉，白等 30 秒；带上之后 establish 会把它变成 PeerBusyError。 */
  const replyBusy = (from: string) =>
    deps.signaling().sendSignal(from, { busy: true, text: true });
  const accepts = (from: string) => !deps.canAccept || deps.canAccept(from);
  const start = (from: string, offer: InboundSignal, onOffer: (peerId: string, conn: TextConn) => void) => {
    void link(deps, from, "responder", offer)
      .then((conn) => onOffer(from, conn))
      // 建不起来就是没这回事：会话状态机连"有人来过"都不该看到，用户也就不会
      // 看到一张点不动的请求卡。
      .catch((err) => console.error("relayium message offer error", err));
  };

  async function park(from: string, offer: InboundSignal, onOffer: (peerId: string, conn: TextConn) => void) {
    const gate = deps.roomIce;
    if (!gate) return; // unreachable: only reached through gate.pending()
    // 另一个对端已经停在这里了：这是真正的并发冲突，回 busy，和窗口关掉之后
    // canAccept 会给它的答案一模一样。同一个对端再来一条，则是它自己的重试——
    // 新的那条 offer 顶掉旧的，只留一条。
    if (parked && parked.from !== from) { replyBusy(from); return; }
    const mine = { from, offer };
    parked = mine;
    const live = await gate.whenReady();
    // 还占着位子的那个负责腾位子，**被换房间作废时也一样**：否则下一间房的第一条
    // offer 会因为上一间房留下的这条记录被回一个不该回的 busy。
    const owned = parked === mine;
    if (owned) parked = null;
    // 停着的时候被作废了：换房间（live 为假）、对端离开、取消，或者这个对端自己的新
    // offer 顶掉了它。
    if (!live || !owned) return;
    // 预检重问一遍，不是沿用停下来时的那次：这中间隔了一整个 HTTP 往返，而文件传输
    // 完全可能在这期间开始（text-session 在握手落地时也是同样地再查一遍）。
    if (!accepts(from)) { replyBusy(from); return; }
    start(from, offer, onOffer);
  }

  return {
    connect: (peerId: string) => link(deps, peerId, "initiator"),
    listen(onOffer: (peerId: string, conn: TextConn) => void): () => void {
      return deps.signaling().onSignal((from, data) => {
        if (!isTextOffer(data)) return;
        // 冲突在前，配置在后：真有会话/传输在跑就是 busy，这和房间有没有拿到 ICE
        // 答复无关；反过来，"还没拿到配置"绝不该冒充 busy。
        if (!accepts(from)) { replyBusy(from); return; }
        if (deps.roomIce?.pending()) { void park(from, data, onOffer); return; }
        start(from, data, onOffer);
      });
    },
    /** 这个对端走了：它停在这里的那条 offer 跟着作废。别的对端的不受影响。 */
    peerGone: (peerId: string) => { if (parked?.from === peerId) parked = null; },
    /** 停着的入站 offer 直接作废——它等的那个房间/socket 已经不在了。可重复调用。 */
    retireParkedInbound: () => { parked = null; },
  };
}
