// 房间里哪些对端说过自己能开消息会话。
//
// 这条声明走的是**名册层**，不是某条连接的 SDP，原因是老版本对端：
// listenForIncoming 对**任何**入站 offer 都会开始收文件（transfer-session.svelte.ts），
// 所以一条为消息而建的连接，在跑着旧版本的对端看来就是一次"manifest 永远不来"的文件
// 传输——它会一直等，然后被 45 秒的停滞看门狗判失败。跟着那条连接的 SDP 一起到达的
// capability 来得太晚，挡不住它本来要挡的事。
//
// 传输方式就是 relay-RTT 表已经在用的那种裸 signal 帧（App.svelte 的 broadcastRelayRtt），
// WebRTC 那几个处理器不认识它就会忽略。**没声明就是不支持**：一个从不声明的对端永远
// 不会被邀请开消息会话。
//
// 它是一个**提示**，不是安全输入。信令中继看得见每一帧，可以删掉它（消息功能被禁用
// ——纯拒绝服务），也可以伪造它（我们向一个开不了会话的对端发起邀请——同样是拒绝服务）。
// 它永远不可能让明文被发出去：消息密钥是**派生**出来的，不是协商出来的，所以不存在
// "降级成不加密"这条路径。能改写信令的攻击者本来就能直接让连接建不起来。

/** The one capability this version advertises. Versioned so a later, wire-
 *  incompatible message format can be introduced without ambiguity. */
export const CAP_TEXT = "text/1";
/** Unified two-lane Web link. Defined before it is advertised so the coordinator
 *  and compatibility tests can land without exposing a half-built protocol. */
export const CAP_LINK = "link/1";

let announced = $state<Record<string, string[]>>({});

/** The frame we send to each peer on joining a room and on roster change.
 *  A fresh array each call: the caller must not be able to mutate what we
 *  advertise to the next peer. */
export function capsSignal(): { caps: string[] } {
  return { caps: [CAP_TEXT] };
}

/**
 * Record a peer's announcement.
 *
 * Returns true if this frame **was** a caps hello, so a caller can tell it apart
 * from the other piggybacks that share this envelope (relayRtt, rename).
 *
 * Peer-authored input on an untrusted channel: anything malformed is recorded as
 * "no capabilities" rather than thrown, because throwing here would land in the
 * signalling dispatch loop. A non-array `caps` is not a hello at all — that is a
 * frame we do not understand, not a peer with no capabilities.
 */
export function recordPeerCaps(peerId: string, data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const caps = (data as { caps?: unknown }).caps;
  if (caps === undefined || !Array.isArray(caps)) return false;
  announced = { ...announced, [peerId]: caps.filter((c): c is string => typeof c === "string") };
  return true;
}

/** Exact match, deliberately: "text/2" is a different wire and must not be
 *  read as this one. */
export function peerSupportsText(peerId: string): boolean {
  return (announced[peerId] ?? []).includes(CAP_TEXT);
}

/** Exact match; callers must never infer link support from text/1. */
export function peerSupportsLink(peerId: string): boolean {
  return (announced[peerId] ?? []).includes(CAP_LINK);
}

/** Drop announcements for peers no longer in the roster. A reconnecting peer is
 *  issued a fresh id by the server, so nothing stale can be inherited by the new
 *  connection — but a departed peer's entry would otherwise leak for the life of
 *  the page. */
export function retainPeers(ids: string[]): void {
  const keep = new Set(ids);
  const next: Record<string, string[]> = {};
  for (const [id, caps] of Object.entries(announced)) if (keep.has(id)) next[id] = caps;
  announced = next;
}

/** Clear everything: a room switch, and the test seam. */
export function resetPeerCaps(): void {
  announced = {};
}
