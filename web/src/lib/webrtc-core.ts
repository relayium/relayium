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

/**
 * 调用方没给 config 时的兜底。**空列表，不是公共 STUN**。
 *
 * 真实路径上 App 永远会传 rtcConfig()（服务端 /api/ice 下发的那份），所以这里只在
 * 测试和误用时生效。默认值放一个第三方 STUN 的代价是：任何一次忘记传 config，都会
 * 变成一次静默的对外报到（公网 IP + 会话时序）。空列表下局域网靠 host 候选照样能连，
 * 而跨网络本来就必须有服务端下发的 TURN。理由同 ice.ts 的 FALLBACK。
 */
export const DEFAULT_ICE: RtcConfig = { iceServers: [] };

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
  /** base64 HMAC over this message's SDP/ICE payload, keyed by a value derived
   *  from the session keys (see SignalAuth). Present only on resume signalling,
   *  where there is no commit-reveal handshake to anchor the peer's identity. */
  auth?: string;
  /** Peer renamed itself; the roster entry for that peer id should be updated to
   *  this display name. Opaque to the WebRTC handlers (like relayRtt/busy). */
  rename?: string;
  /** Capabilities the peer advertises, e.g. ["text/1"]. Rides the offer/answer
   *  as the per-connection confirmation of the roster-level hello in
   *  peer-caps.svelte.ts, and is opaque to the handlers here.
   *
   *  **Deliberately outside authPayload** — see its comment below: the field list
   *  is explicit so that adding one here cannot change what a resume tag covers.
   *  A hint, never a security input. */
  caps?: string[];
  /** Marks a signal as belonging to a message session's connection rather than a
   *  file transfer's, the same way `resume` marks the resume generation. Declared
   *  here so the type is one place; the generation filter that acts on it lands
   *  with connectText. */
  text?: boolean;
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

/** Authenticates signalling on a connection that runs no handshake of its own.
 *  A resume connection reuses keys the peers already agreed on (and the user
 *  already compared via SAS), so possession of those keys is exactly the proof
 *  that the offer came from the same peer — and a signalling MITM, which sees
 *  every SDP in the clear, cannot produce it. */
export interface SignalAuth {
  sign(payload: string): Promise<string>;
  verify(payload: string, mac: string | undefined): Promise<boolean>;
}

/** The exact bytes a signal's tag covers. Fields are listed explicitly rather
 *  than stringifying the message, so what is bound can't drift when a new
 *  field is added to InboundSignal, and so key order can't differ between the
 *  signer and the verifier. */
export function authPayload(msg: InboundSignal): string {
  return JSON.stringify({
    sdpType: msg.sdp?.type ?? null,
    sdp: msg.sdp?.sdp ?? null,
    candidate: msg.ice?.candidate ?? null,
    sdpMid: msg.ice?.sdpMid ?? null,
    sdpMLineIndex: msg.ice?.sdpMLineIndex ?? null,
    usernameFragment: msg.ice?.usernameFragment ?? null,
  });
}

/**
 * Which concurrent connection a signal belongs to.
 *
 * Two or three can be alive on one signalling link at once — a dying transfer and
 * its resume, a transfer and a message session — and each must ignore the others'
 * SDP. `"file"` is the untagged generation, which is what every already-deployed
 * peer sends and what this code has always sent.
 */
export type Generation = "file" | "resume" | "text";

/**
 * A signal's generation, from its tags.
 *
 * `resume` takes precedence when both are present. Nothing produces that
 * combination today (a message session does not resume), and pinning the order
 * makes it a decision rather than an accident; whoever teaches a message session
 * to resume has to revisit it here.
 */
export function signalGeneration(msg: InboundSignal): Generation {
  if (msg.resume) return "resume";
  if (msg.text) return "text";
  return "file";
}

export interface CoreOpts extends CoreHooks {
  signaling: SignalingClient;
  peerId: string;
  role: "initiator" | "responder";
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  /** 这条连接属于哪个信令世代。**双向**生效：外发信令一律盖上这个世代的标记，入站
   *  信令也只收同一个世代的。掉线重连时原连接和它的替身同时活着；消息会话和文件传输
   *  也可能同时活着——靠它互不串台。默认 "file"，也就是所有旧版本对端发的那种无标记
   *  信令。 */
  generation?: Generation;
  /** 错误文案前缀，让 "connection failed" 和 "resume connection failed" 在日志和
   *  测试里可区分。 */
  label?: string;
  /** 给这条连接的信令加**对端认证**。不传 = 不认证（connect() 就不传：它自己跑
   *  commit-reveal）。传了就是双向强制：外发全签，入站没签或签不对的一律丢弃。 */
  auth?: SignalAuth;
}

export async function establish(opts: CoreOpts): Promise<Conn> {
  const { signaling, peerId, role, generation = "file" } = opts;
  const what = opts.label ? `${opts.label} connection` : "connection";
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);

  /** 给外发信令盖上世代标记。"file" 不盖任何标记——旧版本对端看到的字节因此和
   *  这套世代命名之前完全一致。 */
  const tag = <T extends object>(msg: T): T & { resume?: boolean; text?: boolean } =>
    generation === "resume" ? { ...msg, resume: true }
    : generation === "text" ? { ...msg, text: true }
    : msg;

  // 外发信令统一走这里：盖世代标记 → 签名 → 发。签名是异步的，所以用一条串行链
  // 保序——offer 之后紧跟的 ICE 候选如果因为签名耗时反超到 offer 前面，对端会把它
  // 当作"remoteDescription 之前到达的候选"丢掉。
  let sendChain: Promise<void> = Promise.resolve();
  function send(msg: Omit<InboundSignal, "resume" | "text" | "auth">) {
    sendChain = sendChain
      .then(async () => {
        const out: InboundSignal = tag(msg);
        if (opts.auth) out.auth = await opts.auth.sign(authPayload(out));
        signaling.sendSignal(peerId, out);
      })
      .catch((err) => console.error(`relayium ${what} send error`, err));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ ice: e.candidate });
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
        send({ sdp: answer, ...opts.sdpExtra?.() });
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

  /** Verify (when authenticated) and then handle. A signal that fails the check
   *  is DROPPED, not fatal: the genuine peer's next signal still gets through,
   *  and if nothing genuine ever arrives the connect timeout ends it anyway. */
  async function accept(msg: InboundSignal) {
    if (opts.auth && !(await opts.auth.verify(authPayload(msg), msg.auth))) {
      console.warn(`relayium ${what}: dropped an unauthenticated signal`);
      return;
    }
    await handleSignal(msg);
  }

  // 入站也串行：accept 里多了一次异步校验，两条信令并发跑 setRemoteDescription
  // 会互相踩。
  let recvChain: Promise<void> = Promise.resolve();
  const off = signaling.onSignal((from, data) => {
    const msg = data as InboundSignal;
    if (from !== peerId || signalGeneration(msg) !== generation) return; // 别的世代的信令不是我们的
    // The peer is mid-transfer and won't answer — stop waiting for a channel that
    // will never open and report it as "peer busy". A no-op once opened.
    if (msg.busy) { if (!opened) failReady(new PeerBusyError()); return; }
    recvChain = recvChain
      .then(() => accept(msg))
      .catch((err) => console.error(`relayium ${what} signal error`, err));
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
      send({ sdp: offer });
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
    send({ sdp: offer, ...opts.sdpExtra?.() });
  } else if (opts.initialSignal) {
    // The signal that got us here goes through the same check as every later
    // one — it is the resume OFFER, i.e. exactly the message L3 is about.
    await accept(opts.initialSignal);
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
