// 建连的公共骨架：offer/answer + ICE + DataChannel + 状态机 + 拆除。
//
// connect()（首次建连，带 commit-reveal）和 connectResume()（掉线重连，只搬运输层）
// 曾经是两份约 200 行逐字重复的代码，且已经开始漂移——`busy` 处理只加进了 connect
// 那一份。这里只抽**传输**这一层；密钥承诺/揭示那一层留在 webrtc.ts 的 connect 里，
// 通过下面的钩子挂进来。分界线是有意的：安全状态机不进这个文件，读 connectResume
// 的人也就不需要先说服自己"这条路径没有偷偷共享任何鉴权状态"。
import type { SignalingClient } from "./signaling";

export interface RtcConfig {
  iceServers: RTCIceServer[];
  // "relay" makes ICE gather/use only TURN candidates — set on the cross-network
  // path so we skip the ~20 s wait for doomed direct candidate checks to time out
  // before ICE falls back to the relay it would use anyway. Only safe when a TURN
  // server is actually configured (see hasTurnServer).
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export const DEFAULT_ICE: RtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** A public key + nonce revealed only after both commitments were exchanged. */
export interface Reveal {
  key: string; // base64 public key
  nonce: string; // base64 commitment nonce
}

export interface InboundSignal {
  sdp?: RTCSessionDescriptionInit;
  /** base64 BLAKE2b(pub || nonce); travels with the offer/answer SDP. */
  commit?: string;
  /** Sent only after this side has seen the peer's commit. */
  reveal?: Reveal;
  ice?: RTCIceCandidateInit;
  /** Marks a signal as belonging to a resume (connectResume) connection rather
   *  than the original connect(). Each side ignores the other generation's
   *  signals, so a dying original connection can't cross-route a resume offer. */
  resume?: boolean;
  /** The peer refused the offer because it is already in a transfer. Lets the
   *  sender fail fast with a "peer busy" message instead of waiting out the ICE
   *  timeout and mislabelling it a connection failure. */
  busy?: boolean;
  /** Peer renamed itself; the roster entry for that peer id should be updated to
   *  this display name. Opaque to the WebRTC handlers (like relayRtt/busy). */
  rename?: string;
}

/** The peer declined a fresh offer because it is mid-transfer (one at a time).
 *  Thrown by connect() so the caller can surface "peer busy" rather than a
 *  generic connection failure. */
export class PeerBusyError extends Error {
  constructor() {
    super("relayium: peer busy");
    this.name = "PeerBusyError";
  }
}

/** Which ICE path the connection is actually using. "lan" is a host↔host hop on
 *  the local network, "relay" means traffic is going through TURN, "p2p" is a
 *  direct hole-punched path over the public internet. "unknown" until a pair is
 *  selected (or on browsers that don't surface it). */
export type ConnPath = "lan" | "p2p" | "relay" | "unknown";

export interface Conn {
  channel: RTCDataChannel;
  /** Tear down the peer connection and stop listening for this peer's signals. */
  close(): void;
  /** The live ICE path, read from getStats() on demand. */
  path(): Promise<ConnPath>;
  /** Raw getStats() report — for the ?debug=1 diagnostics panel. */
  stats(): Promise<RTCStatsReport>;
}

/** Classify the in-use ICE path from a getStats() report: find the selected
 *  candidate pair, then read the candidate type on each end. A relay on either
 *  side means TURN; host↔host is a LAN direct hop; anything else (srflx/prflx,
 *  i.e. a NAT-traversed direct path) is P2P. Firefox flags the live pair with
 *  `selected`; Chromium leaves `nominated` + `succeeded` on it — accept either.
 *  Exported for unit testing against synthetic stats. */
export function classifyPath(stats: RTCStatsReport): ConnPath {
  let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
  stats.forEach((r) => {
    const s = r as unknown as { type: string; selected?: boolean; nominated?: boolean; state?: string };
    if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) {
      pair ??= r as unknown as typeof pair;
    }
  });
  if (!pair) return "unknown";
  const typeOf = (id?: string) =>
    id ? (stats.get(id) as unknown as { candidateType?: string } | undefined)?.candidateType : undefined;
  const local = typeOf(pair.localCandidateId);
  const remote = typeOf(pair.remoteCandidateId);
  if (local === "relay" || remote === "relay") return "relay";
  if (local === "host" && remote === "host") return "lan";
  return "p2p";
}

/** 建连总时限。ICE 可能一直停在 "checking" 而永远不翻 "failed"（没有可达路径、
 *  TURN 被墙），没有这个兜底，await 建连的调用方会永远卡在 0%。 */
const CONNECT_TIMEOUT_MS = 30_000;

/** 8MB 在途窗口，让管道始终有货可发。 */
const BUFFERED_LOW = 8 << 20;

export interface CoreHooks {
  /** SDP 处理**之前**跑：connect 用它记下对端的 commit（必须先于 answer 发出）。 */
  beforeSdp?(msg: InboundSignal): void;
  /** SDP 处理**之后**跑：connect 用它校验对端的 reveal。 */
  afterSdp?(msg: InboundSignal, ctx: CoreContext): void;
  /** 收到对端 answer 时跑：connect 用它揭示自己的密钥。 */
  onAnswer?(): void;
  /** 每条外发 SDP 信令上附加的字段（connect 用它带上 commit）。 */
  sdpExtra?(): Partial<InboundSignal>;
}

/** 钩子能回过头来影响连接的两个动作。握手校验失败必须两个都用：fail 解开还在
 *  await 的调用方，close 保证即使通道已经开了也照样拆掉。 */
export interface CoreContext {
  fail(err: Error): void;
  close(): void;
}

export interface CoreOpts extends CoreHooks {
  signaling: SignalingClient;
  peerId: string;
  role: "initiator" | "responder";
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  /** true = 重连世代。**双向**生效：外发信令一律带 `resume: true`，入站信令也只
   *  收带这个标记的。掉线重连时两个世代同时活着，靠它互不串台。 */
  resume?: boolean;
  /** 错误文案前缀，让 "connection failed" 和 "resume connection failed" 在日志和
   *  测试里可区分。 */
  label?: string;
}

export async function establish(opts: CoreOpts): Promise<Conn> {
  const { signaling, peerId, role, resume = false } = opts;
  const what = opts.label ? `${opts.label} connection` : "connection";
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);

  /** 给外发信令盖上世代标记。 */
  const tag = <T extends object>(msg: T): T & { resume?: boolean } =>
    resume ? { ...msg, resume: true } : msg;

  pc.onicecandidate = (e) => {
    if (e.candidate) signaling.sendSignal(peerId, tag({ ice: e.candidate }));
  };

  let channel: RTCDataChannel;
  let opened = false;
  let failReady!: (err: Error) => void;
  const ready = new Promise<RTCDataChannel>((resolve, reject) => {
    failReady = reject;
    const open = (ch: RTCDataChannel) => { opened = true; resolve(ch); };
    const arm = (ch: RTCDataChannel) => {
      ch.binaryType = "arraybuffer";
      ch.bufferedAmountLowThreshold = BUFFERED_LOW;
    };
    if (role === "initiator") {
      channel = pc.createDataChannel("relayium");
      arm(channel);
      channel.onopen = () => open(channel);
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        arm(channel);
        if (channel.readyState === "open") open(channel);
        else channel.onopen = () => open(channel);
      };
    }
  });

  const connectTimer = setTimeout(() => {
    if (!opened) failReady(new Error(`relayium: ${what} timed out`));
  }, CONNECT_TIMEOUT_MS);

  function close() {
    off();
    try { pc.close(); } catch { /* already closed */ }
  }
  const ctx: CoreContext = { fail: (err) => failReady(err), close };

  async function handleSignal(msg: InboundSignal) {
    opts.beforeSdp?.(msg);
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (msg.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signaling.sendSignal(peerId, tag({ sdp: answer, ...opts.sdpExtra?.() }));
      } else if (msg.sdp.type === "answer") {
        opts.onAnswer?.();
      }
    }
    opts.afterSdp?.(msg, ctx);
    if (msg.ice) {
      try {
        await pc.addIceCandidate(msg.ice);
      } catch {
        // A candidate arriving before remoteDescription is set, or after close,
        // is non-fatal on a LAN where host candidates in the SDP usually suffice.
      }
    }
  }

  const off = signaling.onSignal((from, data) => {
    const msg = data as InboundSignal;
    if (from !== peerId || !!msg.resume !== resume) return; // 别的世代的信令不是我们的
    // The peer is mid-transfer and won't answer — stop waiting for a channel that
    // will never open and report it as "peer busy". A no-op once opened.
    if (msg.busy) { if (!opened) failReady(new PeerBusyError()); return; }
    handleSignal(msg).catch((err) => console.error(`relayium ${what} signal error`, err));
  });

  // A transient "disconnected" (a NAT rebinding, a brief network blip) often
  // recovers on its own, and an ICE restart forces fresh candidate gathering to
  // speed that up. Only the initiator drives renegotiation; guard to one attempt
  // so a genuinely dead path fails fast instead of looping offers.
  let restarted = false;
  async function tryIceRestart() {
    if (restarted || role !== "initiator") return;
    restarted = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      signaling.sendSignal(peerId, tag({ sdp: offer }));
    } catch (err) {
      console.error(`relayium ${what} ice restart error`, err);
    }
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    opts.onStateChange?.(state);
    if (state === "disconnected") tryIceRestart();
    // A failure before the channel ever opened must unblock the caller; after it
    // opened, `ready` is already settled and this reject is a harmless no-op.
    if (state === "failed" && !opened) failReady(new Error(`relayium: ${what} failed`));
    // Once the connection reaches a terminal state, stop routing this peer's
    // signals so listeners don't pile up across repeated transfers.
    if (state === "closed" || state === "failed") off();
  };

  if (role === "initiator") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendSignal(peerId, tag({ sdp: offer, ...opts.sdpExtra?.() }));
  } else if (opts.initialSignal) {
    await handleSignal(opts.initialSignal);
  }

  try {
    const openChannel = await ready;
    clearTimeout(connectTimer);
    return {
      channel: openChannel,
      close,
      path: (): Promise<ConnPath> => pc.getStats().then(classifyPath),
      stats: () => pc.getStats(),
    };
  } catch (err) {
    // Establishment failed or timed out: clean up the listener and peer
    // connection, then propagate so the caller shows a retryable failure
    // instead of a progress bar frozen at 0%.
    clearTimeout(connectTimer);
    close();
    throw err;
  }
}
