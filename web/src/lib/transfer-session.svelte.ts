// 一次配对之内的收发管道：接收侧（beginReceive）与发送侧（sendFiles），以及它们
// 共有的那一小撮传输状态（send / recv / incoming / SAS / 每向的 ICE 路径）。
//
// 从 App.svelte 里搬出来的。它们原本是 1809 行组件里最大的两块（合计约 520 行），
// 和路由、模板、拖拽、调试面板挤在同一个作用域里，谁都能改到谁的变量；而它们其实
// 自成一体：除了"发信令""挑 ICE 配置""闪一条提示"这几件事，不需要组件的任何东西。
// 依赖用参数显式注入（下面的 SessionDeps），于是这段逻辑第一次变得**可以单独读**，
// 也第一次不用挂一个浏览器就能实例化。
//
// 状态用 getter 暴露而不是直接导出变量：Svelte 5 的 $state 靠属性访问建立依赖，
// 导出一个 let 只会把当时的快照值发出去，组件永远不会重渲染。
import { generateKeyPair, deriveSession, sas, signResume, verifyResume, type SessionKeys } from "./crypto";
import type { SignalingClient } from "./signaling";
import { connect, connectResume, PeerBusyError, signalGeneration, type InboundSignal, type Conn, type ConnPath, type RtcConfig, type SignalAuth } from "./webrtc";
import {
  Sender,
  Receiver,
  ACCEPT,
  REJECT,
  COMPLETE,
  controlKind,
  resumeReqFrame,
  parseResumeReq,
  resumePointInRange,
  resumePointAligned,
  ackFrame,
  advanceAck,
  parseAck,
  isChunkFrame,
  FLOW_WINDOW,
  FLOW_ACK_INTERVAL,
  FRAME,
  CHUNK_OVERHEAD,
  MAX_FILES,
  type FileMeta,
  type ResumePoint,
} from "./transfer";
import { lastForegroundAt, stalled } from "./foreground";
import { pickSaveTarget, saveFailureStatus, SaveCancelledError, type SaveTarget, type FileSink } from "./filesink";
import { requestNotifyPermission } from "./notify";
import type { PickedFile } from "./drag";
import type { Messages, StatusKey } from "./i18n.svelte";

export interface Incoming {
  from: string;
  files: FileMeta[];
  total: number;
  /**
   * 上一次「接收」被用户在保存位置选择器里取消了，这张卡片是**重新问一次**。
   *
   * 只有桌面会出现（手机不开选择器）。置位的前提是这次取消**没有**在线路上留下
   * 任何东西：发送端仍停在 waitingAccept，重新点「接收」就是一次全新的用户手势、
   * 一次全新的选择器。界面据此换一句话，否则用户点了取消之后只会看到卡片原地
   * 不动，不知道自己还能不能再来一次。
   */
  retry?: boolean;
}

export interface Xfer {
  peer: string;
  dir: "send" | "recv";
  files: FileMeta[];
  index: number; // current file (0-based)
  sent: number; // plaintext bytes done across the batch
  total: number; // plaintext bytes total
  status: StatusKey; // translated at render time so it follows the language switch
  done: boolean;
  ok: boolean;
  speed: number; // bytes/sec
}

/** 组件必须提供的东西 —— 也正好是这两条管道对外界的全部依赖。 */
export interface SessionDeps {
  /** 当前信令连接。取函数而不是取值：换房间会换掉整个 socket。 */
  signaling: () => SignalingClient;
  /** 新连接用的 RTCConfiguration（中继选优的结果在这里体现）。 */
  rtcConfig: () => RtcConfig;
  /** 当前语言的文案表。 */
  t: () => Messages;
  /** 一条转瞬即逝的提示（"对方忙""文件太多"）。 */
  flash: (msg: string) => void;
  /** 消息会话是否正在进行。可选，不传就是"没有"——所以现有调用方和测试一行都不用改。
   *  见 busy()。 */
  textActive?: () => boolean;
  /** 这间房自己的 `/api/ice` 答复。可选，不传就是"早就到了"。见 RoomIceGate。 */
  roomIce?: RoomIceGate;
}

/**
 * This room's own `/api/ice` answer, as a lane that must not build without it
 * sees it.
 *
 * The room is joined a round trip BEFORE its configuration arrives, and inside
 * that window `rtcConfig()` is the default RTC configuration: no ICE servers,
 * no relay pool, no TURN credential. A transport built from it is committed to
 * it for the life of the connection, so no lane may build one until the answer
 * is installed — and "may not build yet" is not the same fact as "busy".
 *
 * Passed in rather than read from the component, because the window belongs to
 * whoever owns the socket and the fetch, and because a lane has to be testable
 * without either. Both legacy lanes take the same gate — see text-link.ts.
 */
export interface RoomIceGate {
  /** Is this room still waiting for its own answer? */
  pending: () => boolean;
  /**
   * Park until the answer is installed.
   *
   * Resolves `true` when this room's configuration is in place, and `false`
   * when the wait was superseded: the room the parked work was for is gone, and
   * building for it now would put one rendezvous's credentials on another's
   * socket. There is deliberately no timeout behind it — the fetch it waits on
   * always answers, an unreachable `/api/ice` included.
   */
  whenReady: () => Promise<boolean>;
  /**
   * Take this room's single legacy setup slot for `lane`, atomically.
   *
   * `true` if it is now held, `false` if the other lane already has it — and
   * the loser answers `busy` without building. Synchronous ON PURPOSE: the two
   * woken continuations run in the same turn, so the only thing that can
   * arbitrate between them is a check and a take with no await in between.
   */
  claimLane: (lane: LegacyLane) => boolean;
  /** Hand the slot back. Only the holder can, and a second call is a no-op. */
  releaseLane: (lane: LegacyLane) => void;
  /** Is the OTHER lane mid-setup right now? Its own session state cannot say so
   *  yet, which is the entire reason this exists. */
  laneClaimedByOther: (lane: LegacyLane) => boolean;
}

/**
 * The two legacy lanes, as the thing that has to keep them apart sees them.
 *
 * Two, and deliberately not open-ended: phase 1 keeps a file transfer and a
 * message session mutually exclusive because each runs its own commit-reveal
 * with its own SAS, and two different six-digit codes on screen at once teaches
 * the user that the number is decoration. Phase 2 merges both onto one link and
 * this goes with it.
 */
export type LegacyLane = "file" | "text";

/**
 * The room's one legacy setup slot.
 *
 * The mutex the two lanes already share is expressed in SESSION STATE — the
 * file lane's `recv`/`incoming`, the message lane's session status — and each
 * lane asks the other for it (`textActive`, `canAccept`) at the moment it is
 * about to build. That question is only honest when the answer is already
 * published, and the message lane's is not: `link()` runs a whole async
 * commit-reveal before `onOffer` hands the connection to the session, so for
 * the length of a handshake the lane is committed and reads idle.
 *
 * That gap was always there and used to be one instantaneous precheck wide.
 * Parking widened it to an entire HTTP round trip AND made it reachable by
 * construction: one parked file offer and one parked text offer wake in the
 * SAME turn, so whichever continuation runs second re-asks a mutex that the
 * first has not published into yet, sees `false`, and builds a second
 * `RTCPeerConnection` — two transports, two SAS codes, one room.
 *
 * So the slot is claimed BEFORE either woken lane constructs anything, and
 * released once the winner's own state owns the peer. Room-scoped like
 * everything else in this window: the room boundary clears it outright, because
 * a slot held on behalf of a peer in the room being left would answer the next
 * room's first offer `busy`.
 */
export function createLaneClaim() {
  let holder: LegacyLane | null = null;
  return {
    claim(lane: LegacyLane): boolean {
      // Strictly one at a time, its own lane included. A lane parks at most one
      // offer, so it cannot legitimately be here twice — and if it ever were,
      // one release would free a slot two builds are standing on.
      if (holder !== null) return false;
      holder = lane;
      return true;
    },
    /** Idempotent, and scoped: a lane that lost the race cannot release the
     *  winner's claim by running its own cleanup. */
    release(lane: LegacyLane) { if (holder === lane) holder = null; },
    heldByOther: (lane: LegacyLane) => holder !== null && holder !== lane,
    /** The room boundary. Whatever was mid-setup belonged to the room being
     *  left, and every lane has already been told to retire its work. */
    clear() { holder = null; },
  };
}

/** A lane that holds work on a named peer's behalf, as the roster sees it. */
export interface LegacyLanePeers {
  peerGone: (peerId: string) => void;
}

/**
 * Roster membership, diffed into lane departures.
 *
 * The hub sends an explicit `left` for a physical disconnect and this page acts
 * on it — but `left` is not the only way a peer goes away, and during the ICE
 * window it is not even the likeliest. A roster frame that REPLACES a peer, or
 * simply stops naming one, is the only evidence of that departure this page is
 * guaranteed to get: its own socket can drop and the roster it is handed on
 * reconnect is then the first and last word on who left while it was away.
 *
 * Without this diff a parked offer survives its own peer and BUILDS when the
 * answer lands — a transport, a TURN allocation and a receive card for an id
 * the hub no longer routes, holding the room's single lane against the peer
 * that replaced it.
 *
 * `relaySelection.noteRoster` runs the same diff and cannot be reused: it is
 * scoped to a room that already has a relay pool, so during the window — which
 * is exactly when offers are parked — it reports nothing at all.
 */
export function createRosterDepartures(lanes: LegacyLanePeers[]) {
  let known = new Set<string>();
  return {
    /**
     * Take a roster frame. Every peer it no longer names is retired through
     * every lane BEFORE the frame is recorded, so a frame that swaps one peer
     * for another cannot leave the newcomer standing behind the departed peer's
     * parked offer. Returns the departed ids for the caller to log or extend.
     */
    note(ids: string[]): string[] {
      const present = new Set(ids);
      const gone: string[] = [];
      for (const id of known) if (!present.has(id)) gone.push(id);
      // Retired first, recorded second: reversing these two lines makes every
      // departure invisible, because the diff would be against the frame that
      // reports it.
      for (const id of gone) for (const lane of lanes) lane.peerGone(id);
      known = present;
      return gone;
    },
    /** A new room's ids mean nothing to the old room's membership. */
    reset() { known = new Set(); },
  };
}

// 掉线之后每一侧还愿意等多久重连并续传，超时就判这次传输失败。
const RESUME_WINDOW_MS = 90_000;
/** How long a consented receive may go quiet before it is declared dead. Counted
 *  from the later of the last byte and the last time this page was in the
 *  foreground — see foreground.ts for why the second term is load-bearing on a
 *  phone. */
const RECEIVE_STALL_MS = 45_000;

// 传输循环最快多久往 $state 里写一次进度。
// 千兆局域网上循环每秒转 500+ 次，而每次写 send/recv 都会让它的所有读者失效：
// 进度卡片、format*/eta、标题 effect —— 全部只为把进度条挪动三分之一个像素，
// 而此刻 AES-GCM 正在抢同一个主线程（手机上尤其惨）。所以循环把计数留在普通局部
// 变量里、按 ~7Hz 发布；字节数本身一个都不会少。每个终态/边界都会立刻发布，
// 所以卡片绝不会停在一个过期的数字上。
const UI_TICK_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 这一块写下去会不会超出 manifest 为该文件声明的大小。
 *
 * 单独提出来是为了能被测到：调用点在接收管道的闭包深处，那里没法直接构造。
 * `declared` 为 undefined 表示这个下标在 manifest 里根本不存在（发送端多发了一个
 * 文件），按 0 处理——任何字节都算越界。
 */
export function wouldExceedDeclared(declared: number | undefined, offset: number, chunkLen: number): boolean {
  return offset + chunkLen > (declared ?? 0);
}

/**
 * 一条入站 offer 该走哪条路。
 *
 * 抽成纯函数是为了能把 pausedRecv 那条路穷举掉：真把接收端驱动到"已暂停"状态，得跑完
 * offer→握手→manifest→接受→落盘→掉线，那样的手架测的是手架自己。同一个文件里的
 * wouldExceedDeclared 也是同样理由导出的。
 *
 * **只有 resume 世代能走续传那条路。** 旧代码的快速通道排在世代判定之前、只比对端身份，
 * 于是同一个对端的一条 text offer（粘贴一下就有）会被喂进 pausedRecv.resume()——而
 * resume() 第一件事就是把 pausedRecv 置空、清掉续传窗口定时器，把这次续传"认领"掉。
 * 那条 offer 没有 resume-auth 签名，会被 establish 的 accept() 丢弃，续传连接等到超时
 * 失败；真正的 resume offer 随后到达时已无处可挂。一次粘贴永久杀掉一次本可续上的传输。
 *
 * 一条**全新的**文件 offer 同样不该劫持续传：它拿到的是 busy 回包（暂停中的接收本身
 * 就让 busy() 为真），这也是它一直该拿到的东西。
 *
 * **`busy` and `park` are different answers to different questions.** `busy`
 * means "somebody else has this lane", and every sender that speaks this
 * generation treats it as TERMINAL: it surfaces "peer busy" and does not retry.
 * That is the right answer to a conflict and the wrong answer to a room whose
 * `/api/ice` reply has not landed yet — nobody has the lane, the offer is
 * perfectly acceptable, and the only thing missing is the configuration to
 * build a transport out of. Answering `busy` there would turn a slow HTTP
 * response into a failed transfer for a peer that did nothing wrong, and for a
 * peer that has already been waiting the sender's whole ICE timeout it would
 * turn one into a failure it cannot recover from. So the offer waits: `park`.
 *
 * Ordering is the rest of the rule. A real conflict is still `busy` whatever
 * the configuration is doing (a transfer in flight is a transfer in flight),
 * and a resume still outranks both — see above.
 *
 * `laneClaimed` is the same conflict seen one step earlier: the message lane is
 * mid-handshake, so it owns the room's single legacy lane while its own session
 * state still reads idle and `busy` cannot see it. See `createLaneClaim`.
 */
export function routeOffer(
  msg: Pick<InboundSignal, "sdp" | "resume" | "text">,
  ctx: { from: string; pausedFrom: string | null; busy: boolean; roomIcePending?: boolean; laneClaimed?: boolean },
): "resume" | "receive" | "busy" | "park" | "ignore" {
  if (msg.sdp?.type !== "offer") return "ignore";
  const gen = signalGeneration(msg);
  // resume 排在 busy 之前：暂停中的接收让 busy() 为真，而那条 offer 正是它在等的。
  // 它同样排在 laneClaimed 之前：续传等的就是这条 offer，而认领槽讲的是另一条道。
  if (gen === "resume") return ctx.pausedFrom === ctx.from ? "resume" : "ignore";
  // text 世代归消息监听器；别的世代（以后新增的）一律不碰。
  if (gen !== "file") return "ignore";
  if (ctx.busy || ctx.laneClaimed) return "busy";
  return ctx.roomIcePending ? "park" : "receive";
}

export function createTransferSession(deps: SessionDeps) {
  let incoming = $state<Incoming | null>(null); // pending receive awaiting accept/reject
  let recv = $state<Xfer | null>(null);
  let send = $state<Xfer | null>(null);
  let sasCode = $state("");
  // Live ICE path per direction, kept out of Xfer so the async getStats() poll
  // never races the transfer loop's high-frequency rewrites of send/recv.
  let sendPath = $state<ConnPath | undefined>();
  let recvPath = $state<ConnPath | undefined>();

  // 非响应式的协调把手（只在事件处理里被调用，不参与渲染）。
  let acceptFn: (() => void) | null = null;
  let rejectFn: (() => void) | null = null;
  let sendAbort: (() => void) | null = null;
  let recvAbort: (() => void) | null = null;
  // A receive whose connection dropped mid-transfer, waiting for the sender to
  // re-offer so it can resume. See beginReceive's resume closure.
  let pausedRecv: { from: string; resume: (offer: InboundSignal) => void } | null = null;
  let activeConn: Conn | null = null; // latest live connection — the ?debug=1 panel polls its stats

  // 消息会话和文件传输在 phase 1 里**互斥**：两者各跑一次完整握手，各有自己的 6 位
  // SAS，同时活着就是屏幕上同时挂两串不同的数字——而那会教会用户"这串数字是装饰"，
  // 恰好毁掉 commit-reveal 全套机制唯一想保住的东西。phase 2 把两条流并到一条 link
  // 上（一次握手、一串 SAS）之后才解除这条互斥。
  // 只看文件那一半。消息那一侧要问的正是这个：拿整个 busy() 去问会绕回来——busy() 本身
  // 就读 textActive。
  const transferActive = () => !!incoming || !!(recv && !recv.done) || !!(send && !send.done);
  const busy = () => transferActive() || deps.textActive?.() === true;

  // 方便管道内部照搬原来的写法。
  const signaling = () => deps.signaling();
  const rtcConfig = () => deps.rtcConfig();

  // ── RECEIVE ──────────────────────────────────────────────────────────────────
  /**
   * The one inbound offer waiting for this room's configuration.
   *
   * At most one, and only for as long as `roomIce.pending()`. What retires it is
   * IDENTITY, not a flag: every retirement point simply drops the record, and
   * the parked continuation compares the record it parked with the one it finds
   * when it wakes. So a retirement and a wake-up can never both build, a second
   * retirement is a no-op, and a peer that re-offers gets a fresh record rather
   * than a second transport.
   */
  let parkedOffer: { from: string; offer: InboundSignal } | null = null;
  const roomIcePending = () => deps.roomIce?.pending() === true;
  /**
   * The peer this lane holds the room's legacy claim for, if it holds it.
   *
   * Tracked by peer rather than as a flag so the departure paths can release a
   * claim that belongs to somebody who has gone — see `releaseClaim`.
   */
  let claimedFor: string | null = null;
  /** Take the room's single legacy lane for this peer. See `createLaneClaim`:
   *  the check and the take are one statement because both lanes wake in the
   *  same turn, and anything with an await inside it arbitrates nothing. */
  function claimLane(from: string): boolean {
    const gate = deps.roomIce;
    if (!gate) return true; // no window, no cross-lane wake-up to arbitrate
    if (!gate.claimLane("file")) return false;
    claimedFor = from;
    return true;
  }
  /** Give the slot back. Idempotent, and safe to call from a path that never
   *  took one. */
  function releaseClaim() {
    if (claimedFor === null) return;
    claimedFor = null;
    deps.roomIce?.releaseLane("file");
  }
  /** Retire parked inbound work: the socket, room or peer it waited on is gone.
   *  Idempotent, and the only thing that ever clears the record from outside.
   *
   *  It releases the claim as well, and that is what bounds a claim whose
   *  handshake never finishes: every room boundary, dead socket, reset and
   *  cancellation already comes through here, so the slot cannot outlive the
   *  room even when the setup it was taken for is still spinning. */
  function retireParkedInbound() { parkedOffer = null; releaseClaim(); }

  function listenForIncoming() {
    signaling().onSignal(async (from, data) => {
      const msg = data as InboundSignal;
      switch (routeOffer(msg, {
        from,
        pausedFrom: pausedRecv?.from ?? null,
        busy: busy(),
        roomIcePending: roomIcePending(),
        // The message lane's own state does not report a handshake in flight, so
        // without this an offer arriving during one is answered by a mutex that
        // is about to be wrong. `busy` is the honest answer, and the sender
        // would have got it a moment later anyway.
        laneClaimed: deps.roomIce?.laneClaimedByOther("file") === true,
      })) {
        case "ignore":
          return;
        case "resume":
          // routeOffer 已经确认过世代和对端身份都对得上。
          pausedRecv!.resume(msg);
          return;
        case "busy":
          // One transfer at a time. Tell the sender we're busy so it fails fast
          // with a clear "peer busy" message instead of waiting out its ICE
          // timeout. 只有文件世代会走到这里——这条回包不带世代标记，别的世代的发起方
          // 按世代会把它丢掉，等于白等一个超时。
          signaling().sendSignal(from, { busy: true });
          return;
        case "park":
          await parkInbound(from, msg);
          return;
        case "receive":
          await receiveNow(from, msg);
      }
    });
  }

  /** Build the receive side for an offer this lane has decided to take. */
  async function receiveNow(from: string, msg: InboundSignal) {
    try {
      await beginReceive(from, msg);
    } catch (err) {
      console.error("relayium receive setup error", err);
      recv = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "connectFail", done: true, ok: false, speed: 0 };
    }
  }

  /**
   * Hold an acceptable offer until this room has a configuration to answer it
   * with, then take it exactly once.
   *
   * The alternative is the one this replaced: answer `busy`. That is safe for
   * this page and terminal for the peer — it does not retry — so a room joined
   * a round trip early would deterministically fail a transfer for a peer that
   * was already waiting when the page arrived. Refusing is not accepting.
   */
  async function parkInbound(from: string, offer: InboundSignal) {
    const gate = deps.roomIce;
    if (!gate) return; // unreachable: `park` is only routed when the gate is pending
    if (parkedOffer && parkedOffer.from !== from) {
      // A SECOND peer while one is already waiting is the ordinary conflict this
      // lane has always answered, and it gets the answer it would get a moment
      // later anyway: one transfer at a time.
      signaling().sendSignal(from, { busy: true });
      return;
    }
    // …and the same peer offering again is that peer's own retry, so the newer
    // offer supersedes the older one — its SDP is the one it is listening for an
    // answer to. The old record is retired by being replaced, exactly once.
    const mine = { from, offer };
    parkedOffer = mine;
    const live = await gate.whenReady();
    // Whoever still owns the record releases it, INCLUDING on a supersede: a
    // wait abandoned with the slot left occupied would answer the next room's
    // first offer `busy` on behalf of a peer from the previous one.
    const owned = parkedOffer === mine;
    if (owned) parkedOffer = null;
    // Retired while parked — by the room boundary (`live` is false), by the peer
    // leaving, by a cancellation, or by this peer's own newer offer. Either way
    // this record no longer owns the wait, and nothing here may build.
    if (!live || !owned) return;
    // Re-asked rather than remembered: the wait spans a whole HTTP round trip,
    // and the mutex is precisely what can have changed inside it. The message
    // lane re-checks its own precheck at this same boundary, for this same
    // reason, and this is where a real conflict finally does answer `busy`.
    if (busy()) { signaling().sendSignal(from, { busy: true }); return; }
    // …and the mutex cannot answer for the lane that woke a statement earlier in
    // this same turn, because its handshake has not published anything for the
    // mutex to read. The claim is the part of the answer `busy()` cannot see.
    // Genuine and generation-correct: an untagged `busy` is what a file-
    // generation sender is listening for, and it is what it would have been told
    // a moment later anyway.
    if (!claimLane(from)) { signaling().sendSignal(from, { busy: true }); return; }
    // `beginReceive` publishes `recv` before its first await, so by the time
    // this call expression returns the ordinary mutex owns this peer and the
    // slot is no longer what is holding it — and a setup that failed on the way
    // in published a finished card instead, which owns nothing and must not hold
    // the slot either. The `finally` is the backstop for both: whatever
    // `receiveNow` does, this lane does not leave the room's slot taken.
    try {
      const receiving = receiveNow(from, offer);
      releaseClaim();
      await receiving;
    } finally {
      releaseClaim();
    }
  }

  /** Signal authentication for a resume connection, keyed by the session the
   *  first (SAS-verified) connection established. */
  function resumeAuthOf(k: SessionKeys): SignalAuth {
    return {
      sign: (payload) => signResume(k.resumeAuth, payload),
      verify: (payload, mac) => verifyResume(k.resumeAuth, payload, mac),
    };
  }

  async function beginReceive(from: string, offer: InboundSignal) {
    const selfKey = generateKeyPair(); // per-transfer ephemeral keypair
    let keys: SessionKeys | undefined;
    const receiver = new Receiver();
    let target: SaveTarget | undefined;
    let sink: FileSink | undefined;
    let manifest: FileMeta[] = [];
    let total = 0, got = 0, fileIndex = 0, start = 0;
    let allOk = true;
    // Resume state: `fileOffset` is bytes written of the *current* file (got is
    // batch-cumulative); `checkpoint` is the last point where the receiver's
    // chain hash and durably-written bytes agree — restored on resume.
    let fileOffset = 0;
    let checkpoint: { index: number; offset: number; chain: Uint8Array } = { index: 0, offset: 0, chain: new Uint8Array(32) };
    let resumable = false; // true once a byte is durably written — before that a drop just fails
    let lastAckSent = 0; // cumulative bytes at our last flow-control ack to the sender
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let resuming = false; // a resume() is mid-flight — blocks re-entrant offers
    let completing = false; // final batch is being flushed — a late "closed" must not resume
    let speedBase = 0; // bytes at the current speed-measurement epoch (reset on resume)
    // One serialized frame-handling chain shared across the original and every
    // resumed channel, so an in-flight write can't race a resumed write on the sink.
    let pending: Promise<void> = Promise.resolve();

    let r: Xfer = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "connecting", done: false, ok: false, speed: 0 };
    recv = r;
    recvPath = undefined;

    // Stall detection: a receive that goes quiet for STALL_MS (peer vanished, path
    // died before ICE noticed) is failed rather than left frozen mid-progress.
    let conn: Conn | undefined;
    let cancelled = false; // user hit cancel (possibly during ICE, before conn exists)
    let lastActivity = Date.now();
    // Publish progress into $state at most every UI_TICK_MS. See UI_TICK_MS.
    // `got`/`fileIndex` stay the source of truth in plain locals; `force` is for
    // moments the user must see exactly (file boundary, pause, end of batch).
    let lastUiAt = 0;
    const showProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastUiAt < UI_TICK_MS) return;
      lastUiAt = now;
      const elapsed = (now - start) / 1000;
      recv = r = { ...r, sent: got, index: fileIndex, speed: elapsed > 0 ? (got - speedBase) / elapsed : 0 };
    };
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const clearWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = undefined; } };
    // Central "this receive is dead" path: mark failed once, stop the watchdog,
    // drop any pending accept card, and tear down the connection.
    const failRecv = (status: StatusKey) => {
      if (r.done) return;
      clearWatchdog();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      if (pausedRecv?.from === from) pausedRecv = null;
      recv = r = { ...r, status, done: true, ok: false };
      incoming = null;
      recvAbort = null;
      conn?.close();
    };

    // User pressed cancel: tear down and return to idle (not a failure card).
    // Installed *before* connect so cancel works during ICE negotiation too — at
    // that point conn is undefined, so we flag `cancelled` and the post-connect
    // check closes the late connection. Mirrors the sender's pre-connect sendAbort.
    recvAbort = () => {
      cancelled = true;
      clearWatchdog();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      if (pausedRecv?.from === from) pausedRecv = null;
      conn?.close();
      recv = null;
      incoming = null;
      sasCode = "";
      recvAbort = null;
    };

    try {
      conn = await connect({
        signaling: signaling(), peerId: from, selfKey: selfKey.publicKey, role: "responder",
        initialSignal: offer,
        onPeerKey: async (pk) => { keys = await deriveSession("responder", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
        config: rtcConfig(),
        // A drop ICE can't recover: if bytes were already flowing, pause and wait
        // for the sender to re-offer so we can resume; otherwise fail. The normal
        // end-of-batch close also fires "closed", but this is a no-op once done.
        onStateChange: (state) => { if (state === "failed" || state === "closed") onRecvDrop(); },
      });
    } catch (err) {
      // The user cancelled while this was still connecting. recvAbort already
      // returned the UI to idle, so letting the rejection propagate would put a
      // "connection failed" card back on screen seconds after they dismissed it.
      if (cancelled) return;
      throw err;
    }

    // Cancelled while ICE was negotiating: the connection resolved after the abort,
    // so close it now (recvAbort already reset the UI to idle) and stop here.
    if (cancelled) { conn.close(); return; }

    const openSink = async () => {
      const f = manifest[fileIndex];
      sink = f ? await target!.file(f.name, f.size, f.path) : undefined;
    };

    // The accept click is the user gesture that lets the save picker open.
    acceptFn = async () => {
      const req = incoming;
      if (!req) return;
      try {
        // The save picker requires the click's transient user activation. Ask for
        // notification permission only AFTER it opens — Notification.requestPermission()
        // consumes that activation, and asking first makes the picker throw
        // "must be handling a user gesture" (no dialog shown) on mobile.
        target = await pickSaveTarget(req.files);
        requestNotifyPermission();
      } catch (err) {
        console.error("relayium save-target error", err);
        // 用户自己在选择器里按了取消（桌面独有；手机不开选择器）。此刻线路上**什么
        // 都没发生**：ACCEPT/REJECT 一个都没发出去，发送端仍停在 waitingAccept，而它
        // 那一侧除了通道关闭之外没有别的超时。所以这不是终局——把同意卡片留在原地，
        // 用户再点一次「接收」就是一次全新手势、一次全新的选择器。一次误按返回/Esc
        // 不该把整次传输判死。
        if (err instanceof SaveCancelledError && !r.done && !cancelled
            && conn!.channel.readyState === "open") {
          incoming = { ...req, retry: true };
          return;
        }
        // 剩下的是真失败：「保存这一段坏了」和「用户取消」必须分开报。全按取消报
        // 是这次线上事故的第二半——用户既没得选，还被告知是自己取消的。
        recv = r = { ...r, status: saveFailureStatus(err), done: true, ok: false };
        incoming = null;
        try { conn!.channel.send(REJECT); } catch { /* gone */ }
        conn!.close();
        return;
      }
      // The save picker can sit open for tens of seconds. If the connection died
      // (or the user cancelled) meanwhile, failRecv/recvAbort already tore this
      // receive down — do NOT resurrect it as "receiving" over a dead channel.
      if (r.done || cancelled) return;
      fileIndex = 0; got = 0; start = Date.now();
      // prepare file 0 (also covers a leading zero-byte file). This can fail on
      // its own after a perfectly good pick — the directory branch only touches
      // the disk here (getFileHandle/createWritable). Unguarded it left the card
      // frozen on the accept prompt with an unhandled rejection in the console;
      // it is a save failure, and never the user's cancellation.
      try {
        await openSink();
      } catch (err) {
        console.error("relayium open-sink error", err);
        recv = r = { ...r, status: "saveFail", done: true, ok: false };
        incoming = null;
        try { conn!.channel.send(REJECT); } catch { /* gone */ }
        conn!.close();
        return;
      }
      // Tell the sender we're ready. On an already-closed channel this throws
      // InvalidStateError — surface a failure the user can dismiss/retry instead
      // of freezing at "receiving 0%" with a dead cancel button.
      try {
        conn!.channel.send(ACCEPT);
      } catch (err) {
        console.error("relayium accept send error", err);
        if (sink) { try { await sink.close(); } catch { /* ignore */ } }
        failRecv("recvFail");
        return;
      }
      recv = r = { peer: from, dir: "recv", files: req.files, index: 0, sent: 0, total: req.total, status: "receiving", done: false, ok: false, speed: 0 };
      if (conn) trackPath(conn, (p) => (recvPath = p));
      incoming = null;
      // Arm the stall watchdog only once data is actually expected.
      lastActivity = Date.now();
      watchdog = setInterval(() => {
        if (!r.done && stalled(Date.now(), lastActivity, lastForegroundAt(), RECEIVE_STALL_MS)) failRecv("recvFail");
      }, 5_000);
    };

    rejectFn = () => {
      clearWatchdog();
      recvAbort = null;
      try { conn!.channel.send(REJECT); } catch { /* gone */ }
      incoming = null; recv = null; conn!.close();
    };

    // Wire a (re)connected channel to the shared, serialized frame pipeline. A
    // real (non-connection) error fails hard; connection drops come via state.
    const installChannel = (c: Conn) => {
      c.channel.onmessage = (ev) => {
        pending = pending
          .then(() => handleFrame(ev.data as ArrayBuffer))
          .catch((err) => { console.error("relayium receive error", err); failRecv("recvFail"); });
      };
    };

    // A connection drop. Before any bytes flow (or after done/cancel/while
    // finishing) it's a plain failure; mid-transfer it pauses for a re-offer.
    //
    // Function declarations, not `const` arrows: connect() below is handed
    // onRecvDrop as its onStateChange, and it can fire that callback
    // *synchronously during establishment* (a pc that goes "failed" before the
    // channel opens). A const would still be in its temporal dead zone then, so
    // the drop handler blew up with a ReferenceError instead of failing the
    // receive cleanly — the user saw a stuck card. e2e/lan-transfer.mjs injects
    // exactly that early failure to keep this honest.
    function onRecvDrop() {
      if (r.done || cancelled || completing) return;
      // No session keys means the commit-reveal handshake never completed, so
      // nothing was ever received — that is a failure to CONNECT, not a failed
      // receive. Reporting "receive failed" there sent the user looking at their
      // disk or the file when the problem was the connection (or the relay).
      if (!resumable) { failRecv(keys ? "recvFail" : "connectFail"); return; }
      if (pausedRecv || resuming) return; // already waiting or mid-resume
      clearWatchdog();
      conn?.close(); // drop the dead pc + its signalling listener so it can't cross-route the resume
      showProgress(true); // the loop has stopped — flush the throttled byte count before it freezes on screen
      recv = r = { ...r, status: "resuming", speed: 0 };
      pausedRecv = { from, resume };
      // Give up if the sender never comes back within the window.
      resumeTimer = setTimeout(() => { pausedRecv = null; failRecv("recvFail"); }, RESUME_WINDOW_MS);
    }

    // The sender re-offered: rebuild the channel reusing the existing keys (no new
    // handshake, SAS unchanged) and ask it to resume from our checkpoint. Guarded
    // against re-entrancy so a duplicate/ICE-restart offer can't spawn a second one.
    async function resume(offer: InboundSignal) {
      if (r.done || cancelled || resuming) return;
      // No keys means the first connection never finished its handshake, so there
      // is nothing to authenticate the re-offer against. Refuse rather than fall
      // back to an unauthenticated resume — that is precisely the hole.
      if (!keys) return;
      resuming = true;
      pausedRecv = null; // claim it: a concurrent offer must not re-enter
      const old = conn;
      let c: Conn;
      try {
        c = await connectResume({
          signaling: signaling(), peerId: from, role: "responder", initialSignal: offer,
          config: rtcConfig(), auth: resumeAuthOf(keys),
          onStateChange: (state) => { if (state === "failed" || state === "closed") onRecvDrop(); },
        });
      } catch {
        resuming = false;
        if (!r.done && !cancelled) pausedRecv = { from, resume }; // stay available for the next re-offer
        return;
      }
      if (r.done || cancelled) { c.close(); resuming = false; return; }
      old?.close(); // tear down the previous pc/listener before switching channels
      await pending.catch(() => {}); // let any in-flight old-channel frame finish first
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      conn = c;
      installChannel(c);
      trackPath(c, (p) => (recvPath = p));
      recv = r = { ...r, status: "receiving" };
      lastActivity = Date.now();
      watchdog = setInterval(() => {
        if (!r.done && stalled(Date.now(), lastActivity, lastForegroundAt(), RECEIVE_STALL_MS)) failRecv("recvFail");
      }, 5_000);
      resuming = false; // setup done; a further drop is handled by onRecvDrop again
      // Ask the sender to pick up from our last durable point.
      try { c.channel.send(resumeReqFrame(checkpoint.index, checkpoint.offset)); }
      catch { onRecvDrop(); }
    }

    const handleFrame = async (buf: ArrayBuffer) => {
      while (!keys) {
        if (r.done) return; // connection failed/cancelled during handshake — drop the frame
        await sleep(5); // queue frames until keys are derived
      }
      const out = await receiver.feed(new Uint8Array(buf), keys);
      // Any authenticated frame is progress, including a piece of a chunk that
      // has not been assembled yet. Counting only completed chunks would let a
      // slow link look stalled while it is visibly working.
      lastActivity = Date.now();
      if (out.batch) {
        manifest = out.batch.files;
        total = manifest.reduce((n, f) => n + f.size, 0);
        incoming = { from, files: manifest, total };
        recv = null; // the accept card takes over
        return;
      }
      if (out.resume) {
        // The sender announced where it's picking up. Restore the chain hash to
        // our last durable checkpoint and align the nonce; keep writing the same
        // (still-open) sink from here. `got` is recomputed batch-cumulatively.
        receiver.resumeAt(checkpoint.chain, out.resume.seq);
        fileIndex = checkpoint.index;
        fileOffset = checkpoint.offset;
        got = manifest.slice(0, checkpoint.index).reduce((n, f) => n + f.size, 0) + checkpoint.offset;
        speedBase = got; // measure post-resume throughput from here, not from 0
        lastAckSent = got; // realign the ack cursor so the first post-resume ack is fresh
        start = Date.now();
        lastActivity = Date.now();
        return;
      }
      if (out.chunk && sink) {
        // 越界写入的闸门。manifest 声明了每个文件的大小，接收端正是拿这个数字向用户
        // 展示"要收什么"、并据此做出接受的决定；但**发送端完全可以不守这份声明**
        // ——比如无视接收端给出的续传点、从 0 重发整个文件。
        //
        // 没有这道闸，多出来的字节会照单全收地写进磁盘/内存：末尾的链式哈希最终会
        // 对不上、这次传输会被判失败，但那是**写完之后**才发生的事。"先无界写入、
        // 再报错"不是一个可接受的顺序——用户同意接收的是 N 字节，就不该被写入超过
        // N 字节。所以在写之前拦，而不是在校验时兜。
        if (wouldExceedDeclared(manifest[fileIndex]?.size, fileOffset, out.chunk.length)) {
          console.error("relayium: sender exceeded the declared size of", manifest[fileIndex]?.name);
          if (sink) { try { await sink.close(); } catch { /* 已经废了 */ } }
          failRecv("integrityFail"); // 用户看到的是"完整性校验失败"——收到的东西确实与承诺不符
          return;
        }
        await sink.write(out.chunk);
        resumable = true; // a byte is now durably written — a drop from here can resume
        got += out.chunk.length;
        fileOffset += out.chunk.length;
        lastActivity = Date.now(); // progress resets the stall watchdog
        // Checkpoint only after the write lands, so a resume never claims bytes
        // that weren't durably written.
        checkpoint = { index: fileIndex, offset: fileOffset, chain: receiver.snapshotChain() };
        // Flow-control: report durably-written bytes so the sender paces itself to
        // our disk speed and keeps at most one window ahead. Throttled by interval.
        if (got - lastAckSent >= FLOW_ACK_INTERVAL) {
          lastAckSent = got;
          try { conn!.channel.send(ackFrame(got)); } catch { /* gone — the drop path handles it */ }
        }
        showProgress();
        return;
      }
      if (out.done) {
        lastActivity = Date.now();
        if (fileOffset !== manifest[fileIndex]?.size) {
          if (sink) { try { await sink.close(); } catch { /* already invalid */ } }
          failRecv("integrityFail");
          return;
        }
        if (sink) await sink.close();
        allOk = allOk && out.done.ok;
        fileIndex++;
        fileOffset = 0;
        if (fileIndex < manifest.length) {
          await openSink();
          // New file, fresh chain: checkpoint the boundary so a drop before the
          // first chunk resumes this file from 0.
          checkpoint = { index: fileIndex, offset: 0, chain: new Uint8Array(32) };
          showProgress(true); // file boundary: publish the exact byte count with the new index
        } else {
          completing = true; // from here a "closed" is the normal end-of-batch, not a drop
          clearWatchdog();
          if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
          if (pausedRecv?.from === from) pausedRecv = null;
          recvAbort = null;
          // Finalise the batch destination — flushes the bundled ZIP on the
          // fallback path; a no-op for streaming targets.
          await target!.done?.();
          const n = manifest.length;
          recv = r = {
            ...r, sent: total, index: n - 1,
            status: allOk ? "recvDone" : "integrityFail",
            done: true, ok: allOk, speed: 0,
          };
          // Tell the sender we have the whole batch so it can close without dropping
          // any still-buffered tail. Delay our own close so the ack actually flushes.
          try { conn!.channel.send(COMPLETE); } catch { /* gone */ }
          setTimeout(() => conn!.close(), 1500);
        }
        return;
      }
    };

    installChannel(conn);
  }

  // ── SEND ───────────────────────────────────────────────────────────────────────
  async function sendFiles(peerId: string, picked: PickedFile[]) {
    if (busy()) { deps.flash(deps.t().busy); return; }
    const chosen = picked.slice(0, MAX_FILES);
    if (chosen.length === 0) return;
    requestNotifyPermission(); // ask once, inside the gesture that starts the send
    const dropped = picked.length - chosen.length;
    const files = chosen.map((p) => p.file);

    const metas: FileMeta[] = chosen.map((p) => ({ name: p.file.name, size: p.file.size, path: p.path }));
    const total = metas.reduce((n, m) => n + m.size, 0);
    let s: Xfer = { peer: peerId, dir: "send", files: metas, index: 0, sent: 0, total, status: "connecting", done: false, ok: false, speed: 0 };
    send = s;
    sendPath = undefined;
    if (dropped > 0) deps.flash(deps.t().tooMany(MAX_FILES, dropped));

    const selfKey = generateKeyPair();
    let keys: SessionKeys | undefined;
    let resolveAccept!: (ok: boolean) => void;
    const accepted = new Promise<boolean>((r) => (resolveAccept = r));
    let resolveComplete!: () => void;
    const completed = new Promise<void>((r) => (resolveComplete = r));
    let conn: Conn | undefined;
    let connLost = false;
    let cancelled = false;
    let gotComplete = false; // receiver acked the whole batch — success even if the pc then drops
    let sender: Sender | undefined; // hoisted so a resume can keep its monotonic seq
    let dataStarted = false; // true once we're actually streaming file data (resume only applies after this)

    // Application-level flow control: the receiver reports cumulative durably-written
    // bytes; we never run more than FLOW_WINDOW ahead of that. `ackedAt` is the last
    // time the ack advanced — flush() uses it as a liveness signal so it waits for a
    // slow-but-alive receiver instead of closing on a fixed short timeout.
    let acked = 0;
    let sentHighWater = 0;
    let ackedAt = Date.now();
    let ackWaiter: (() => void) | null = null;
    const onAck = (n: number) => {
      const next = advanceAck(acked, sentHighWater, n);
      if (next !== acked) {
        acked = next; ackedAt = Date.now(); const w = ackWaiter; ackWaiter = null; w?.();
      }
    };
    // Block until the receiver's acks let us send more (or it goes silent — then
    // throw so the send loop treats it as a drop and resumes/fails, not hangs).
    const creditGate = async (sent: number) => {
      while (sent - acked > FLOW_WINDOW) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { ackWaiter = null; reject(new Error("send stalled: receiver not acking")); }, 60_000);
          ackWaiter = () => { clearTimeout(timer); resolve(); };
        });
      }
    };

    // User pressed cancel: unblock every await, tear down, and clear the card so
    // the UI returns to idle (not a failure state) and other methods reopen.
    sendAbort = () => {
      cancelled = true;
      connLost = true;
      resolveAccept(false);
      resolveComplete();
      conn?.close();
      send = null;
      sasCode = "";
    };

    // Reconnect-and-resume after a mid-send drop: retry connectResume (reusing the
    // authenticated keys — no new handshake, SAS unchanged) until the receiver's
    // resume request arrives and we stream the rest, or the window elapses.
    const resumeSend = async (): Promise<boolean> => {
      if (!sender || !keys) return false;
      const deadline = Date.now() + RESUME_WINDOW_MS;
      while (Date.now() < deadline) {
        if (cancelled) return false;
        send = s = { ...s, status: "resuming", speed: 0 };
        let rconn: Conn | undefined;
        try {
          let lost = false;
          rconn = await connectResume({
            signaling: signaling(), peerId, role: "initiator", config: rtcConfig(),
            auth: resumeAuthOf(keys),
            onStateChange: (state) => { if (state === "failed" || state === "closed") lost = true; },
          });
          conn = rconn; // so sendAbort tears down the current connection
          let resolveReq!: (rp: ResumePoint) => void;
          const reqReceived = new Promise<ResumePoint>((r) => (resolveReq = r));
          let doneAck = false;
          rconn.channel.onmessage = (ev) => {
            const buf = ev.data as ArrayBuffer;
            const a = parseAck(buf);
            if (a !== null) { onAck(a); return; }
            const rp = parseResumeReq(buf);
            // 范围校验：越界的续传点会让下面的 files.slice / file.slice 切出错误的
            // 字节区间。形状（非负整数）已由 parseResumeReq 保证，这里只能由我们
            // 判断上界——只有发送端知道这批文件各多大。对齐校验挡的是另一件事：
            // 不落在分块边界上的续传点会让发送端跳过它和下一个边界之间的字节。
            const sizes = files.map((f) => f.size);
            if (rp && resumePointInRange(rp, sizes) && resumePointAligned(rp, sizes)) { resolveReq(rp); return; }
            if (controlKind(buf) === "complete") doneAck = true;
          };
          // The receiver sends its resume request as soon as the channel opens.
          const rp = await Promise.race([
            reqReceived,
            sleep(15_000).then(() => Promise.reject(new Error("no resume request"))),
          ]) as ResumePoint;
          if (cancelled) return false;
          rconn.channel.send(sender.resumeStartFrame(rp));
          send = s = { ...s, status: "sending" };
          const base = files.slice(0, rp.index).reduce((n, f) => n + f.size, 0) + rp.offset;
          acked = base; // the receiver already has these bytes; open the window from here
          ackedAt = Date.now();
          const start = Date.now();
          let sent = base, idx = rp.index;
          // A resume checkpoint starts a new transport window. Delayed ACKs from
          // the abandoned attempt must not open credit beyond this attempt's
          // newly emitted bytes.
          sentHighWater = sent;
          let lastUiAt = 0; // UI progress throttle — see UI_TICK_MS
          // A resumed connection negotiates its own maximum message size, which
          // may be smaller (or larger) than the one that dropped. Only the
          // fragmentation changes: the chain hash and the checkpoint grid are
          // defined in CHUNK_SIZE, so the two attempts still agree on the bytes.
          for await (const frame of sender.dataFrames(files, keys, rp, rconn.maxFrameBytes())) {
            if (lost) throw new Error("connection lost during resume");
            await backpressure(rconn.channel);
            await creditGate(sent); // don't outrun the receiver's durable writes
            rconn.channel.send(frame);
            if (isChunkFrame(frame)) {
              sent += frame.byteLength - CHUNK_OVERHEAD;
              sentHighWater = Math.max(sentHighWater, sent);
            }
            else if (frame[0] === FRAME.DONE) idx++;
            const now = Date.now();
            if (now - lastUiAt >= UI_TICK_MS) {
              lastUiAt = now;
              const elapsed = (now - start) / 1000;
              send = s = { ...s, sent: Math.min(total, sent), index: Math.min(idx, files.length - 1), speed: elapsed > 0 ? (sent - base) / elapsed : 0 };
            }
          }
          send = s = { ...s, sent: total, index: files.length - 1, status: "finishing", speed: 0 };
          const completeAck = new Promise<void>((r) => {
            const iv = setInterval(() => { if (doneAck) { clearInterval(iv); r(); } }, 100);
            setTimeout(() => { clearInterval(iv); r(); }, 30_000);
          });
          await flush(rconn.channel, completeAck, () => ackedAt);
          if (lost) throw new Error("connection lost");
          return true;
        } catch {
          rconn?.close();
          if (cancelled) return false;
          await sleep(1500); // backoff before the next reconnect attempt
        }
      }
      return false;
    };

    try {
      conn = await connect({
        signaling: signaling(), peerId, selfKey: selfKey.publicKey, role: "initiator",
        onPeerKey: async (pk) => { keys = await deriveSession("initiator", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
        config: rtcConfig(),
        // A drop that ICE can't recover unblocks every await so the loop stops
        // instead of hanging; the post-await connLost checks turn it into a
        // visible failure the user can retry.
        onStateChange: (state) => {
          if (state === "failed" || state === "closed") {
            connLost = true;
            resolveAccept(false);
            resolveComplete();
          }
        },
      });
      conn.channel.onmessage = (ev) => {
        const buf = ev.data as ArrayBuffer;
        const a = parseAck(buf);
        if (a !== null) { onAck(a); return; }
        const k = controlKind(buf);
        if (k === "accept") resolveAccept(true);
        else if (k === "reject") resolveAccept(false);
        else if (k === "complete") { gotComplete = true; resolveComplete(); }
      };
      conn.channel.onclose = () => resolveAccept(false);

      // Wait for the peer's key (arrives with the answer). Bail if the connection
      // dies during the handshake so this doesn't spin forever.
      while (!keys) {
        if (connLost) throw new Error("connection lost before key exchange");
        await sleep(20);
      }

      sender = new Sender();
      // manifest 现在是加密的（见 transfer.ts 的 KIND_BATCH_ENC），所以要 await，
      // 也必须在拿到 keys 之后发——上面那个 while 循环保证了这一点。
      // 每一帧都按这条连接协商出来的单帧上限切；上限太小的连接在这里就明确失败，
      // 而不是等第一个数据块把通道打死。
      const limit = conn.maxFrameBytes();
      for (const f of await sender.batchFrames(metas, keys, limit)) conn.channel.send(f);
      send = s = { ...s, status: "waitingAccept" };

      const ok = await accepted;
      if (connLost) throw new Error("connection lost");
      if (!ok) {
        send = s = { ...s, status: "rejected", done: true, ok: false };
        return;
      }

      send = s = { ...s, status: "sending" };
      dataStarted = true; // from here a drop can resume instead of failing
      trackPath(conn, (p) => (sendPath = p));
      const start = Date.now();
      let sent = 0, idx = 0;
      let lastUiAt = 0; // UI progress throttle — see UI_TICK_MS
      for await (const frame of sender.dataFrames(files, keys, undefined, limit)) {
        await backpressure(conn.channel);
        await creditGate(sent); // don't outrun the receiver's durable writes
        conn.channel.send(frame);
        if (isChunkFrame(frame)) {
          sent += frame.byteLength - CHUNK_OVERHEAD;
          sentHighWater = Math.max(sentHighWater, sent);
        }
        else if (frame[0] === FRAME.DONE) idx++;
        const now = Date.now();
        if (now - lastUiAt >= UI_TICK_MS) {
          lastUiAt = now;
          const elapsed = (now - start) / 1000;
          send = s = { ...s, sent: Math.min(total, sent), index: Math.min(idx, files.length - 1), speed: elapsed > 0 ? sent / elapsed : 0 };
        }
      }
      // All frames are queued, but channel.send() only buffers them. Closing now would
      // drop whatever is still in flight (the receiver would stall short of 100%), so
      // wait for the receiver's completion ack — or our buffer to drain — before closing.
      send = s = { ...s, sent: total, index: files.length - 1, status: "finishing", speed: 0 };
      await flush(conn.channel, completed, () => ackedAt);
      // If the receiver already acked the whole batch, the transfer succeeded even
      // if the pc dropped right after — don't fail (or needlessly try to resume) it.
      if (connLost && !gotComplete) throw new Error("connection lost");
      send = s = { ...s, status: "sendDone", done: true, ok: true };
    } catch (err) {
      if (cancelled) return;
      // The peer refused the offer because it's already in a transfer — a clean
      // "busy", not a failure to connect. Surface it as such and don't retry.
      if (err instanceof PeerBusyError) {
        send = s = { ...s, status: "peerBusy", done: true, ok: false };
        return;
      }
      console.error("relayium send error", err);
      // A mid-send drop is resumable: reconnect (reusing keys) and finish from the
      // receiver's checkpoint. Only fall through to failure if that gives up.
      if (dataStarted && !gotComplete && (await resumeSend())) {
        send = s = { ...s, status: "sendDone", done: true, ok: true };
      } else if (!cancelled) {
        // Distinguish "never connected" from "dropped mid-send" so the user knows
        // whether to retry the connection or the transfer.
        const status = s.status === "connecting" || s.status === "waitingAccept" ? "connectFail" : "sendFail";
        send = s = { ...s, status, done: true, ok: false };
      }
    } finally {
      conn?.close();
      sendAbort = null;
    }
  }

  // ── 传输侧的工具（两条管道都用，组件一个都不需要）────────────────────────────────────────────────────────────────────
  // Wait for the in-flight buffer to drain below the window before sending more.
  // Bounded: if the peer stops draining (frozen tab, dead path that hasn't yet
  // surfaced as an ICE failure) the low-water event never fires, so time out and
  // let the send loop error instead of hanging forever.
  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ch.onbufferedamountlow = null;
        reject(new Error("send stalled: peer stopped draining"));
      }, 60_000);
      ch.onbufferedamountlow = () => {
        clearTimeout(timer);
        ch.onbufferedamountlow = null;
        resolve();
      };
    });
  }

  // Wait until it is safe to close: ideally the receiver's explicit completion ack.
  // Until then keep waiting while the receiver is still alive — either our send
  // buffer is still draining, or its flow-control acks are still advancing (a slow
  // phone writing the last window to disk). Only give up once BOTH have been idle
  // for the grace period, so we never close on a receiver that is merely slow (the
  // old fixed 1 s fallback did exactly that, dropping the tail and faking a "drop").
  async function flush(ch: RTCDataChannel, completed: Promise<void>, lastAckAt: () => number) {
    let done = false;
    void completed.then(() => { done = true; });
    while (!done) {
      if (ch.bufferedAmount === 0 && Date.now() - lastAckAt() > 30_000) return;
      await sleep(250);
    }
  }


  // Poll the live ICE path a few times once a channel is up: the selected
  // candidate pair can settle shortly after the data channel opens.
  // Fire-and-forget from three call sites, so it must never reject: conn.path()
  // calls getStats(), which rejects as soon as the peer connection is closed —
  // i.e. at the end of *every* transfer, while this poll is still sleeping.
  // Swallow it and stop polling; the path label just keeps its last value.
  async function trackPath(conn: Conn, set: (p: ConnPath) => void) {
    activeConn = conn;
    for (let i = 0; i < 8; i++) {
      try {
        const p = await conn.path();
        if (p !== "unknown") { set(p); return; }
      } catch {
        return; // connection gone
      }
      await sleep(400);
    }
  }

  return {
    // 响应式读口。必须是 getter：导出变量本身只会导出一个快照。
    get incoming() { return incoming; },
    get recv() { return recv; },
    get send() { return send; },
    get sasCode() { return sasCode; },
    get sendPath() { return sendPath; },
    get recvPath() { return recvPath; },
    /** 有没有传输/待确认在进行中。组件据此禁用发送入口、拦住导航。 */
    get busy() { return busy(); },
    /** 只有文件传输在跑吗。消息会话用它来做互斥判断——它自己已经算在 busy() 里了。 */
    get transferActive() { return transferActive(); },

    /** 开始路由入站 offer。信令连上之后调一次。 */
    listenForIncoming,
    /** 向某个对端发一批文件。 */
    sendFiles,

    /** 确认卡片上的两个动作。没有待确认时是空操作。 */
    accept: () => acceptFn?.(),
    reject: () => rejectFn?.(),
    /** 用户按下取消。方向由卡片自己知道。 */
    abort: (dir: "send" | "recv") => (dir === "send" ? sendAbort?.() : recvAbort?.()),
    /** 切换房间时把两侧都拆掉。 */
    abortAll: () => { retireParkedInbound(); sendAbort?.(); recvAbort?.(); },

    /** 这个对端走了。停在这里等本房间 ICE 答复的那条 offer 跟着它一起作废：
     *  answer 发给一个已经离开的对端谁也收不到，而那条记录不该活到下一次唤醒去建连。
     *  别的对端停的那条不受影响。
     *
     *  Its claim goes too, and only its own: a setup started for a peer that has
     *  left cannot finish, so holding the room's single lane on its behalf would
     *  answer the peer that REPLACED it `busy` for as long as the dead handshake
     *  takes to notice. Scoped by peer, so the other lane's claim is untouched. */
    peerGone: (peerId: string) => {
      if (parkedOffer?.from === peerId) parkedOffer = null;
      if (claimedFor === peerId) releaseClaim();
    },
    /** Retire parked inbound work outright — the socket it was parked on is
     *  gone, so the room it belongs to cannot be answered. Idempotent. */
    retireParkedInbound,

    /** 收起一张已完成的卡片（自动消失的定时器用）。identity 守卫由调用方做。 */
    dismissSend: (x: Xfer) => { if (send === x) send = null; },
    dismissRecv: (x: Xfer) => { if (recv === x) recv = null; },
    /** 房间切换时的硬复位。 */
    reset: () => { retireParkedInbound(); send = null; recv = null; incoming = null; sasCode = ""; sendPath = undefined; recvPath = undefined; },

    /** ?debug=1 面板轮询的当前连接。 */
    conn: () => activeConn,
  };
}

export type TransferSession = ReturnType<typeof createTransferSession>;
