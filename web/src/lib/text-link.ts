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
    keys,
    sas: code,
    path: await conn.path(),
    close: () => conn.close(),
  };
}

/** The two transport dependencies createTextSession needs. */
export function createTextLink(deps: TextLinkDeps) {
  return {
    connect: (peerId: string) => link(deps, peerId, "initiator"),
    listen(onOffer: (peerId: string, conn: TextConn) => void): () => void {
      return deps.signaling().onSignal((from, data) => {
        if (!isTextOffer(data)) return;
        if (deps.canAccept && !deps.canAccept(from)) {
          // 明确告诉对端"忙"，而不是让它等到 ICE 超时。**必须带 text 标记**，否则发起方
          // 的 text 世代连接会把这条信令按世代丢掉，白等 30 秒；带上之后 establish 会把
          // 它变成 PeerBusyError，发起方直接进 peerBusy。
          deps.signaling().sendSignal(from, { busy: true, text: true });
          return;
        }
        void link(deps, from, "responder", data)
          .then((conn) => onOffer(from, conn))
          // 建不起来就是没这回事：会话状态机连"有人来过"都不该看到，用户也就不会
          // 看到一张点不动的请求卡。
          .catch((err) => console.error("relayium message offer error", err));
      });
    },
  };
}
