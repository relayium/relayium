// 建连的入口。传输那一层（offer/answer、ICE、DataChannel、状态机、拆除）在
// webrtc-core.ts 的 establish()；本文件只留 relayium 自己的那一层：
//   connect()       —— 首次建连，带 commit-then-reveal 密钥握手
//   connectResume() —— 掉线重连，纯传输，另一个信令世代
import type { SignalingClient } from "./signaling";
import { commitKey, randomNonce, verifyCommit } from "./crypto";
import { CAP_TEXT } from "./peer-caps.svelte";
import { establish } from "./webrtc-core";
import { classifyPath } from "./webrtc-core";
import type { Conn, ConnPath, Generation, InboundSignal, Reveal, RtcConfig, SignalAuth } from "./webrtc-core";

// 传输层的类型/工具从这里再导出：调用方只认 "./webrtc" 这一个入口，拆分是内部事。
export { DEFAULT_ICE, PeerBusyError, classifyPath, signalGeneration } from "./webrtc-core";
export type { Conn, ConnPath, Generation, InboundSignal, Reveal, RtcConfig, SignalAuth } from "./webrtc-core";

/** What this build advertises to its peers. A list rather than a flag so a later
 *  capability needs no new field on the wire. See peer-caps.svelte.ts for why the
 *  authoritative announcement is at the roster level and this one is only the
 *  per-connection confirmation. */
export const LOCAL_CAPS: readonly string[] = [CAP_TEXT];

export interface ConnectOpts {
  signaling: SignalingClient;
  peerId: string;
  selfKey: Uint8Array;
  role: "initiator" | "responder";
  onPeerKey: (k: Uint8Array) => void;
  /** The peer's advertised capabilities, from its offer or answer — so both sides
   *  know them before the channel opens. Non-string entries are filtered out; a
   *  peer that sends no caps never fires this. */
  onPeerCaps?: (caps: string[]) => void;
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  /** Notified whenever the peer connection changes state. Lets the UI surface a
   *  drop as a failed transfer instead of hanging forever. "failed"/"closed" are
   *  terminal; a transient "disconnected" triggers an automatic ICE restart. */
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

/** One end of the selected ICE pair. `address`/`port` are omitted unless the
 *  caller opts into IPs (the debug panel redacts by default). */
export interface CandidateInfo {
  candidateType?: string; // host / srflx / prflx / relay
  protocol?: string; // udp / tcp
  relayProtocol?: string; // for a relay candidate: the client↔TURN transport (udp/tcp/tls)
  address?: string;
  port?: number;
}

/** A human-readable snapshot of the live connection for the debug panel. */
export interface ConnDiagnostics {
  path: ConnPath;
  rttMs?: number;
  outgoingBitrateKbps?: number;
  bytesSent?: number;
  bytesReceived?: number;
  local?: CandidateInfo;
  remote?: CandidateInfo;
  dataChannel?: { state?: string; messagesSent?: number; messagesReceived?: number; bytesSent?: number; bytesReceived?: number };
}

/** Extract a readable connection diagnostic from a getStats() report: the selected
 *  ICE pair's transport (candidate types, relay protocol, RTT, available bitrate)
 *  plus data-channel counters. IPs are redacted unless includeIps. Pure/testable;
 *  feeds the ?debug=1 panel — the fastest way to see why a transfer is slow (e.g. a
 *  TLS/TCP relay fallback, or a high-RTT relay hairpin). */
export function summarizeStats(stats: RTCStatsReport, includeIps = false): ConnDiagnostics {
  type Row = Record<string, unknown> & { type?: string; selected?: boolean; nominated?: boolean; state?: string };
  let pair: Row | undefined;
  let dc: Row | undefined;
  stats.forEach((r) => {
    const s = r as Row;
    if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) pair ??= s;
    if (s.type === "data-channel") dc ??= s;
  });
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const cand = (id: unknown): CandidateInfo | undefined => {
    if (typeof id !== "string") return undefined;
    const c = stats.get(id) as Row | undefined;
    if (!c) return undefined;
    const addr = str(c.address) ?? str(c.ip);
    return {
      candidateType: str(c.candidateType),
      protocol: str(c.protocol),
      relayProtocol: str(c.relayProtocol),
      address: includeIps ? addr : addr ? "•••" : undefined,
      port: includeIps ? num(c.port) : undefined,
    };
  };
  const d: ConnDiagnostics = { path: classifyPath(stats) };
  if (pair) {
    const rtt = num(pair.currentRoundTripTime);
    if (rtt !== undefined) d.rttMs = Math.round(rtt * 1000);
    const abr = num(pair.availableOutgoingBitrate);
    if (abr !== undefined) d.outgoingBitrateKbps = Math.round(abr / 1000);
    d.bytesSent = num(pair.bytesSent);
    d.bytesReceived = num(pair.bytesReceived);
    d.local = cand(pair.localCandidateId);
    d.remote = cand(pair.remoteCandidateId);
  }
  if (dc) {
    d.dataChannel = {
      state: str(dc.state),
      messagesSent: num(dc.messagesSent),
      messagesReceived: num(dc.messagesReceived),
      bytesSent: num(dc.bytesSent),
      bytesReceived: num(dc.bytesReceived),
    };
  }
  return d;
}

// 分块拼而不是 String.fromCharCode(...bytes)：spread 会把每个字节铺成一个实参，
// 几万字节就能撞上引擎的实参上限直接抛 RangeError。这里的输入只有公钥/承诺
// （32 字节），但这个函数没有任何东西保证调用方永远只传小 buffer。
function b64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * 首次建连。传输交给 establish()，本函数只负责 commit-then-reveal：
 * 随 SDP 发出 BLAKE2b(selfKey || selfNonce)，等拿到对端的 commit 之后才揭示
 * selfKey/selfNonce。为什么这一步才让 6 位 SAS 挡得住恶意信令服务器的中间人，
 * 见 crypto.ts 的注释。
 */
export function connect(opts: ConnectOpts): Promise<Conn> {
  return handshakeConnect(opts, "file");
}

/**
 * 为**消息会话**建连。跑的是完整的 commit-reveal（不是 resume），所以它协商出自己的
 * 会话密钥和自己的 6 位 SAS——消息面板显示的就是那一串。
 *
 * 它跑在自己的信令世代上：一条 text 世代的 offer 永远不会落到 listenForIncoming 手里
 * （否则对端会当成一次文件传输开始收，然后等一个永远不来的 manifest），一条文件 offer
 * 也永远不会落到消息监听器手里。phase 1 里消息会话和文件传输本来就互斥（busy()），
 * 但世代隔离让那条互斥是一道**保证**，而不是一场竞态。
 */
export function connectText(opts: ConnectOpts): Promise<Conn> {
  return handshakeConnect(opts, "text");
}

/** Establishes the trust layer for a mixed file+text link. Capability gating and
 *  ownership live in the link coordinator; keeping this transport primitive free
 *  of roster state makes it testable and prevents it from advertising early. */
export function connectLink(opts: ConnectOpts): Promise<Conn> {
  return handshakeConnect(opts, "link");
}

async function handshakeConnect(opts: ConnectOpts, generation: Generation): Promise<Conn> {
  const { signaling, peerId, selfKey, role, onPeerKey } = opts;

  const selfNonce = randomNonce();
  const selfCommit = b64(commitKey(selfKey, selfNonce));
  let peerCommit: Uint8Array | undefined;
  let revealSent = false;
  let peerKeyDelivered = false;

  // Disclose our real key + nonce. Guarded to once: an ICE-restart answer would
  // otherwise re-trigger this after the SAS is already fixed.
  //
  // 这一条**绕过了 establish 的 send()**（reveal 不是 SDP/ICE，钩子也拿不到那个闭包），
  // 所以世代标记得在这里自己盖上。resume 世代不跑 commit-reveal，从来没有 reveal 要发，
  // 所以这个绕行以前无关紧要；有了第三个**也跑握手**的世代之后，漏掉标记的后果是对端
  // 按世代把它过滤掉，握手永远完不成。
  function sendReveal() {
    if (revealSent) return;
    revealSent = true;
    const msg: InboundSignal = { reveal: { key: b64(selfKey), nonce: b64(selfNonce) } };
    if (generation === "text") msg.text = true;
    if (generation === "link") msg.link = true;
    signaling.sendSignal(peerId, msg);
  }

  return establish({
    signaling,
    peerId,
    role,
    generation,
    // Keeps "connection failed" and "text connection failed" apart in logs and
    // tests; the file generation keeps its existing unlabelled wording.
    label: generation === "text" ? "text" : generation === "link" ? "link" : undefined,
    channelLabels: generation === "link" ? ["relayium", "relayium-text"] : undefined,
    config: opts.config,
    initialSignal: opts.initialSignal,
    onStateChange: opts.onStateChange,

    // The commit rides along with every offer/answer we send; caps ride with it
    // as the per-connection confirmation of the roster-level hello.
    sdpExtra: () => ({ commit: selfCommit, caps: [...LOCAL_CAPS] }),

    // Must run *before* the SDP is handled: answering an offer sends our commit,
    // and the peer's commit has to be recorded by then or a reveal that arrives
    // in the same burst has nothing to verify against.
    beforeSdp: (msg) => {
      if (msg.commit) peerCommit = unb64(msg.commit);
      // Peer-authored: only report a well-formed list, and never let a bad one
      // throw in here — this runs inside the inbound signalling chain.
      if (Array.isArray(msg.caps)) {
        opts.onPeerCaps?.(msg.caps.filter((c): c is string => typeof c === "string"));
      }
    },

    // Initiator now holds the responder's commit → safe to reveal our key.
    onAnswer: sendReveal,

    // Verify a peer reveal against its earlier commit. A mismatch means the value
    // was chosen after seeing our key (or tampered in flight): abort hard, never
    // open the channel — silently continuing would defeat the SAS entirely.
    afterSdp: (msg, ctx) => {
      if (!msg.reveal || peerKeyDelivered) return; // ignore duplicates (e.g. ICE restart)
      const peerPub = unb64(msg.reveal.key);
      const peerNonce = unb64(msg.reveal.nonce);
      if (!peerCommit || !verifyCommit(peerCommit, peerPub, peerNonce)) {
        // fail() unblocks a caller still awaiting connect(); close() tears down
        // even if the channel already opened (then fail() is a settled no-op),
        // surfacing to the app as a dropped connection rather than a silent MITM.
        ctx.fail(new Error("relayium: key commitment mismatch — possible MITM"));
        ctx.close();
        return;
      }
      peerKeyDelivered = true;
      // Responder learns the peer key from the reveal and only now discloses its
      // own; the initiator has already revealed (on receiving the answer's commit).
      if (role === "responder") sendReveal();
      onPeerKey(peerPub);
    },
  });
}

interface ResumeOpts {
  signaling: SignalingClient;
  peerId: string;
  role: "initiator" | "responder";
  /** Authenticates this connection's signalling with the keys the first
   *  connection already anchored. Required in the app — see connectResume. */
  auth: SignalAuth;
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  onStateChange?: (state: RTCPeerConnectionState) => void;
}

/**
 * Re-establish a data channel for a transfer whose original connection dropped,
 * WITHOUT re-running the commit-reveal handshake. Trust and the session keys were
 * already anchored (and SAS-verified by the user) on the first connection; the
 * caller reuses those keys, so no new key is exchanged here and the SAS is
 * unchanged.
 *
 * 它和 connect() 共用 establish() 的传输骨架，但**不重跑握手**——这就是
 * "纯传输" 这句话在代码里的形态，而不是一句注释里的承诺。`resume: true` 让它跑在
 * 另一个信令世代上：正在死掉的原连接与它互相看不见对方的 SDP。
 *
 * 唯一挂上的是 `auth`：这条路径没有 commit-reveal，如果信令不做对端认证，能改写
 * 信令的中间人就可以自己发一个 resume offer 接管这一半会话——密文他解不开（密钥没
 * 换），但足以窥探进度元数据、投递畸形的 RESUME_REQ、重放密文把传输弄坏。用会话
 * 密钥派生的 HMAC 绑定信令，"拿得出这个 tag" 本身就等价于 "持有第一次连接协商出的
 * 密钥"，而那正是用户当时用 SAS 核对过的东西。
 */
export async function connectResume(opts: ResumeOpts): Promise<Conn> {
  return establish({ ...opts, generation: "resume", label: "resume" });
}
