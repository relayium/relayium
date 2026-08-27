// Pure conversation model contracts and limits, shared by the link's text lane
// and the panel that renders it.
//
// These used to live in `text-session.svelte.ts` beside the legacy text lane.
// That lane is gone — a conversation now only ever rides an authenticated
// `link/1` transport — but the limits and the message/status shapes are what
// `mixed-text-session.svelte.ts` and `MessagePanel.svelte` both speak. Kept as a
// module with no reactive state so the panel can import the shape of a message
// without importing a state machine.

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
 * No traffic either way for this long and the conversation's lane ends.
 *
 * 这是一条**成本**约束，不是安全约束。跨网络那条路强制 iceTransportPolicy: "relay"，
 * 所以一条挂着不动的会话会一直占着一个 TURN allocation；而 TURN 凭据的 TTL 本来就是
 * 一小时（server 的 TURNCredTTL），会话活得比它久也没有意义。
 *
 * On a link this bounds the LANE, not the transport: ending a conversation
 * never closes the DataChannel the file lane is sharing. The link's own
 * inactivity close (`MIXED_LINK_IDLE_MS`) is what bounds the transport.
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
