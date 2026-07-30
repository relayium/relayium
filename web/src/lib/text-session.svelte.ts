// 一次短暂的、端到端加密的消息会话的状态机。
//
// 它不认识 WebRTC：建连和监听都由调用方通过 deps 注进来（App 里是 connectText 和一个
// text 世代的信令监听器），所以这台状态机可以在没有 RTCPeerConnection 的情况下被完整
// 测试——而它管的正是最容易出错的那几件事：同意、速率、上限、生命周期。
//
// phase 1 里消息会话和文件传输**互斥**（见 transfer-session 的 busy()）：两者各跑一次
// 握手，同时活着就意味着屏幕上同时出现两串不同的 6 位数，而那会教会用户"这串数字是
// 装饰"。phase 2 把两条流并到一条 link 上，一次握手一串数字，那时才解除互斥。

import { PeerBusyError } from "./webrtc";
import type { ConnPath } from "./webrtc";
import type { SessionKeys } from "./crypto";
import { TextSender, TextReceiver, TEXT_MAX_BYTES, textByteLength, isTextFrame } from "./text-wire";
import { ACCEPT, REJECT, controlKind } from "./transfer";
import { peerSupportsText } from "./peer-caps.svelte";
import { createRateBucket } from "./rate-bucket";

/** 接收端一个会话内最多接多少条。 */
export const TEXT_SESSION_MAX_MESSAGES = 500;
/** 接收端一个会话内最多接多少字节——挡的是"把消息通道当批量传输用"。 */
export const TEXT_SESSION_MAX_BYTES = 4 << 20;
/** UI 里保留多少条。内存上限，不是策略。 */
export const TEXT_HISTORY_MAX = 200;
/** Receiver-side flood guard, shaped after the server's signalling limiter
 *  (`internal/signal/connlimit.go`: burst 50, refill 10/s). */
export const TEXT_BURST = 20;
export const TEXT_PER_SEC = 5;
/**
 * No traffic either way for this long and the session ends.
 *
 * 这是一条**成本**约束，不是安全约束。跨网络那条路强制 iceTransportPolicy: "relay"，
 * 所以一条挂着不动的会话会一直占着一个 TURN allocation；而 TURN 凭据的 TTL 本来就是
 * 一小时（server 的 TURNCredTTL），会话活得比它久也没有意义。文件传输跑在自己的连接
 * 上，所以这个定时器永远不可能打断一次传输。
 */
export const TEXT_IDLE_MS = 600_000;
/**
 * Refuse to send above this much already buffered on the channel.
 *
 * 消息流不需要文件流那套信用窗口：一条最多 64 KiB，由人按键产生，也从不落盘，没有
 * 需要被节流的慢消费者；而且信用窗口意味着要发确认帧，而确认帧离"已读回执"只有一步，
 * 那是产品上明确不做的东西。真正需要的只是 SCTP 这一层的兜底：对端不再排空了，就把
 * 这条会话当结束，而不是无界地攒一堆用户以为已经发出去的明文。
 */
export const TEXT_SEND_BUFFER_MAX = 1 << 20;

export type TextStatus =
  | "idle" | "connecting" | "waitingAccept" | "incomingRequest"
  | "open" | "ended" | "failed" | "refused" | "unsupported" | "peerBusy";

/** Terminal-error keys, all of which are keys of Messages["text"], so the UI can
 *  render one without a mapping table. "" means no error. */
export type TextErrorKey =
  | "" | "tooLong" | "flooding" | "unsupported" | "peerBusy" | "failed" | "refused";

export interface TextMessage {
  id: number;      // monotonic, local; also the list key
  dir: "out" | "in";
  body: string;    // exact bytes as sent/received, never normalised
  at: number;      // local clock; never sent, never received
  failed: boolean; // an outbound message whose send did not reach the channel
}

/** 一条活着的消息连接，不管它是怎么建起来的。注进来而不是自己建，是为了让这台状态机
 *  能在没有 WebRTC 的情况下被测。 */
export interface TextConn {
  channel: {
    send(data: ArrayBuffer | Uint8Array): void;
    close(): void;
    readyState: string;
    bufferedAmount?: number;
    onmessage: ((e: { data: ArrayBuffer }) => void) | null;
    onclose: (() => void) | null;
  };
  keys: SessionKeys;
  sas: string;
  path?: ConnPath;
  close(): void;
}

export interface TextSessionDeps {
  /** Opens a text-generation connection to a peer (connectText, in App.svelte). */
  connect(peerId: string): Promise<TextConn>;
  /** Subscribes to inbound text-generation offers; returns an unsubscribe. */
  listen(onOffer: (peerId: string, conn: TextConn) => void): () => void;
  now(): number;
}

export interface TextSession {
  readonly status: TextStatus;
  readonly peerId: string;
  readonly sasCode: string;
  readonly path: ConnPath | undefined;
  readonly history: TextMessage[];
  readonly errorKey: TextErrorKey;
  listenForRequests(): void;
  openWith(peerId: string): Promise<void>;
  accept(): void;
  reject(): void;
  send(body: string): Promise<void>;
  end(): void;
  clearHistory(): void;
  active(): boolean;
}

export function createTextSession(deps: TextSessionDeps): TextSession {
  // 每个响应式格子都通过 getter 暴露：$state 的依赖追踪是按属性访问算的，把对象整体
  // 返回一次不会重新渲染。和 transfer-session 一样。
  let status = $state<TextStatus>("idle");
  let peerId = $state("");
  let sasCode = $state("");
  let path = $state<ConnPath | undefined>(undefined);
  let history = $state<TextMessage[]>([]);
  let errorKey = $state<TextErrorKey>("");

  // Per-session, never per-module: a new session must not inherit a counter, a
  // budget, or a rate allowance from the last one.
  let conn: TextConn | null = null;
  let keys: SessionKeys | null = null;
  let sender = new TextSender();
  let receiver = new TextReceiver();
  let bucket = createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now);
  let count = 0;
  let bytes = 0;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Serialises frame() per sender. Required, not tidy: see send().
  let sendChain: Promise<void> = Promise.resolve();
  // 入站也串行，理由不同但同样是正确性：TextReceiver.feed 跨着一个 await 读并推进
  // expectedSeq，所以两条并发进来的帧会同时看到同一个期望值，第二条被误判成乱序而
  // 硬失败整条会话。文件接收那一侧用同一个手法（transfer-session 的 pending 链）。
  let recvChain: Promise<void> = Promise.resolve();
  let unlisten: (() => void) | null = null;
  // 当前"这一次尝试"的代号。openWith 要 await deps.connect()，而在那个 await 悬着的
  // 时候 end()、换房间、拒绝都可能已经把会话收掉了。续体拿自己开始时的快照和这个值
  // 比：不一致就说明它已经被取代，那条**迟到的连接必须自己关掉**，并且一个字节的
  // status/history/keys 都不许改——否则它会把用户已经关掉的会话重新点亮，还漏掉一条
  // 开着的连接。
  let attempt = 0;
  // 页面生命周期内有效，有意如此：被拒绝过的对端不能靠重开一条连接再问一次。换一个
  // 新的 peer id 就能绕过它——这一点和这个应用里所有按 peer 做的决定一样，是已知代价。
  const refused = new Set<string>();

  function resetSession() {
    recvChain = Promise.resolve();
    sender = new TextSender();
    receiver = new TextReceiver();
    bucket = createRateBucket(TEXT_BURST, TEXT_PER_SEC, deps.now);
    count = 0;
    bytes = 0;
    history = [];
    sendChain = Promise.resolve();
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish("ended"), TEXT_IDLE_MS);
  }

  /** 收尾一次。幂等：已经收尾过就什么都不做。 */
  function finish(next: TextStatus, key: TextErrorKey = "") {
    // 无条件递增，而且在下面那个提前 return 之前：状态已经是终态时更不该让一次
    // 在途的尝试落地。
    attempt++;
    if (status === "idle" || status === "ended" || status === "failed"
        || status === "refused" || status === "unsupported" || status === "peerBusy") {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
    status = next;
    errorKey = key;
    const c = conn;
    conn = null;
    keys = null; // 历史留着渲染，密钥不留
    try { c?.close(); } catch { /* already gone */ }
  }

  function record(m: Omit<TextMessage, "id">) {
    const next = [...history, { id: nextId++, ...m }];
    history = next.length > TEXT_HISTORY_MAX ? next.slice(next.length - TEXT_HISTORY_MAX) : next;
    touch();
  }

  /** 只有在 accept() 之后才挂上——这就是"同意之前不渲染任何内容"是结构性的而不是
   *  一条渲染代码得一直记着的规则。对端提前发的帧留在通道缓冲里，挂上的那一刻按序
   *  送达，一条不丢。 */
  function attachInbound(c: TextConn) {
    c.channel.onmessage = (e) => queue(e.data);
  }

  /** 出站方向从建连起就挂上：发起方需要收对端的 ACCEPT/REJECT。它自己是发起方，
   *  所以它这一侧没有"同意"这个问题。 */
  function attachControl(c: TextConn) {
    c.channel.onclose = () => finish("ended");
    c.channel.onmessage = (e) => queue(e.data);
  }

  /** One frame at a time, in arrival order. */
  function queue(data: ArrayBuffer) {
    recvChain = recvChain
      .then(() => onFrame(data))
      .catch((err) => console.error("relayium message dispatch error", err));
  }

  async function onFrame(data: ArrayBuffer) {
    // 单字节控制帧。和 kind 9 的帧在结构上不可能混（1 字节 vs ≥21 字节），而且用的
    // 就是文件那条流已有的那套常量，没有新造词汇。
    const ctrl = controlKind(data);
    if (ctrl === "accept") {
      if (status === "waitingAccept") { status = "open"; touch(); }
      return;
    }
    if (ctrl === "reject") {
      if (status === "waitingAccept") finish("refused", "refused");
      return;
    }
    if (ctrl === "complete") return; // 文件协议的字节，这条流上没有意义

    if (!keys || !isTextFrame(data)) return;
    // 通道是有序可靠的，所以 ACCEPT 一定先到。在它之前来的消息帧不是网络现象。
    if (status !== "open") return finish("failed", "failed");
    if (!bucket.take()) return finish("failed", "flooding");
    if (count + 1 > TEXT_SESSION_MAX_MESSAGES || bytes + data.byteLength > TEXT_SESSION_MAX_BYTES) {
      return finish("failed", "failed");
    }
    try {
      const body = await receiver.feed(new Uint8Array(data) as Uint8Array<ArrayBuffer>, keys.textRecv);
      count += 1;
      bytes += data.byteLength;
      record({ dir: "in", body, at: deps.now(), failed: false });
    } catch (err) {
      // 错误对象，绝不是正文。乱序/被改过的帧是硬失败，和文件流一样。
      console.error("relayium message receive error", err);
      finish("failed", "failed");
    }
  }

  return {
    get status() { return status; },
    get peerId() { return peerId; },
    get sasCode() { return sasCode; },
    get path() { return path; },
    get history() { return history; },
    get errorKey() { return errorKey; },

    listenForRequests() {
      unlisten?.();
      unlisten = deps.listen((from, c) => {
        // 拒绝过的对端，或者已经有一个会话在跑：直接关掉，不挂 onmessage，也就不会
        // 有任何东西被解密或渲染。
        if (refused.has(from) || active()) { try { c.close(); } catch { /* gone */ } return; }
        resetSession();
        conn = c;
        keys = c.keys;
        peerId = from;
        sasCode = c.sas;
        path = c.path;
        errorKey = "";
        status = "incomingRequest";
        c.channel.onclose = () => finish("ended");
        touch();
      });
    },

    async openWith(id: string): Promise<void> {
      // 已经有一次尝试或一场会话在跑就直接不理。UI 那边 busy 已经把按钮禁掉了，这里
      // 是第二道：重入会 resetSession() 掉一场活着的会话的历史，而两次 openWith 交错
      // 落地还会让一条连接无人认领。
      if (active()) return;
      // 在**任何**尝试之前就挡住：跑旧版本的对端绝不能收到一条它会当成文件传输、然后
      // 等一个永远不来的 manifest 的 offer。
      if (!peerSupportsText(id)) {
        peerId = id;
        status = "unsupported";
        errorKey = "unsupported";
        return;
      }
      const mine = ++attempt;
      resetSession();
      peerId = id;
      status = "connecting";
      errorKey = "";
      try {
        const c = await deps.connect(id);
        // 迟到了：这次尝试已经被取代。把连接关掉，什么都不改。
        if (mine !== attempt) { try { c.close(); } catch { /* already gone */ } return; }
        conn = c;
        keys = c.keys;
        sasCode = c.sas;
        path = c.path;
        attachControl(c);
        status = "waitingAccept";
        touch();
      } catch (err) {
        // 失败也一样会迟到，而 "failed"/"peerBusy" 同样会盖掉用户看到的 "ended"。
        if (mine !== attempt) return;
        if (err instanceof PeerBusyError) {
          status = "peerBusy";
          errorKey = "peerBusy";
          return;
        }
        console.error("relayium message connect error", err);
        status = "failed";
        errorKey = "failed";
      }
    },

    async send(body: string): Promise<void> {
      if (status !== "open" || !conn || !keys) return;
      if (textByteLength(body) > TEXT_MAX_BYTES) { errorKey = "tooLong"; return; }
      if ((conn.channel.bufferedAmount ?? 0) > TEXT_SEND_BUFFER_MAX) {
        record({ dir: "out", body, at: deps.now(), failed: true });
        return;
      }
      errorKey = "";
      // 串行。**这是正确性要求，不是整洁**：TextSender.frame 在 await seal 之前就同步
      // 取走了 seq，所以两次并发调用各自拿到不同的 seq，却可能乱序完成，把更大的 seq
      // 先送上线——对端会按乱序硬失败，会话就没了。发送按钮被点两下就够。
      const mine = sendChain.then(async () => {
        const c = conn, k = keys;
        if (status !== "open" || !c || !k) return;
        try {
          const frame = await sender.frame(body, k.textSend);
          c.channel.send(frame);
          record({ dir: "out", body, at: deps.now(), failed: false });
        } catch (err) {
          console.error("relayium message send error", err);
          // 记成失败而不是丢掉：用户以为发出去了、而其实没有，是更坏的结果。
          record({ dir: "out", body, at: deps.now(), failed: true });
        }
      });
      sendChain = mine;
      await mine;
    },

    accept() {
      if (status !== "incomingRequest" || !conn) return;
      try { conn.channel.send(ACCEPT); } catch { /* gone; onclose will finish */ }
      attachInbound(conn);
      status = "open";
      touch();
    },

    reject() {
      if (status !== "incomingRequest" || !conn) return;
      if (peerId) refused.add(peerId);
      try { conn.channel.send(REJECT); } catch { /* gone */ }
      finish("idle");
      status = "idle";
      errorKey = "";
    },

    end() { finish("ended"); },
    clearHistory() { history = []; },
    active,
  };

  function active(): boolean {
    return status === "connecting" || status === "waitingAccept"
      || status === "incomingRequest" || status === "open";
  }
}
