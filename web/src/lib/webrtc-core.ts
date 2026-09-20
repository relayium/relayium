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
import { candidateAddressKey, candidateUfrag, sdpIceUfrag, sdpPin, statsAddressKey, type SdpPin } from "./relay-renew-wire";

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

/**
 * The per-epoch surface a relay renewal drives, and nothing else.
 *
 * ## Why this is an interface and not `pc`
 *
 * Renewal has to reach the PeerConnection: it applies a new configuration,
 * restarts ICE, exchanges a description it signs itself, and reads which local
 * candidate the agent actually selected. Handing out `pc` would give it all of
 * that plus everything else, including the ability to open a third DataChannel
 * or renegotiate outside the epoch machinery. This is the exact list, and every
 * member exists because §5 or §6 of `relay-renew-v1.md` names it.
 *
 * ## Why the candidate gate is here rather than in the controller
 *
 * `establish` already owns the invariant "a local description reaches signalling
 * before the candidates gathered for its ufrag" — the gate that
 * `sendLocalDescription`/`releaseLocalCandidates` implement, and which an ICE
 * restart has to re-establish. A renewal restart is exactly that case, so it
 * reuses the same gate rather than growing a second one that could disagree.
 * The DIFFERENCE is only where the bytes go: a renewal description is wrapped
 * and signed by the controller, so core hands it back instead of sending it.
 */
export interface RenewTransport {
  /**
   * The pin of the REMOTE description this transport was established on.
   *
   * Epoch 0's remote description, taken as applied. A `link:§8` rebuild
   * produces a new PeerConnection and therefore a new `Conn`, so the baseline
   * is re-taken naturally rather than being carried across a transport it does
   * not belong to.
   *
   * Null until a remote description has been applied at all — a responder that
   * has not yet been offered to, which is not a state renewal runs in.
   */
  baseline(): SdpPin | null;
  /** The `a=ice-ufrag` of the local description currently applied, or "". */
  localUfrag(): string;
  /** The `a=ice-ufrag` of the remote description currently applied, or "". */
  remoteUfrag(): string;
  /** Install fresh credentials. **Not** success by itself — see §6. */
  setConfiguration(config: RtcConfig): void;
  /** `createOffer({iceRestart:true})` + `setLocalDescription`, with the local
   *  candidate gate CLOSED first so this ufrag's candidates are held. */
  offer(): Promise<RTCSessionDescriptionInit>;
  /** `createAnswer` + `setLocalDescription`, same gating. */
  answer(): Promise<RTCSessionDescriptionInit>;
  /** `setRemoteDescription`, returning the pin of exactly what was applied so
   *  the caller compares the description the agent took, not the one it sent. */
  applyRemote(sdp: RTCSessionDescriptionInit): Promise<SdpPin>;
  /** Release held local candidates to `onCandidate` and reopen the gate. Called
   *  once the description they belong to is on the wire. */
  releaseCandidates(): void;
  addCandidate(init: RTCIceCandidateInit): Promise<void>;
  /** Local candidates for a renewal epoch. One subscriber; replacing it
   *  replaces the previous. Null detaches. */
  onCandidate(cb: ((candidate: RTCIceCandidate) => void) | null): void;
  /** Wake-up when the ICE agent changes its selected pair, where the browser
   *  exposes it. A no-op disposer where it does not; the caller polls
   *  `selectedGeneration` either way, because the EVENT is not the answer. */
  onSelectedPair(cb: (() => void) | null): void;
  /**
   * The ICE generation of the currently selected pair, both ends.
   *
   * `local` is the clause §6.3 rests on. Null is a real answer and the
   * conservative one: no pair yet, a `prflx` candidate this side never
   * gathered, an ambiguous transport address, or a report whose authoritative
   * selection could not be read. Observation must FAIL in each of those cases
   * rather than be assumed.
   *
   * `remote` is reported only where the stats actually carry it — no stack is
   * required to, and nothing is inferred when it does not. Where it IS present
   * it must match, because a selected pair whose far end still names the
   * previous generation is a path that has not migrated. It is an additional
   * refusal, never a substitute for the dual-endpoint proof: a remote ufrag is
   * a fact about the local ICE agent's bookkeeping, not evidence that the peer
   * observed anything.
   */
  selectedGeneration(): Promise<{ local: string | null; remote: string | null }>;
  /** Hold off the unauthenticated `tryIceRestart` while an epoch is in flight;
   *  two offers on one PeerConnection is glare neither side can resolve. */
  suspendUnsignedRestart(active: boolean): void;
  /**
   * Refuse unsigned `link`-generation SDP and ICE for the remainder of this
   * PeerConnection.
   *
   * Called once this link has verified ANY renewal signal from its peer. The
   * decision is monotonic and authenticated, and deliberately does not rest on
   * the unauthenticated `caps` hint.
   */
  lockUnsignedSdp(): void;
}

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
  /** The relay-renewal surface. Always present on a real transport; optional on
   *  the type so the test seams that stand in for `Conn` are unaffected, and so
   *  a caller has to state what it does without one. */
  renew?: RenewTransport;
}

/**
 * The candidate-pair stats row the ICE agent has ACTUALLY selected.
 *
 * ## Why the obvious scan is wrong, with real-browser evidence
 *
 * Scanning for the first row that is `selected`, or `nominated && succeeded`,
 * finds a pair that WAS live. After an ICE restart Chrome keeps the previous
 * generation's pair in the report, still flagged `nominated` and `succeeded`,
 * alongside the new one — a capture of exactly that is in this task's evidence
 * (`browser-selected-generation.json`: iteration order yields the old pair
 * `CP1TxJaz0f_f9/5gSKr` while the transport points at `CPzZwbUqMe_G1a13d3r`).
 * A renewal that read the old pair would conclude its migration had not
 * happened — or, worse, that it had, on the generation it was migrating away
 * from.
 *
 * The `transport` row's `selectedCandidatePairId` is the agent's own answer and
 * is authoritative. It is consulted first and never overridden.
 *
 * ## The fallback, and why it refuses rather than guesses
 *
 * Not every stack publishes a `transport` row, and the synthetic reports this
 * module's own tests are written against do not. So a scan remains, but it is
 * trusted only when UNAMBIGUOUS: exactly one qualifying pair. Two qualifying
 * pairs is precisely the post-restart shape above, and there the honest answer
 * is "cannot tell" — which makes observation fail and the link keep the
 * deadline it already had.
 */
export function selectedCandidatePair(stats: RTCStatsReport): Record<string, unknown> | null {
  let selectedId: string | undefined;
  stats.forEach((r) => {
    const s = r as unknown as { type?: string; selectedCandidatePairId?: unknown };
    if (s.type !== "transport") return;
    if (typeof s.selectedCandidatePairId === "string" && s.selectedCandidatePairId !== "") {
      selectedId = s.selectedCandidatePairId;
    }
  });
  if (selectedId !== undefined) {
    const pair = stats.get(selectedId) as unknown as Record<string, unknown> | undefined;
    // An id that names nothing is a malformed report, not a licence to scan:
    // the agent told us which pair it chose and we could not read it.
    return pair ?? null;
  }
  const qualifying: Record<string, unknown>[] = [];
  stats.forEach((r) => {
    const s = r as unknown as { type?: string; selected?: boolean; nominated?: boolean; state?: string };
    if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) {
      qualifying.push(r as unknown as Record<string, unknown>);
    }
  });
  return qualifying.length === 1 ? qualifying[0] : null;
}

/** Classify the in-use ICE path from a getStats() report: find the selected
 *  candidate pair, then read the candidate type on each end. A relay on either
 *  side means TURN; host↔host is a LAN direct hop; anything else (srflx/prflx,
 *  i.e. a NAT-traversed direct path) is P2P. Firefox flags the live pair with
 *  `selected`; Chromium leaves `nominated` + `succeeded` on it — accept either.
 *  Exported for unit testing against synthetic stats. */
export function classifyPath(stats: RTCStatsReport): ConnPath {
  // The authoritative read, for the reason `selectedCandidatePair` documents: a
  // stale nominated pair left behind by a restart would classify the path this
  // connection has migrated AWAY from. "unknown" when it cannot be told, which
  // every caller already treats as "no answer yet" rather than as a path.
  const pair = selectedCandidatePair(stats) as
    { localCandidateId?: string; remoteCandidateId?: string } | null;
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

/**
 * 一条建连里最多**暂存**多少条候选（两个方向各自计数）。
 *
 * 暂存是有界的，因为两边的窗口都不是自己关的：本端候选等的是本端 SDP 交给信令，
 * 远端候选等的是 `setRemoteDescription` 成功，而这两件事都可能永远不发生。真实
 * 的一次 ICE 交换只有个位数条候选，64 给畸形 SDP、ICE 重启重新采集和慢速蜂窝留了
 * 一个数量级的余量。
 *
 * **两个方向溢出后都 fail closed**，见 `holdRemoteCandidate` 和 `pc.onicecandidate`。
 * 一度想过本端溢出只丢弃并记日志（"自己的采集，不该为它拆连接"），但那是错的：本端
 * 队列只在等自己的 SDP 时增长，涨到 64 条说明这条连接遇上了它自己解释不了的情况
 * （描述始终装不上、采集失控、资源到顶）。静默截断把一次资源上限失败伪装成"连上了、
 * 只是候选少几条"，而少掉的那几条在跨网络上正是唯一能用的。拆掉并说明原因，是这两个
 * 队列共用的规则。
 */
const MAX_HELD_CANDIDATES = 64;

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

/** Structural check for a usable `SignalAuth`. Presence alone is not enough:
 *  `auth` whose `sign` is not callable would throw inside `send`'s chain, which
 *  logs and continues — a resume that quietly signs nothing and emits nothing,
 *  i.e. the same fail-open shape the required `auth` exists to prevent. */
function isSignalAuth(value: unknown): value is SignalAuth {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SignalAuth>;
  return typeof candidate.sign === "function" && typeof candidate.verify === "function";
}

/**
 * The construction contract, enforced at runtime.
 *
 * `CoreOpts` states all of this already — but a type binds TypeScript callers
 * and nobody else. A test reaching through `as never`, a future JavaScript
 * consumer, or options that arrived as `any` from a JSON boundary walk straight
 * past the union, and what they get is not a compile error but a peer
 * connection plus a tagged (and possibly signed) offer already on the wire for
 * a shape this build cannot honour. So the checks run FIRST, before
 * `new RTCPeerConnection` and before the first `sendSignal`: an illegal call
 * costs a rejected promise and nothing observable.
 *
 * Every rule here is a fail-closed restatement of a comment on the types above;
 * none of them narrows what a legal TypeScript caller may do.
 */
function assertConstructible(opts: CoreOpts): void {
  // Read each field through `unknown`. The parameter's type already asserts
  // these are correct, so a direct comparison would be narrowed away as an
  // impossible one — exactly the reasoning that leaves a JS caller unchecked.
  const generation = opts.generation as unknown;
  if (generation !== "link" && generation !== "resume") {
    // Deliberately NOT "unrecognised, treat it as link". `file` and `text` are
    // names this build still classifies INBOUND (see `Generation`) and can
    // never construct; anything else is a caller bug. Either way, silently
    // picking a generation is how the retired single-lane transfer stayed
    // reachable — an unbuildable tag has to be refused under its own name.
    throw new Error(`relayium: cannot establish generation ${JSON.stringify(generation)}`);
  }

  // The exact link tuple, in primary-first order. This subsumes the uniqueness
  // check it replaces: `["relayium", "relayium"]` fails it, and so do the empty
  // list, the one-element legacy lane, a reversed pair, and an extra lane —
  // each of which `readonly string[]` admitted at runtime, and the first of
  // which is precisely the single-lane connection that must stay unbuildable.
  const labels = opts.channelLabels as unknown;
  const wrongTuple = !Array.isArray(labels)
    || labels.length !== LINK_CHANNEL_LABELS.length
    || LINK_CHANNEL_LABELS.some((label, i) => labels[i] !== label);
  if (wrongTuple) {
    throw new Error(`relayium: channelLabels must be exactly [${LINK_CHANNEL_LABELS.join(", ")}]`);
  }

  const auth = opts.auth as unknown;
  if (generation === "link" && auth != null) {
    // A first connection has no shared secret yet — its own commit-reveal is
    // what derives one. Auth offered here came from somewhere else, and taking
    // it would mean signing the handshake with a key the handshake has not
    // agreed on.
    throw new Error("relayium: the link generation cannot carry auth");
  }
  if (generation === "resume" && !isSignalAuth(auth)) {
    // An unauthenticated resume is a second connection anybody on the
    // signalling path could offer into an already SAS-verified session.
    throw new Error("relayium: the resume generation requires auth");
  }
}

export async function establish(opts: CoreOpts): Promise<Conn> {
  // Before any side effect: no peer connection, no signalling subscription and
  // no outbound signal for a call the construction contract already refuses.
  assertConstructible(opts);
  const { signaling, peerId, role, generation } = opts;
  const what = opts.label ? `${opts.label} connection` : "connection";
  const pc = new RTCPeerConnection(opts.config ?? DEFAULT_ICE);
  // Validated above as the exact tuple; widened here only so the collection
  // logic below can compare arbitrary inbound labels against it.
  const channelLabels: readonly string[] = opts.channelLabels;

  /** 给外发信令盖上世代标记。只有两种世代能构造，所以这里没有"不盖标记"的分支——
   *  以前那条 `: msg` 兜底就是那条已经删掉的无标记旧世代，任何漏配的调用点都会掉
   *  进去。入站分类仍然认识 `file` 和 `text`，见 `signalGeneration`。 */
  const tag = <T extends object>(msg: T): T & { resume?: boolean; link?: boolean } =>
    generation === "resume" ? { ...msg, resume: true } : { ...msg, link: true };

  // 外发信令统一走这里：盖世代标记 → 签名 → 发。签名是异步的，所以用一条串行链
  // 保序——offer 之后紧跟的 ICE 候选如果因为签名耗时反超到 offer 前面，对端会把它
  // 当作"remoteDescription 之前到达的候选"丢掉。
  //
  // **关闭之后一条都不再发。** 取消（abort / 握手校验失败 / 上层 close）会在
  // `createOffer`、`setLocalDescription` 或者这条链里的签名还没落地时发生，而那些
  // await 随后照样会恢复执行并走到下面的 send。那是一条属于已经放弃的连接的信令，
  // 带着本世代的标记，对端无法把它和一次真实的建连尝试区分开。链内再查一次，因为
  // 签名本身就是一个可以跨越 close 的 await。
  let closed = false;
  /**
   * Everything `close()` and the candidate gates reach for, declared BEFORE the
   * first handler that can call them.
   *
   * A peer connection may dispatch `onicecandidate` synchronously from inside
   * `createDataChannel` or `setLocalDescription` — a native stack does, and so
   * does the probe that models one. Those dispatches happen while `establish`
   * is still running its own prologue, so a gate that fails closed from there
   * would read `releaseSignalListener`/`stopTimers`/`failReady` in their
   * temporal dead zone and throw a `ReferenceError` instead of tearing the
   * connection down. Optional bindings assigned later make "not built yet" a
   * state rather than a crash.
   */
  let opened = false;
  let failReady: ((err: Error) => void) | undefined;
  let releaseSignalListener: (() => void) | undefined;
  let stopTimers: (() => void) | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  function send(msg: Omit<InboundSignal, "resume" | "text" | "link" | "auth">) {
    if (closed) return;
    sendChain = sendChain
      .then(async () => {
        if (closed) return;
        const out: InboundSignal = tag(msg);
        if (opts.auth) out.auth = await opts.auth.sign(authPayload(out));
        if (closed) return;
        signaling.sendSignal(peerId, out);
      })
      .catch((err) => console.error(`relayium ${what} send error`, err));
  }

  /**
   * **本端候选排在本端 SDP 之后。**
   *
   * `send` 的串行链保证的是*调用*顺序，而调用顺序本身就是错的：SDP 是在
   * `await pc.setLocalDescription(...)` **之后**才交给 `send` 的，而候选是
   * `onicecandidate` 在那个 await 期间就交出来的。于是候选排在了 SDP 前面。对端
   * 收到一条 remoteDescription 还不存在时的候选，只能丢掉它——这正是下面
   * `holdRemoteCandidate` 在入站侧修的那个洞，只是发生在发送侧。
   *
   * ## 这是硬化，不是一次浏览器复现
   *
   * 在符合 webrtc-pc 的浏览器里，`setLocalDescription` 的 promise 在一个排队的
   * 任务里兑现，而 ICE 采集产生的候选事件排在它之后，所以真实浏览器先发 SDP。能
   * 复现出 `[ice, sdp]` 的探针是用一个**同步**在 `setLocalDescription` 里触发
   * `onicecandidate` 的假 pc 做的——那模拟的是原生栈（libwebrtc/Android），不是
   * 浏览器。诚实的说法是：这个模块以前没有任何顺序防御，而不是浏览器会踩它。
   *
   * 保留它的理由是这个模块不只跑在浏览器里（Electron 渲染进程共用它），而且这条
   * 不变式在 ICE 重启时要重新成立一次：重启的候选属于新的 ufrag，跑到重启 offer
   * 前面就是同一个洞。
   */
  const abortError = () => Object.assign(new Error("relayium: connection aborted"), { name: "AbortError" });

  let localSdpDue = true; // 本世代的本端 SDP 还没交给 send
  /** 是否已经有过一条本端描述真的上线。见 `sendLocalDescription` 的失败分支。 */
  let localSdpEverSent = false;
  const heldLocalCandidates: RTCIceCandidate[] = [];
  /** 远端在 `setRemoteDescription` 成功之前送来的候选。见 `holdRemoteCandidate`。 */
  let remoteDescribed = false;
  const heldRemoteCandidates: RTCIceCandidateInit[] = [];

  // ── renewal state (see RenewTransport) ────────────────────────────────────
  /** Pin of the FIRST remote description applied on this pc. */
  let renewBaseline: SdpPin | null = null;
  /** Where a local candidate goes. Once a renewal has restarted ICE, every
   *  later candidate belongs to a renewal ufrag and must travel signed inside a
   *  renew envelope — never as an unsigned top-level `link` ICE. Set once and
   *  never cleared: this pc has no route back to the unsigned generation. */
  let renewOwnsCandidates = false;
  let renewCandidateCb: ((candidate: RTCIceCandidate) => void) | null = null;
  let renewSelectedPairCb: (() => void) | null = null;
  /**
   * `address key -> ufrag`, for the stacks whose stats rows carry no ufrag.
   *
   * **Fails closed on ambiguity.** The key is protocol/address/port/type, which
   * is unique among one agent's simultaneously-live candidates but NOT across
   * ICE generations: a TCP-active candidate is published on port 9 by every
   * generation, so the same key legitimately names candidates from two ufrags.
   * When that happens the entry is poisoned rather than overwritten — reading
   * it answers "unknown", observation does not hold, the epoch times out, and
   * the old deadline is kept. Overwriting would let a candidate from the OLD
   * generation be read as the new one, which is the exact false positive §6.3
   * exists to prevent.
   *
   * Bounded, because it is fed by whatever the ICE agent gathers: past the cap
   * nothing more is recorded, which again only ever makes observation fail.
   */
  const localCandidateUfrags = new Map<string, string>();
  /** The sentinel a poisoned key holds. Not a legal ufrag (RFC 8839 requires at
   *  least 4 characters from a restricted alphabet, and this contains none). */
  const UFRAG_AMBIGUOUS = "";
  const MAX_CANDIDATE_UFRAG_KEYS = 128;
  /** An epoch is in flight: hold off the unauthenticated restart. */
  let renewInFlight = false;
  /** This link has verified a renewal signal, so unsigned SDP/ICE on the `link`
   *  generation is refused for the remainder of this pc. Monotonic. */
  let unsignedSdpLocked = false;

  /** One place decides where a local candidate goes, so the gate's release path
   *  and the live path can never disagree about it. */
  function emitLocalCandidate(ice: RTCIceCandidate) {
    if (renewOwnsCandidates) { renewCandidateCb?.(ice); return; }
    send({ ice });
  }

  pc.onicecandidate = (e) => {
    if (!e.candidate || closed) return;
    // Recorded BEFORE the gate, so a candidate that is held (or dropped on
    // overflow) still contributes its generation to the mapping §6.3 reads.
    const key = candidateAddressKey(e.candidate.candidate);
    const ufrag = candidateUfrag(e.candidate.candidate)
      || (typeof e.candidate.usernameFragment === "string" ? e.candidate.usernameFragment : "");
    if (key !== "" && ufrag !== "") {
      const known = localCandidateUfrags.get(key);
      if (known === undefined) {
        // Bounded. Past the cap nothing new is learned, which can only make a
        // later lookup answer "unknown".
        if (localCandidateUfrags.size < MAX_CANDIDATE_UFRAG_KEYS) {
          localCandidateUfrags.set(key, ufrag);
        }
      } else if (known !== ufrag) {
        // Two generations, one transport address. See the map's comment: this
        // key can no longer identify a generation and must stop trying.
        localCandidateUfrags.set(key, UFRAG_AMBIGUOUS);
      }
    }
    if (!localSdpDue) { emitLocalCandidate(e.candidate); return; }
    if (heldLocalCandidates.length >= MAX_HELD_CANDIDATES) {
      // Fail closed, exactly as the remote hold does. See MAX_HELD_CANDIDATES.
      failEstablishment(new Error(`relayium: ${what} gathered too many candidates before its description`));
      return;
    }
    heldLocalCandidates.push(e.candidate);
  };

  /** 放行暂存的本端候选，并重新打开闸门。SDP 已经先入队，所以这些候选排在它后面。 */
  function releaseLocalCandidates() {
    localSdpDue = false;
    const held = heldLocalCandidates.splice(0, heldLocalCandidates.length);
    if (closed) return; // 关掉之后闸门不再"打开"任何东西——一条都不出去
    for (const ice of held) emitLocalCandidate(ice);
  }

  /**
   * 造一条本端 SDP、装上它，并让它**先于**属于它的候选上线。
   *
   * 三条路径共用：初始 offer、应答 answer、ICE 重启 offer。重启那条是闸门必须能
   * **重新关上**的原因：重启期间采集的候选属于新的 ufrag。
   */
  async function sendLocalDescription(
    create: () => Promise<RTCSessionDescriptionInit>,
    extra?: () => Partial<InboundSignal> | undefined,
  ): Promise<void> {
    localSdpDue = true;
    let sdp: RTCSessionDescriptionInit;
    try {
      sdp = await create();
      if (opts.signal?.aborted) throw abortError();
      await pc.setLocalDescription(sdp);
    } catch (err) {
      // **这一批一定丢掉，绝不放行。**
      //
      // 失败点可能在采集之后：`setLocalDescription` 完全可以先装上新描述、开始为
      // 新 ufrag 采集，再拒绝掉。所以"它们属于上一条仍然有效的描述"是猜的，不是
      // 证明。把一条属于从未上过线的 ufrag 的候选发给对端，对端只能拒绝它，而本
      // 端还以为自己已经把路径告诉过对方了。
      //
      // 闸门怎么处理则可以分辨：之前真的发出过一条描述（ICE 重启失败就是这种），
      // 那条描述仍然是对端手里的那条，此后采集到的候选属于它，必须继续放行；从来
      // 没有过（初始 offer / 应答就失败），这条连接接下来只会走到 establish 的
      // 失败清理，闸门保持关闭。
      heldLocalCandidates.length = 0;
      if (localSdpEverSent) localSdpDue = false;
      throw err;
    }
    send({ sdp, ...extra?.() });
    localSdpEverSent = true;
    releaseLocalCandidates();
  }

  const channels = new Map<string, RTCDataChannel>();
  const captures = new Map<string, {
    channel: RTCDataChannel;
    frames: ArrayBuffer[];
    handler: (event: MessageEvent) => void;
  }>();
  const captureLimit = opts.captureBeforeReadyBytes ?? 0;
  let capturedBytes = 0;
  let captureOverflow = false;
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

  const expire = () => { if (!opened) failReady?.(new Error(`relayium: ${what} timed out`)); };
  const hardTimer = setTimeout(expire, SETUP_HARD_CAP_MS); // never re-armed
  let idleTimer = setTimeout(expire, NO_PROGRESS_TIMEOUT_MS);
  stopTimers = () => { clearTimeout(hardTimer); clearTimeout(idleTimer); };
  // Each kind of progress counts ONCE (the key is its identity), so nothing a
  // peer can repeat — the same candidate twice, a re-offer, a state that
  // flip-flops — buys a second extension.
  const progressSeen = new Set<string>();
  let remoteCandidates = 0;
  function progress(key: string) {
    // `closed` first: re-arming the no-progress timer for a torn-down
    // connection keeps a timer alive for up to another 30 s with nothing left
    // to bound.
    if (closed || opened || progressSeen.has(key)) return;
    progressSeen.add(key);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, NO_PROGRESS_TIMEOUT_MS);
  }

  let abortListener: (() => void) | undefined;
  function close() {
    if (closed) return;
    closed = true;
    if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
    for (const capture of captures.values()) {
      if (capture.channel.onmessage === capture.handler) capture.channel.onmessage = null;
    }
    captures.clear();
    // 两侧的暂存都属于这条已经结束的连接：本端的没人会发了，远端的没有 pc 可以
    // 收了。留着只是让一次已经放弃的建连继续持有对端的候选。
    heldLocalCandidates.length = 0;
    heldRemoteCandidates.length = 0;
    // A renewal controller holds callbacks into a connection that is gone. Its
    // own epoch deadline would end it anyway; dropping them here means no
    // candidate and no selected-pair wake-up can reach a controller that is
    // about to be told the link is over.
    renewCandidateCb = null;
    renewSelectedPairCb = null;
    localCandidateUfrags.clear();
    // Settle `ready` before the timers go, and the order is load bearing:
    // `stopTimers` removes the only thing that would ever have settled it
    // otherwise, so a caller that closed a still-pending establishment without
    // failing it (a hook calling `ctx.close()` alone) would await forever.
    // A no-op once `ready` has already resolved or rejected, so the specific
    // error a real failure passed to `failReady` still wins.
    failReady?.(new Error(`relayium: ${what} closed`));
    // Both may still be unbuilt — see the hoisted bindings above — and the
    // setup timers must not outlive the connection they were bounding.
    stopTimers?.();
    releaseSignalListener?.();
    try { pc.close(); } catch { /* already closed */ }
  }

  /**
   * End this establishment because an invariant it cannot recover from broke.
   *
   * `failReady` alone is not a notification. It settles the `ready` promise,
   * which nothing is awaiting once the channels have opened — so on an
   * ESTABLISHED link (an ICE restart is the reachable case) a bare `failReady`
   * would close the peer connection while the owner still believed it held a
   * live transport. `onStateChange` is the seam that owner already listens on
   * for a terminal transport, and a connection we are about to close is
   * terminal by exactly that definition.
   */
  function failEstablishment(err: Error) {
    if (closed) return;
    failReady?.(err);
    if (opened) opts.onStateChange?.("failed");
    close();
  }
  const ctx: CoreContext = { fail: (err) => failReady?.(err), close };

  /**
   * **远端候选必须等到 remoteDescription 立起来。**
   *
   * 这一条是这个批次里真正可达的那个缺陷。`addIceCandidate` 按 W3C 要求
   * remoteDescription 已存在，而在这里它以前是「试一下，失败就静默吞掉」：注释
   * 说「局域网上 SDP 里的 host 候选通常够用」，可跨网络那句话不成立——那条被吞掉
   * 的正是 relay 候选。
   *
   * 触发它不需要任何人违反规范：本端作为 initiator 发出 offer 之后、对端的
   * answer 回来之前，本端根本没有 remoteDescription；而对端只要在自己的 answer
   * 上线之前就开始 trickle 候选（Android 的 `onIceCandidate` 就是无条件立刻发，
   * 见同一轮评审的 C 批次），这些候选就全部落进那个空 catch。丢掉的候选越多，越
   * 依赖 relay 的那一侧越连不上。
   *
   * 暂存有界且 fail closed：溢出时拆连接，而不是截断。用前缀候选建起来的连接不是
   * 对端正在建的那条，而静默截断和"一条健康但永远连不完的连接"在界面上无法区分。
   * `peer-link` 对它暂存的 offer 后续帧用的是同一条规则。
   */
  function holdRemoteCandidate(ice: RTCIceCandidateInit) {
    if (closed) return;
    if (heldRemoteCandidates.length >= MAX_HELD_CANDIDATES) {
      failEstablishment(new Error(`relayium: ${what} held too many early candidates`));
      return;
    }
    heldRemoteCandidates.push(ice);
  }

  /** 按到达顺序放行，且只放行一次：先取空再逐条加，所以重入不会重放。 */
  async function flushRemoteCandidates() {
    if (heldRemoteCandidates.length === 0) return;
    const held = heldRemoteCandidates.splice(0, heldRemoteCandidates.length);
    for (const ice of held) await addRemoteCandidate(ice);
  }

  async function addRemoteCandidate(ice: RTCIceCandidateInit) {
    if (closed) return;
    try {
      await pc.addIceCandidate(ice);
      // Only a candidate the pc actually accepted, and only the first few.
      if (remoteCandidates < MAX_CANDIDATE_PROGRESS) progress(`ice:${remoteCandidates++}`);
    } catch {
      // 被 ICE agent 拒绝的一条——畸形的，或者属于它已经走过的那个世代。非致命，
      // 而且**不能带走它的兄弟**：放行循环照常把剩下的加完。
    }
  }

  /**
   * **Nothing runs on a connection that is already gone.**
   *
   * Every `await` here is a point at which the caller can cancel, the hooks can
   * fail the handshake, or the peer connection can go terminal — and the
   * awaits resume regardless. Before the guards below, a `close()` that landed
   * while `setRemoteDescription` was still pending still went on to re-arm the
   * progress timer, call `onAnswer` (which reveals this side's key on the
   * signalling channel) and call `afterSdp` (which verifies a reveal against a
   * connection that no longer exists). Reproduced on the real module by
   * `probe-core-late-close.mjs`: `postCloseOnAnswer: 1, postCloseAfterSdp: 1`.
   *
   * The guards are checks rather than an abort of the chain because the
   * receive chain is shared: a signal abandoned here must still leave the chain
   * usable, and after `close()` the listener is unsubscribed anyway.
   */
  async function handleSignal(msg: InboundSignal) {
    if (closed) return;
    opts.beforeSdp?.(msg);
    if (msg.sdp) {
      await pc.setRemoteDescription(msg.sdp);
      if (closed) return; // cancelled while the description was being applied
      remoteDescribed = true;
      // The renewal baseline is the FIRST remote description this pc applied,
      // taken from what the agent holds rather than from the message, and never
      // moved afterwards: a later description is the thing being checked, so
      // re-pinning from it would make the check compare a value to itself.
      renewBaseline ??= sdpPin(pc.currentRemoteDescription?.sdp ?? msg.sdp.sdp ?? "");
      // The peer answered (or re-offered): the strongest evidence there is that
      // somebody is on the other end and this setup is worth more time.
      progress(`sdp:${msg.sdp.type}`);
      try {
        if (msg.sdp.type === "offer") {
          await sendLocalDescription(() => pc.createAnswer(), opts.sdpExtra);
        } else if (msg.sdp.type === "answer") {
          opts.onAnswer?.();
        }
      } finally {
        // 放行排在这里而不是紧接 setRemoteDescription 之后：作为应答方，此刻两条
        // 描述都已经装好，这是 `addIceCandidate` 最保守的时机。入站信令是串行的，
        // 所以这中间不会有别的信令插进来。
        //
        // `finally` 而不是顺序执行：remoteDescription 已经立起来了，暂存窗口就已经
        // 关闭，之后的候选都直接走。应答失败时若跳过这次放行，暂存的那几条就永远
        // 没有第二次机会了。
        await flushRemoteCandidates();
      }
    }
    if (closed) return;
    opts.afterSdp?.(msg, ctx);
    if (msg.ice) {
      if (!remoteDescribed) { holdRemoteCandidate(msg.ice); return; }
      await addRemoteCandidate(msg.ice);
    }
  }

  /** Verify (when authenticated) and then handle. A signal that fails the check
   *  is DROPPED, not fatal: the genuine peer's next signal still gets through,
   *  and if nothing genuine ever arrives the connect timeout ends it anyway. */
  async function accept(msg: InboundSignal) {
    if (closed) return;
    // **After the first verified renewal, this generation carries no more SDP.**
    //
    // A renewal proves the peer holds `resumeAuth`, so from that point on there
    // is an authenticated channel for every description this transport will
    // ever need — and an unsigned one can only have come from somebody who is
    // not that peer. Dropped rather than fatal, for the same reason a failed
    // tag is: the genuine peer's signed messages still get through, and a relay
    // learns nothing from the silence. Commit/reveal and caps are untouched;
    // by this point the handshake they belong to is long finished.
    if (unsignedSdpLocked && (msg.sdp || msg.ice)) {
      console.warn(`relayium ${what}: dropped unsigned SDP after renewal`);
      return;
    }
    if (opts.auth && !(await opts.auth.verify(authPayload(msg), msg.auth))) {
      console.warn(`relayium ${what}: dropped an unauthenticated signal`);
      return;
    }
    // Verification is asynchronous, so cancellation can land inside it.
    if (closed) return;
    await handleSignal(msg);
  }

  // 入站也串行：accept 里多了一次异步校验，两条信令并发跑 setRemoteDescription
  // 会互相踩。
  let recvChain: Promise<void> = Promise.resolve();
  releaseSignalListener = signaling.onSignal((from, data) => {
    const msg = data as InboundSignal;
    if (from !== peerId || signalGeneration(msg) !== generation) return; // 别的世代的信令不是我们的
    // The peer is mid-transfer and won't answer — stop waiting for a channel that
    // will never open and report it as "peer busy". A no-op once opened.
    if (msg.busy) { if (!opened) failReady?.(new PeerBusyError()); return; }
    recvChain = recvChain
      .then(() => accept(msg))
      .catch((err) => console.error(`relayium ${what} signal error`, err));
  });
  // A gate that failed closed during the prologue ran `close()` before this
  // line existed, so its `releaseSignalListener?.()` was a no-op. Undo the
  // subscription here rather than leaving the peer routed into a dead pc.
  if (closed) { releaseSignalListener(); releaseSignalListener = undefined; }

  abortListener = () => {
    const err = new Error("relayium: connection aborted");
    err.name = "AbortError";
    if (!opened) failReady?.(err);
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
    // A renewal epoch owns the negotiation while it runs, and once this link
    // has locked unsigned SDP there is no unsigned restart left to make: the
    // offer would be one the peer now refuses, and the candidates it gathered
    // would belong to a ufrag the peer was never told about. Deliberately NOT
    // setting `restarted` — a renewal that aborts leaves the ordinary one-shot
    // restart available for a genuine later `disconnected`, which is the case
    // this recovery exists for.
    if (renewInFlight || unsignedSdpLocked) return;
    restarted = true;
    try {
      // 重新关上本端候选闸门：重启采集出来的候选属于新的 ufrag，抢在重启 offer
      // 前面到达对端就和初始那条一样会被丢掉。
      await sendLocalDescription(() => pc.createOffer({ iceRestart: true }));
      // 重启 offer 已经交给信令，于是**入站**那一侧也回到"还没有远端描述"的状态。
      // 对端的重启 answer 会带来新的 ufrag，而它在那条 answer 之前 trickle 的候选
      // 属于新 ufrag：这时直接 addIceCandidate，ICE agent 只会按 usernameFragment
      // 对不上拒掉，和初始 offer 之前那个洞一模一样。暂存到重启 answer 落地为止。
      //
      // 只在 offer 真的发出去之后才重开：`sendLocalDescription` 失败时没有任何新
      // ufrag 被告知过对端，远端描述也还是原来那条，入站不该改变。
      remoteDescribed = false;
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
    if (state === "failed" && !opened) failReady?.(new Error(`relayium: ${what} failed`));
    // Once the connection reaches a terminal state, stop routing this peer's
    // signals so listeners don't pile up across repeated transfers.
    if (state === "closed" || state === "failed") releaseSignalListener?.();
  };

  try {
    if (!opts.signal?.aborted) {
      if (role === "initiator") {
        await sendLocalDescription(() => pc.createOffer(), opts.sdpExtra);
      } else if (opts.initialSignal) {
        // The signal that got us here goes through the same check as every later
        // one — it is the resume OFFER, i.e. exactly the message L3 is about.
        recvChain = recvChain.then(() => accept(opts.initialSignal!));
        await recvChain;
      }
    }
    const openChannels = await ready;
    stopTimers?.();
    if (opts.signal?.aborted) {
      const err = new Error("relayium: connection aborted");
      err.name = "AbortError";
      throw err;
    }
    const primary = openChannels.get(channelLabels[0]);
    if (!primary) throw new Error("relayium: primary data channel missing");

    /**
     * Create a local description for a renewal epoch, with the candidate gate
     * closed around it.
     *
     * The same three steps `sendLocalDescription` takes, and the same failure
     * rule: a batch gathered against a description that never landed is dropped
     * outright rather than guessed at. What differs is the last step — the
     * bytes are RETURNED, for the controller to wrap and sign, instead of being
     * handed to the unsigned `send`.
     */
    async function renewLocalDescription(
      create: () => Promise<RTCSessionDescriptionInit>,
    ): Promise<RTCSessionDescriptionInit> {
      renewOwnsCandidates = true;
      localSdpDue = true;
      try {
        const sdp = await create();
        if (closed) throw new Error(`relayium: ${what} closed`);
        await pc.setLocalDescription(sdp);
        if (closed) throw new Error(`relayium: ${what} closed`);
        localSdpEverSent = true;
        return pc.localDescription ?? sdp;
      } catch (err) {
        // These belong to a ufrag the peer was never told about.
        heldLocalCandidates.length = 0;
        // The gate stays CLOSED on failure. Unlike the establishment path there
        // is no "the previous description is still the live one" case worth
        // reopening for: the controller aborts this epoch, and anything
        // gathered afterwards belongs to a restart that did not happen.
        throw err;
      }
    }

    const renew: RenewTransport = {
      baseline: () => renewBaseline,
      localUfrag: () => sdpIceUfrag(pc.localDescription?.sdp ?? ""),
      // **`remoteDescription`, never `currentRemoteDescription`.**
      //
      // A responder that has applied a renewal OFFER holds it as the PENDING
      // remote description; `currentRemoteDescription` still returns the
      // previous generation's until an answer completes the exchange. Reading
      // the stale one there bound the responder's candidates to the OLD ufrag:
      // every fresh candidate was dropped as foreign and the migration could
      // not complete. Captured against real Chrome in this task's evidence
      // (`browser-pending-remote.json`: current `24IM` while the newly applied
      // remote/pending offer carries `IV8f`). `remoteDescription` is defined as
      // pending ?? current — exactly "what the agent is working with now".
      remoteUfrag: () => sdpIceUfrag(pc.remoteDescription?.sdp ?? ""),
      setConfiguration(config) {
        // Installs credentials and nothing more. The migration is what §6
        // proves; this call is not evidence of anything.
        pc.setConfiguration(config as RTCConfiguration);
      },
      offer: () => renewLocalDescription(() => pc.createOffer({ iceRestart: true })),
      answer: () => renewLocalDescription(() => pc.createAnswer()),
      async applyRemote(sdp) {
        await pc.setRemoteDescription(sdp);
        if (closed) throw new Error(`relayium: ${what} closed`);
        remoteDescribed = true;
        // The pin of what the AGENT holds — `remoteDescription`, for the reason
        // `remoteUfrag` gives above. Returning the pin of
        // `currentRemoteDescription` after applying an offer would hand the
        // caller the PREVIOUS generation's pin, which compares equal to the
        // baseline and so passes a check that never ran on the new description
        // at all. A validation that always succeeds is worse than none.
        return sdpPin(pc.remoteDescription?.sdp ?? sdp.sdp ?? "");
      },
      releaseCandidates: releaseLocalCandidates,
      addCandidate: (init) => addRemoteCandidate(init),
      onCandidate(cb) { renewCandidateCb = cb; },
      onSelectedPair(cb) {
        renewSelectedPairCb = cb;
        // Best effort, and explicitly only a WAKE-UP. Firefox does not expose
        // `RTCIceTransport` here at all, and even where the event fires it
        // carries no ufrag — the answer always comes from `selectedGeneration`.
        // A browser without it costs the controller's poll, nothing else.
        const transport = (pc.sctp?.transport as { iceTransport?: RTCIceTransport } | undefined)?.iceTransport;
        if (!transport) return;
        try {
          transport.onselectedcandidatepairchange = cb ? () => renewSelectedPairCb?.() : null;
        } catch { /* not supported on this stack */ }
      },
      async selectedGeneration() {
        const none = { local: null, remote: null };
        let stats: RTCStatsReport;
        try {
          stats = await pc.getStats();
        } catch {
          return none;
        }
        const pair = selectedCandidatePair(stats) as
          { localCandidateId?: string; remoteCandidateId?: string } | null;
        if (!pair?.localCandidateId) return none;
        const local = stats.get(pair.localCandidateId) as unknown as {
          usernameFragment?: unknown; protocol?: unknown; address?: unknown;
          ip?: unknown; port?: unknown; candidateType?: unknown;
        } | undefined;
        if (!local) return none;
        // The remote end's generation, where the report states it. Nothing is
        // inferred when it does not — there is no local mapping to fall back
        // on, because this side never gathered the peer's candidates.
        const remoteRow = pair.remoteCandidateId
          ? stats.get(pair.remoteCandidateId) as unknown as { usernameFragment?: unknown } | undefined
          : undefined;
        const remote = typeof remoteRow?.usernameFragment === "string" && remoteRow.usernameFragment !== ""
          ? remoteRow.usernameFragment
          : null;

        if (typeof local.usernameFragment === "string" && local.usernameFragment !== "") {
          return { local: local.usernameFragment, remote };
        }
        // No ufrag in the report: fall back to the mapping recorded from the
        // candidates this side gathered. A `prflx` candidate is never in it —
        // this side did not gather it — so observation correctly fails.
        const key = statsAddressKey(
          local.protocol, local.address ?? local.ip, local.port, local.candidateType,
        );
        if (key === "") return { local: null, remote };
        const mapped = localCandidateUfrags.get(key);
        // `UFRAG_AMBIGUOUS` and "never recorded" are the same answer here: this
        // transport address cannot name a generation.
        return {
          local: mapped === undefined || mapped === UFRAG_AMBIGUOUS ? null : mapped,
          remote,
        };
      },
      suspendUnsignedRestart(active) { renewInFlight = active; },
      lockUnsignedSdp() { unsignedSdpLocked = true; },
    };
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
      renew,
    };
  } catch (err) {
    // Establishment failed or timed out: clean up the listener and peer
    // connection, then propagate so the caller shows a retryable failure
    // instead of a progress bar frozen at 0%.
    stopTimers?.();
    close();
    throw err;
  }
}
