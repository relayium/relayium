// 建连的入口。传输那一层（offer/answer、ICE、DataChannel、状态机、拆除）在
// webrtc-core.ts 的 establish()；本文件只留 relayium 自己的那一层：
//   connectLink()       —— 首次建连一条 link/1，带 commit-then-reveal 密钥握手
//   connectResumeLink() —— 掉线重连，纯传输，另一个信令世代
//
// 只剩这两个。原来还有单道文件、单道消息两个首次建连入口和它们共用的那个 resume，
// 那是浏览器同时支持三种世代时的形状；现在浏览器只组合 link/1 这一条传输，留着另外
// 三个入口就等于把第二条传输摆在手边——它们在本文件里一个调用点都没有，而一个没有
// 调用点的建连原语只会在下一次"临时兜个底"的时候被接回去。
// （名字刻意不写在这里：link-only-surface 的守卫是对生产源码的子串检查，一句注释里
//  的旧名字会让它对着自己的墓志铭报警。）
// 世代**词表**（webrtc-core 的 Generation）反而必须留全：peer-link 用
// `signalGeneration(msg) === "link"` 精确判定，"file"/"text" 得存在，那条精确
// 比较才有东西可以拒绝。
import type { SignalingClient } from "./signaling";
import { commitKey, randomNonce, verifyCommit } from "./crypto";
import { advertisedCaps } from "./peer-caps.svelte";
import { establish } from "./webrtc-core";
import { classifyPath } from "./webrtc-core";
import type { Conn, ConnPath, Generation, InboundSignal, Reveal, RtcConfig, SignalAuth } from "./webrtc-core";

// 传输层的类型/工具从这里再导出：调用方只认 "./webrtc" 这一个入口，拆分是内部事。
// authPayload is re-exported so a caller that owns a session's keys can verify an
// inbound resume signal BEFORE handing it to a connection primitive — the exact
// bytes a tag covers must come from one place, never be re-derived at a call site.
export { DEFAULT_ICE, PeerBusyError, authPayload, classifyPath, linkLeavePayload, signalGeneration } from "./webrtc-core";
export type { Conn, ConnPath, Generation, InboundSignal, Reveal, RtcConfig, SignalAuth } from "./webrtc-core";

/** What this build advertises to its peers. A list rather than a flag so a later
 *  capability needs no new field on the wire. See peer-caps.svelte.ts for why the
 *  authoritative announcement is at the roster level and this one is only the
 *  per-connection confirmation — and for what decides the contents.
 *
 *  A function, not a constant. Every room advertises link/1 today, so the two
 *  answers happen to agree — but a room switch still happens without a page
 *  reload, and a value frozen at import time would confirm the load-time room's
 *  capabilities on a connection made after the switch. That is the asymmetry
 *  that strands a peer: advertising one thing at the roster level and another in
 *  the SDP. Derived from the one source so the two announcements cannot drift. */
export function localCaps(): readonly string[] {
  return advertisedCaps();
}
/** One maximum encrypted manifest plus lifecycle overhead. This is deliberately
 *  much smaller than the file flow-control window: pre-attachment traffic has
 *  not reached a content-consent state yet. */
export const LINK_CAPTURE_MAX_BYTES = 256 * 1024;
/** The exact lane labels a mixed link carries, in primary-first order. One
 *  constant so the first connection and an authenticated transport resume can
 *  never disagree about which SCTP streams make up a link. */
/** Re-exported from core, where the option types can name the exact tuple.
 *  `readonly string[]` here admitted the one-element legacy list, which is what
 *  kept a single-lane connection constructible. */
export { LINK_CHANNEL_LABELS } from "./webrtc-core";
import { LINK_CHANNEL_LABELS } from "./webrtc-core";

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
  /** Abort only while establishing; an opened connection is closed via Conn. */
  signal?: AbortSignal;
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
 * 首次建连一条 link/1。传输交给 establish()，本函数只负责 commit-then-reveal：
 * 随 SDP 发出 BLAKE2b(selfKey || selfNonce)，等拿到对端的 commit 之后才揭示
 * selfKey/selfNonce。为什么这一步才让 6 位 SAS 挡得住恶意信令服务器的中间人，
 * 见 crypto.ts 的注释。
 *
 * Capability gating and ownership live in the link coordinator; keeping this
 * transport primitive free of roster state makes it testable and prevents it
 * from advertising early.
 *
 * 世代写死成 `"link"`，不再是参数。它曾经是参数，是因为同一套握手要服务三个世代；
 * 现在只剩一个，而一个"想建哪个世代就传哪个"的参数正好是把 file/text 世代接回来
 * 所需要的最后一块。
 */
export function connectLink(opts: ConnectOpts): Promise<Conn> {
  return handshakeConnect(opts);
}

/**
 * 揭示密钥的时限，**从数据通道打开那一刻开始算**。
 *
 * establish() 的超时只管到"数据通道开了"为止，一旦开了它就把定时器清掉。但通道开了
 * 不等于握手完成：reveal 走的是信令（WebSocket），不是数据通道。信令在 answer 之后
 * 断掉、对端的 reveal 在路上丢了、或者对端进程被系统冻结（手机切到后台/锁屏最常见），
 * 通道会好端端地开着，而 reveal 永远不来。
 *
 * 调用方那边等的是 `while (!keys)`——一个**没有任何上界**的自旋。于是界面就永远停在
 * "正在建立加密连接…" 的 0%，既不失败也不前进，取消按钮之外没有任何出口。
 *
 * 从"通道已开"起算而不是从头起算，是为了不出现"通道早就开好了、却还要空等到总时限"
 * 这种沉默：通道一开，剩下要等的只有一条信令消息，30 秒足够，也足够短。
 */
const KEY_REVEAL_TIMEOUT_MS = 30_000;

/**
 * 从建连开始到"密钥可用"的**总上限**，任何进展都不重置它。
 *
 * 传输层自己有一条同样长度的硬上限（webrtc-core 的 SETUP_HARD_CAP_MS），这一条盖在
 * 它外面：传输层那条在通道打开时就清掉了，而握手还能再等一个 KEY_REVEAL 窗口。两条
 * 定时器一起，最坏情况是"总共 90 秒后一定有结论"，而不是 90 + 30。
 */
const SETUP_DEADLINE_MS = 90_000;

async function handshakeConnect(opts: ConnectOpts): Promise<Conn> {
  const generation: Generation = "link";
  const { signaling, peerId, selfKey, role, onPeerKey } = opts;

  const selfNonce = randomNonce();
  const selfCommit = b64(commitKey(selfKey, selfNonce));
  let peerCommit: Uint8Array | undefined;
  let revealSent = false;
  let peerKeyDelivered = false;

  // Settles when the peer's key has been revealed AND verified against its
  // commitment — the moment this connection is actually trustworthy. Armed here,
  // before any signalling, so the deadline covers the whole handshake.
  let keyDelivered!: () => void;
  let keyFailed!: (err: Error) => void;
  const peerKeyReady = new Promise<void>((resolve, reject) => {
    keyDelivered = resolve;
    keyFailed = reject;
  });
  void peerKeyReady.catch(() => {}); // observed below; this only silences the early-rejection warning
  const timedOut = () => keyFailed(new Error(`relayium: ${generation} key handshake timed out`));
  // Armed now and never re-armed: this is the ceiling on the whole setup.
  const setupTimer = setTimeout(timedOut, SETUP_DEADLINE_MS);
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => { clearTimeout(setupTimer); clearTimeout(keyTimer); };
  // Cancel must still work in the window this gate adds. establish() drops its
  // own abort listener once the channel opens, so without this a user pressing
  // cancel between "channel open" and "key verified" would get no response until
  // the deadline — and the pc would sit there alive for the rest of it.
  const abortHandshake = () => keyFailed(Object.assign(new Error("relayium: connection aborted"), { name: "AbortError" }));
  opts.signal?.addEventListener("abort", abortHandshake, { once: true });

  // Disclose our real key + nonce. Guarded to once: an ICE-restart answer would
  // otherwise re-trigger this after the SAS is already fixed.
  //
  // 这一条**绕过了 establish 的 send()**（reveal 不是 SDP/ICE，钩子也拿不到那个闭包），
  // 所以世代标记得在这里自己盖上。漏掉标记的后果是对端按世代把它过滤掉，握手永远完
  // 不成——resume 世代不跑 commit-reveal，所以只有这一条路会踩到。
  function sendReveal() {
    if (revealSent) return;
    revealSent = true;
    signaling.sendSignal(peerId, { link: true, reveal: { key: b64(selfKey), nonce: b64(selfNonce) } });
  }

  let conn: Conn;
  try {
    conn = await establish({
      signaling,
      peerId,
      role,
      generation,
      label: "link",
      // A link is not usable until BOTH lanes exist, so the complete set is
      // required here rather than discovered by a caller later.
      channelLabels: LINK_CHANNEL_LABELS,
      captureBeforeReadyBytes: LINK_CAPTURE_MAX_BYTES,
      config: opts.config,
      initialSignal: opts.initialSignal,
      onStateChange: opts.onStateChange,
      signal: opts.signal,

      // The commit rides along with every offer/answer we send; caps ride with it
      // as the per-connection confirmation of the roster-level hello.
      sdpExtra: () => ({ commit: selfCommit, caps: [...localCaps()] }),

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
          const mitm = new Error("relayium: key commitment mismatch — possible MITM");
          ctx.fail(mitm);
          // Also reject the handshake gate: once the channel has opened, ctx.fail
          // is a settled no-op and pc.close() fires no state change (per spec), so
          // without this a detected MITM would leave the caller waiting on a
          // promise nothing else ever settles.
          keyFailed(mitm);
          ctx.close();
          return;
        }
        peerKeyDelivered = true;
        // Responder learns the peer key from the reveal and only now discloses its
        // own; the initiator has already revealed (on receiving the answer's commit).
        if (role === "responder") sendReveal();
        onPeerKey(peerPub);
        keyDelivered();
      },
    });
  } catch (err) {
    // Transport never came up; nothing left to wait for.
    clearTimers();
    opts.signal?.removeEventListener("abort", abortHandshake);
    throw err;
  }
  // The channel is open, so only one signalling message is still owed. Start the
  // short window here rather than at the top — a setup that spent 80 s legitimately
  // progressing must not then get a fresh 30 s, and one that opened instantly must
  // not be left waiting out the overall deadline in silence.
  keyTimer = setTimeout(timedOut, KEY_REVEAL_TIMEOUT_MS);

  // The transport is up; the handshake may not be. Waiting here — rather than in
  // each caller's unbounded `while (!keys)` spin — is what makes "connecting" a
  // state with an end. Resolving no earlier than peerKeyDelivered is safe in both
  // roles: neither side can send an application frame before it holds the peer's
  // key, and the responder reveals its own key in the same turn it sets this.
  try {
    await peerKeyReady;
  } catch (err) {
    conn.close();
    throw err;
  } finally {
    clearTimers();
    opts.signal?.removeEventListener("abort", abortHandshake);
  }
  return conn;
}

interface ResumeOpts {
  signaling: SignalingClient;
  peerId: string;
  role: "initiator" | "responder";
  /** Authenticates this connection's signalling with the keys the first
   *  connection already anchored. Mandatory — see connectResumeLink. */
  auth: SignalAuth;
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  signal?: AbortSignal;
}

/**
 * Re-establish BOTH lanes of an existing link, WITHOUT re-running the
 * commit-reveal handshake. Trust and the session keys were already anchored (and
 * SAS-verified by the user) on the first connection; the caller reuses those
 * keys, so no new key is exchanged here and the SAS is unchanged.
 *
 * 它和 connectLink() 共用 establish() 的传输骨架，但**不重跑握手**——这就是
 * "纯传输" 这句话在代码里的形态，而不是一句注释里的承诺。`resume` 世代让它跑在
 * 另一个信令世代上：正在死掉的原连接与它互相看不见对方的 SDP。
 *
 * It waits for the complete label-keyed channel set (arrival order is
 * irrelevant) rather than resolving on the first channel: a link whose text lane
 * never opened is not a degraded link, it is a link that cannot honour `link/1`,
 * and discovering that at a call site later is how a half-built transport gets
 * used.
 *
 * 唯一挂上的是 `auth`：这条路径没有 commit-reveal，如果信令不做对端认证，能改写
 * 信令的中间人就可以自己发一个 resume offer 接管这一半会话——密文他解不开（密钥没
 * 换），但足以窥探进度元数据、投递畸形的 RESUME_REQ、重放密文把传输弄坏。用会话
 * 密钥派生的 HMAC 绑定信令，"拿得出这个 tag" 本身就等价于 "持有第一次连接协商出的
 * 密钥"，而那正是用户当时用 SAS 核对过的东西。**这就是"未认证或过期的 resume 永远
 * 接不上一条 link"这句话在代码里的位置**：`auth` 不是可选参数。
 *
 * Both lanes capture from the moment each channel is collected, bounded by the
 * same LINK_CAPTURE_MAX_BYTES the first connection uses: the peer may start
 * sending on the resumed file lane while this side's text lane is still
 * completing DCEP, and those frames belong to codecs that already exist.
 */
export async function connectResumeLink(opts: ResumeOpts): Promise<Conn> {
  return establish({
    ...opts,
    generation: "resume",
    label: "resume link",
    channelLabels: LINK_CHANNEL_LABELS,
    captureBeforeReadyBytes: LINK_CAPTURE_MAX_BYTES,
  });
}
