// 建连的公共骨架：offer/answer + ICE + DataChannel + 状态机 + 拆除。
//
// 首次建连（带 commit-reveal）和掉线重连（只搬运输层）曾经是两份约 200 行逐字重复
// 的代码，且已经开始漂移——`busy` 处理只加进了其中一份。这里只抽**传输**这一层；
// 密钥承诺/揭示那一层留在 webrtc.ts，通过下面的钩子挂进来。分界线是有意的：安全状态机
// 不进这个文件，读重连那条路径的人也就不需要先说服自己"它没有偷偷共享任何鉴权状态"。
//
// 世代**词表**（下面的 Generation）比用它的那些世代活得久：浏览器如今只建 link/1，
// 但 peer-link 用 `signalGeneration(msg) === "link"` 精确判定，"file"/"text" 必须
// 继续存在，那条精确比较才有东西可以拒绝。
import type { SignalingClient } from "./signaling";
import { negotiatedMaxMessageBytes } from "./wire-limit";

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
  /** Marks a signal as belonging to a transport-only resume rather than the
   *  first connection. Each side ignores the other generation's signals, so a
   *  dying original connection can't cross-route a resume offer. */
  resume?: boolean;
  /** The peer refused the offer because it is already in a transfer. Lets the
   *  sender fail fast with a "peer busy" message instead of waiting out the ICE
   *  timeout and mislabelling it a connection failure. */
  busy?: boolean;
  /** base64 HMAC keyed by a value derived from the session keys (see SignalAuth).
   *  Covers authPayload on resume signalling and the separately domain-separated
   *  linkLeavePayload on an explicit mixed-link departure. */
  auth?: string;
  /** Peer renamed itself; the roster entry for that peer id should be updated to
   *  this display name. Opaque to the WebRTC handlers (like relayRtt/busy). */
  rename?: string;
  /** Capabilities the peer advertises, e.g. ["link/1"]. Rides the offer/answer
   *  as the per-connection confirmation of the roster-level hello in
   *  peer-caps.svelte.ts, and is opaque to the handlers here.
   *
   *  **Deliberately outside authPayload** — see its comment below: the field list
   *  is explicit so that adding one here cannot change what a resume tag covers.
   *  A hint, never a security input. */
  caps?: string[];
  /** The retired single-lane message generation. **Nothing in this build sends
   *  it.** It stays in the vocabulary because `signalGeneration` must be able to
   *  NAME it in order to keep an inbound frame carrying it away from the link
   *  generation — a tag we cannot classify would fall through to "file" and be
   *  refused for the wrong reason. */
  text?: boolean;
  /** Marks the unified file+text link generation — the only one this build
   *  establishes. It is sent only to peers that announced the roster-level
   *  `link/1` capability; older peers treat unknown offers as legacy file
   *  offers, so the tag alone is not a compatibility gate. */
  link?: boolean;
  /** Content-free request asking the deterministic (lower peer-id) offerer to
   *  establish a link. Not a generation tag and not authenticated; capability
   *  gating limits it to the same denial-of-service class as a forged caps hello. */
  linkRequest?: boolean;
  /** "I am leaving this link on purpose." Rides the `link` generation and is
   *  authenticated with the link's `resumeAuth` over `linkLeavePayload` — never
   *  over `authPayload`, which carries no direction and would be one constant
   *  string for a message with no SDP or ICE. A leave signal carries exactly
   *  `{ link, leave, auth }` and nothing else: any extra field would be visible
   *  to the establishment handlers that share this generation. */
  leave?: boolean;
}

/** The peer declined a fresh offer because it is already bound to a link.
 *  Thrown by the first-connection path so the caller can surface "peer busy"
 *  rather than a generic connection failure. */
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
  /** Exact-label lookup for a connection's logical lanes. `channel` remains the
   *  first requested label — the primary lane of the tuple every caller now
   *  states — so a caller that only ever wants that lane does not have to name
   *  it. There is no default: `channelLabels` is the exact link tuple. */
  getChannel(label: string): RTCDataChannel | undefined;
  /** Atomically detach and drain frames captured from the moment this channel
   *  was collected. Present only when pre-ready capture was requested. */
  takeCaptured?(label: string): { frames: readonly ArrayBuffer[]; overflow: boolean };
  /** Tear down the peer connection and stop listening for this peer's signals. */
  close(): void;
  /** The largest single DataChannel message this connection may carry. Not a
   *  constant of the local browser — SCTP negotiates it with the peer, so a
   *  sender must ask the connection, never assume. See wire-limit.ts. */
  maxFrameBytes(): number;
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

/**
 * 建连的时限是**两条**，不是一条。ICE 可能一直停在 "checking" 而永远不翻 "failed"
 * （没有可达路径、TURN 被墙），所以必须有兜底；但一刀 30 秒砍下去砍掉的恰恰是**正在
 * 推进**的那种连接：手机射频从空闲唤醒、TURN 长期凭据的两次 Allocate（第一次必然吃
 * 一个 401 challenge）、再加上双方各自打洞，一次正常的跨网建连可以超过 30 秒。
 *
 *   · NO_PROGRESS：连续这么久**没有任何对端进展**就失败——真的卡住了就快点给结论；
 *   · HARD_CAP：从建连开始算的总上限，**不因进展而重置**，所以"一直有点动静"也拖不
 *     过它。
 */
const NO_PROGRESS_TIMEOUT_MS = 30_000;
const SETUP_HARD_CAP_MS = 90_000;

/**
 * 最多有多少条远端候选算作"进展"。
 *
 * 候选是对端（或改写信令的中间人）可以无限刷的东西，所以它不能是一张无限续期的票。
 * 真实的一次 ICE 交换只有个位数条候选，这个数够用；超出的候选照常加进 pc，只是不再
 * 顺延时限。硬上限本身已经封死了总时间，这一条是让"刷候选"连接近硬上限都做不到。
 */
const MAX_CANDIDATE_PROGRESS = 6;

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
 * The exact bytes a link-leave tag covers.
 *
 * Deliberately NOT `authPayload`. A leave message has no SDP and no ICE, so
 * `authPayload` would render one constant string for the whole life of a link —
 * a tag with no direction, replayable in either direction once observed. The
 * `kind` field also makes this string unreachable from `authPayload`, whose
 * output always begins with `sdpType`, so a signature over one can never be
 * mistaken for a signature over the other.
 *
 * `from`/`to` are the room peer ids as each side knows them, so a relay that
 * reflects a leave back at its sender verifies the reversed tuple and fails.
 * Cross-link replay needs no nonce here: the key is `resumeAuth`, which a later
 * link never shares.
 */
export function linkLeavePayload(from: string, to: string): string {
  return JSON.stringify({ kind: "link-leave", from, to });
}

/**
 * Which concurrent connection a signal belongs to.
 *
 * A link and its resume can be alive on one signalling link at once, and each
 * must ignore the other's SDP.
 *
 * **This is the INBOUND vocabulary, and it is wider than what can be built.**
 * `"file"` is the untagged generation an already-deployed peer still sends and
 * `"text"` the retired single-lane one; this build sends neither — see
 * `OutboundGeneration` — but must keep naming them, because a tag it could not
 * classify would fall through to `"file"` and be answered as a legacy transfer.
 */
export type Generation = "file" | "resume" | "text" | "link";

/**
 * The generations this build can CONSTRUCT.
 *
 * Deliberately a different type from `Generation`, which is the inbound
 * classification vocabulary and must keep naming `file` and `text` in order to
 * recognise them — a tag this code could not classify would fall through to
 * `file` and be answered as a legacy transfer, which is the failure the tags
 * exist to prevent. Recognising a generation and being able to build one are
 * different questions, and collapsing them is what let a legacy transport stay
 * constructible after its lanes were deleted.
 *
 * `CoreOpts.generation` is REQUIRED and of this type, so there is no untagged
 * default to fall back into: `file` was the default, which meant every caller
 * that forgot the argument silently built the retired single-lane transfer.
 */
export type OutboundGeneration = "resume" | "link";

/**
 * The exact two lanes a `link/1` carries, in primary-first order.
 *
 * Declared here rather than in `webrtc.ts` so the option types below can name
 * the TUPLE — `readonly string[]` admitted any list, including the one-element
 * one that was the old default, so a guard on "channelLabels is required" was
 * satisfied by `["relayium"]` and the single-lane connection stayed
 * constructible. Keeping the literal in core also avoids an import cycle:
 * `webrtc.ts` imports core, not the other way round.
 */
export const LINK_CHANNEL_LABELS = ["relayium", "relayium-text"] as const;
export type LinkChannelLabels = typeof LINK_CHANNEL_LABELS;

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
  if (msg.link) return "link";
  if (msg.text) return "text";
  return "file";
}

/** Everything both constructible generations need, in the same shape. */
interface CoreOptsBase extends CoreHooks {
  signaling: SignalingClient;
  peerId: string;
  role: "initiator" | "responder";
  config?: RtcConfig;
  initialSignal?: InboundSignal;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  /** Cancels an in-progress establishment immediately. Once a Conn has been
   *  returned, callers use Conn.close() instead. */
  signal?: AbortSignal;
  /** 错误文案前缀，让 "connection failed" 和 "resume connection failed" 在日志和
   *  测试里可区分。 */
  label?: string;
  /** Combined byte ceiling for frames retained before application handlers are
   *  attached. Zero/absent preserves the legacy no-capture behavior. */
  captureBeforeReadyBytes?: number;
  /** Reliable ordered DataChannels required before this connection is ready.
   *  The initiator opens them through DCEP; the responder collects them by exact
   *  label, so arrival order is irrelevant.
   *
   *  **The exact link tuple, not a list.** It defaulted to `["relayium"]` — the
   *  legacy single lane — and even once required, `readonly string[]` still
   *  admitted that one-element list, so the single-lane connection stayed
   *  constructible and a guard on "required" false-greened. */
  channelLabels: LinkChannelLabels;
}

/**
 * **The initial `link/1` handshake.**
 *
 * No `auth`, and that is a type-level statement rather than a convention: this
 * connection runs its own commit-reveal (`connect()` in `webrtc.ts`) and has no
 * shared secret to sign with yet. Accepting a `SignalAuth` here would mean the
 * caller had one BEFORE the handshake that derives it.
 */
export interface LinkCoreOpts extends CoreOptsBase {
  generation: "link";
  auth?: never;
}

/**
 * **An authenticated transport resume.**
 *
 * `auth` is REQUIRED. A resume re-attaches to a link whose keys already exist,
 * so it is the one generation that can sign — and must: an unauthenticated
 * resume is a second connection anybody on the signalling path could offer into
 * a session that has already been verified. It was constructible because `auth`
 * was optional for every generation at once.
 */
export interface ResumeCoreOpts extends CoreOptsBase {
  generation: "resume";
  auth: SignalAuth;
}

/**
 * What `establish` accepts.
 *
 * A union rather than one interface with optional fields, because the two
 * generations have genuinely different requirements and an interface can only
 * express their intersection — which is what let an unauthenticated resume and
 * a single-lane link both typecheck.
 */
export type CoreOpts = LinkCoreOpts | ResumeCoreOpts;

export async function establish(opts: CoreOpts): Promise<Conn> {
  const { signaling, peerId, role, generation } = opts;
  const what = opts.label ? `${opts.label} connection` : "connection";
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);
  // The type is the tuple, so length and non-emptiness are compile-time facts.
  // Uniqueness is checked at runtime anyway: the constant is exported and a
  // JavaScript caller — a test, a future non-TypeScript consumer — is not bound
  // by the type. Failing closed is cheaper than a connection that waits for a
  // lane it already has.
  const channelLabels: readonly string[] = opts.channelLabels;
  if (new Set(channelLabels).size !== channelLabels.length) {
    try { pc.close(); } catch { /* constructor succeeded; close is best effort */ }
    throw new Error("relayium: channel labels must be unique");
  }

  /** 给外发信令盖上世代标记。只有两种世代能构造，所以这里没有"不盖标记"的分支——
   *  以前那条 `: msg` 兜底就是那条已经删掉的无标记旧世代，任何漏配的调用点都会掉
   *  进去。入站分类仍然认识 `file` 和 `text`，见 `signalGeneration`。 */
  const tag = <T extends object>(msg: T): T & { resume?: boolean; link?: boolean } =>
    generation === "resume" ? { ...msg, resume: true } : { ...msg, link: true };

  // 外发信令统一走这里：盖世代标记 → 签名 → 发。签名是异步的，所以用一条串行链
  // 保序——offer 之后紧跟的 ICE 候选如果因为签名耗时反超到 offer 前面，对端会把它
  // 当作"remoteDescription 之前到达的候选"丢掉。
  let sendChain: Promise<void> = Promise.resolve();
  function send(msg: Omit<InboundSignal, "resume" | "text" | "link" | "auth">) {
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

  const channels = new Map<string, RTCDataChannel>();
  const captures = new Map<string, {
    channel: RTCDataChannel;
    frames: ArrayBuffer[];
    handler: (event: MessageEvent) => void;
  }>();
  const captureLimit = opts.captureBeforeReadyBytes ?? 0;
  let capturedBytes = 0;
  let captureOverflow = false;
  let opened = false;
  let failReady!: (err: Error) => void;
  const ready = new Promise<Map<string, RTCDataChannel>>((resolve, reject) => {
    failReady = reject;
    const arm = (ch: RTCDataChannel) => {
      ch.binaryType = "arraybuffer";
      ch.bufferedAmountLowThreshold = BUFFERED_LOW;
      if (captureLimit > 0) {
        const frames: ArrayBuffer[] = [];
        const handler = (event: MessageEvent) => {
          if (captureOverflow) return;
          const data = event.data;
          const frame = data instanceof ArrayBuffer
            ? data
            : ArrayBuffer.isView(data)
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
              : null;
          if (!frame) return;
          if (capturedBytes + frame.byteLength > captureLimit) {
            captureOverflow = true;
            return;
          }
          capturedBytes += frame.byteLength;
          frames.push(frame);
        };
        captures.set(ch.label, { channel: ch, frames, handler });
        ch.onmessage = handler;
      }
    };
    const maybeOpen = () => {
      if (opened || channels.size !== channelLabels.length) return;
      for (const label of channelLabels) {
        if (channels.get(label)?.readyState !== "open") return;
      }
      opened = true;
      resolve(channels);
    };
    const collect = (ch: RTCDataChannel) => {
      if (!channelLabels.includes(ch.label) || channels.has(ch.label)) {
        // An unexpected or duplicate lane can never satisfy this connection.
        // Close only that channel; the required set may still arrive normally.
        try { ch.close(); } catch { /* already gone */ }
        return;
      }
      channels.set(ch.label, ch);
      arm(ch);
      // Handler first, *then* read the state. A lane can flip to open and
      // dispatch between those two steps, and that dispatch is the only one it
      // ever makes: deciding from the state whether to install a handler loses
      // the lane for good, and the connection hangs until the setup deadline
      // kills it. Installing first can only over-notify, never under-notify —
      // maybeOpen is idempotent and re-checks every lane, so the extra call
      // costs nothing.
      ch.onopen = maybeOpen;
      if (ch.readyState === "open") maybeOpen();
    };
    if (role === "initiator") {
      for (const label of channelLabels) collect(pc.createDataChannel(label));
    } else {
      pc.ondatachannel = (ev) => collect(ev.channel);
    }
  });
  // Establishment can fail while createOffer/setLocalDescription is still
  // pending, before execution reaches `await ready`. Mark the rejection as
  // observed now; the later await still receives and propagates the same error.
  void ready.catch(() => {});

  const expire = () => { if (!opened) failReady(new Error(`relayium: ${what} timed out`)); };
  const hardTimer = setTimeout(expire, SETUP_HARD_CAP_MS); // never re-armed
  let idleTimer = setTimeout(expire, NO_PROGRESS_TIMEOUT_MS);
  const clearTimers = () => { clearTimeout(hardTimer); clearTimeout(idleTimer); };
  // Each kind of progress counts ONCE (the key is its identity), so nothing a
  // peer can repeat — the same candidate twice, a re-offer, a state that
  // flip-flops — buys a second extension.
  const progressSeen = new Set<string>();
  let remoteCandidates = 0;
  function progress(key: string) {
    if (opened || progressSeen.has(key)) return;
    progressSeen.add(key);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, NO_PROGRESS_TIMEOUT_MS);
  }

  let abortListener: (() => void) | undefined;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
    for (const capture of captures.values()) {
      if (capture.channel.onmessage === capture.handler) capture.channel.onmessage = null;
    }
    captures.clear();
    off();
    try { pc.close(); } catch { /* already closed */ }
  }
  const ctx: CoreContext = { fail: (err) => failReady(err), close };

  async function handleSignal(msg: InboundSignal) {
    opts.beforeSdp?.(msg);
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      // The peer answered (or re-offered): the strongest evidence there is that
      // somebody is on the other end and this setup is worth more time.
      progress(`sdp:${msg.sdp.type}`);
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
        // Only a candidate the pc actually accepted, and only the first few.
        if (remoteCandidates < MAX_CANDIDATE_PROGRESS) progress(`ice:${remoteCandidates++}`);
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

  abortListener = () => {
    const err = new Error("relayium: connection aborted");
    err.name = "AbortError";
    if (!opened) failReady(err);
    close();
  };
  opts.signal?.addEventListener("abort", abortListener, { once: true });
  if (opts.signal?.aborted) abortListener();

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
    // A transport state we have not seen before means the ICE agent moved, which
    // only real checks with a real peer can cause.
    progress(`state:${state}`);
    opts.onStateChange?.(state);
    if (state === "disconnected") tryIceRestart();
    // A failure before the channel ever opened must unblock the caller; after it
    // opened, `ready` is already settled and this reject is a harmless no-op.
    if (state === "failed" && !opened) failReady(new Error(`relayium: ${what} failed`));
    // Once the connection reaches a terminal state, stop routing this peer's
    // signals so listeners don't pile up across repeated transfers.
    if (state === "closed" || state === "failed") off();
  };

  try {
    if (!opts.signal?.aborted) {
      if (role === "initiator") {
        const offer = await pc.createOffer();
        if (opts.signal?.aborted) throw Object.assign(new Error("relayium: connection aborted"), { name: "AbortError" });
        await pc.setLocalDescription(offer);
        send({ sdp: offer, ...opts.sdpExtra?.() });
      } else if (opts.initialSignal) {
        // The signal that got us here goes through the same check as every later
        // one — it is the resume OFFER, i.e. exactly the message L3 is about.
        recvChain = recvChain.then(() => accept(opts.initialSignal!));
        await recvChain;
      }
    }
    const openChannels = await ready;
    clearTimers();
    if (opts.signal?.aborted) {
      const err = new Error("relayium: connection aborted");
      err.name = "AbortError";
      throw err;
    }
    const primary = openChannels.get(channelLabels[0]);
    if (!primary) throw new Error("relayium: primary data channel missing");
    if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
    abortListener = undefined;
    return {
      channel: primary,
      getChannel: (label) => openChannels.get(label),
      takeCaptured: captureLimit > 0
        ? (label: string) => {
            const capture = captures.get(label);
            if (!capture) return { frames: [], overflow: captureOverflow };
            if (capture.channel.onmessage === capture.handler) capture.channel.onmessage = null;
            captures.delete(label);
            return { frames: [...capture.frames], overflow: captureOverflow };
          }
        : undefined,
      close,
      // Read live rather than captured at open: `pc.sctp` is null until the SCTP
      // transport exists, and the value is fixed for the connection's life once
      // it does. A resumed connection is a different pc and may negotiate a
      // different number.
      maxFrameBytes: () => negotiatedMaxMessageBytes(pc.sctp),
      path: (): Promise<ConnPath> => pc.getStats().then(classifyPath),
      stats: () => pc.getStats(),
    };
  } catch (err) {
    // Establishment failed or timed out: clean up the listener and peer
    // connection, then propagate so the caller shows a retryable failure
    // instead of a progress bar frozen at 0%.
    clearTimers();
    close();
    throw err;
  }
}
