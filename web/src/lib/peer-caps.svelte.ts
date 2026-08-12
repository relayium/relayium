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

import { CAP_PREUPLOAD } from "./preupload-handoff";

/** The one capability this version advertises. Versioned so a later, wire-
 *  incompatible message format can be introduced without ambiguity. */
export const CAP_TEXT = "text/1";
/** Unified two-lane Web link: one authenticated connection carrying an ordered
 *  file lane and an ordered text lane. Versioned for the same reason text/1 is. */
export const CAP_LINK = "link/1";

/** Pre-upload key handoff (DataChannel frame kind 12). Re-exported from the
 *  codec that owns it so the announcement and the frame it promises cannot
 *  drift apart in two files. */
export { CAP_PREUPLOAD };

/**
 * Whether this BUILD implements link/1 at all.
 *
 * A plain constant, deliberately. It used to be a build-time Vite environment
 * substitution, which made "does the shipped bundle speak this protocol?"
 * depend on a variable somebody had to remember to set — a release could
 * silently go out without it, and the E2E that proved the path needed its own
 * separate bundle that no deployment ever ran. What a build can implement is a
 * property of the source, so it is written in the source.
 *
 * It is not a switch. There is no setter, no query parameter and no stored
 * setting: a page script, a relay or a user cannot reach it. What a build
 * implements and what it is allowed to use are still two named things — see
 * linkRoomActive below — even though every room now allows it.
 */
export const LINK_BUILD_SUPPORT = true;

/**
 * Whether link/1 may be advertised and routed at all right now.
 *
 * Every room, LAN and pairing-code alike. It used to be the code-less LAN room
 * only, while a relayed link's TURN allocation lifetime, quota accounting and
 * mobile-background cost got their own acceptance. They have it now: a relayed
 * link derives a bounded, clock-skew-safe lifetime from the credential the
 * server issued (relay-deadline.ts) and reaches a truthful terminal state at it,
 * and the ten-minute inactive close (MIXED_LINK_IDLE_MS) still bounds a link
 * nobody is using. See DECISION-LOG "Promote the unified Web workspace to
 * pairing rooms with a bounded relay lifecycle" (2026-08-10), which supersedes
 * the LAN-only scope of 2026-08-04.
 *
 * What did NOT move with it is the exactness of the capability: a peer that does
 * not announce this precise version is still legacy, in every room, and is never
 * probed with a two-channel offer it would misread. That rule is peerSupportsLink
 * below, and it is the whole downgrade boundary now.
 *
 * Kept as a named predicate rather than inlined so there is still exactly ONE
 * expression the announcement and the routing rule both read; a future scope
 * (a room kind, a build) has one place to live and cannot be applied to the
 * announcement while the router forgets it.
 */
export function linkRoomActive(): boolean {
  return LINK_BUILD_SUPPORT;
}

/** What this build announces, at the roster level and (via localCaps) in its
 *  SDP confirmation. One expression for both, so the two announcements cannot
 *  disagree — and so neither can disagree with the routing rule below, which
 *  reads the same predicate. */
export function advertisedCaps(): readonly string[] {
  // preupload/1 rides with link/1 and can never be announced without it: the
  // handoff frame travels on the LINK's file channel, so a build (or a scope)
  // that cannot open a link has no way to deliver the keys it would be promising.
  return linkRoomActive() ? [CAP_TEXT, CAP_LINK, CAP_PREUPLOAD] : [CAP_TEXT];
}

/** What each peer in the room has told us it supports. Reactive: the peer cards
 *  re-render when a hello arrives. */
let announced = $state<Record<string, string[]>>({});

/** The frame we send to each peer on joining a room and on roster change.
 *  A fresh array each call: the caller must not be able to mutate what we
 *  advertise to the next peer. */
export function capsSignal(): { caps: string[] } {
  return { caps: [...advertisedCaps()] };
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

/**
 * Whether this peer has announced AT ALL — the third state the predicates below
 * deliberately do not have.
 *
 * Every `peerSupportsX` here answers a two-valued question, because for the
 * things they gate that is the right shape: not announcing `text/1` and
 * announcing `text/2` both mean "do not offer this peer a message session", and
 * the cost of being wrong for one roster tick is an offer not made. Nothing is
 * destroyed by guessing "no" early.
 *
 * `preupload/1` is the one capability where that is false. The "no" branch there
 * returns already-uploaded ciphertext to the live lane and discards the only
 * keys that could ever open it (outbox' `releaseUploaded`), so a "no" said
 * before the hello has had time to arrive is not a cheap guess — it is the
 * handoff, spent. This separates "the peer said no" from "the peer has not said
 * anything yet" so the one caller that must tell them apart can.
 *
 * It is about the ROSTER announcement only, exactly like the predicates above,
 * and it is pruned by `retainPeers` with everything else. A caller that needs an
 * answer to survive a roster prune has to remember it (handoff-lane.svelte.ts
 * does, and says why).
 */
export function peerCapsKnown(peerId: string): boolean {
  return announced[peerId] !== undefined;
}

/** Exact match, deliberately: "text/2" is a different wire and must not be
 *  read as this one. */
export function peerSupportsText(peerId: string): boolean {
  return (announced[peerId] ?? []).includes(CAP_TEXT);
}

/**
 * Exact match; callers must never infer link support from text/1.
 *
 * "Exact" is the load-bearing word and the only downgrade boundary left. An
 * older Web peer, a native client or the CLI announces `text/1` and nothing
 * else, and `listenForIncoming` on such a peer starts receiving FILES from any
 * inbound offer — so a speculative two-channel offer to it becomes a transfer
 * whose manifest never arrives, and it waits out a stall watchdog. `link/2`, a
 * capitalised variant or a peer that never announced are all equally not this
 * protocol.
 *
 * Enforced HERE, not only at the announcement, because this is the predicate
 * every routing decision reads (peer-workspace's `routes`, the manager's inbound
 * request/offer guards, `ensure`). The scope check stays in front of the
 * membership test for the same reason it always did: one place decides, so a
 * later scope cannot be applied to what we say and forgotten in what we route.
 */
export function peerSupportsLink(peerId: string): boolean {
  if (!linkRoomActive()) return false;
  return (announced[peerId] ?? []).includes(CAP_LINK);
}

/**
 * Exact match, and never inferred from link/1.
 *
 * This is the one gate on frame kind 12. An unknown kind is a HARD ERROR in
 * every implementation, so a speculative handoff does not degrade to the live
 * link — it kills the whole transfer on a frame the peer cannot parse. Native
 * clients and the CLI announce `text/1` (and, for a current Web peer, `link/1`)
 * and nothing else, so they take the ordinary live-link path and are never sent
 * one. `preupload/2` is a different wire and must not be read as this one.
 *
 * Gated on `linkRoomActive()` in front of the membership test for the same
 * reason peerSupportsLink is: the frame has no transport without a link, so one
 * predicate decides both what we announce and what we route.
 */
export function peerSupportsPreupload(peerId: string): boolean {
  if (!linkRoomActive()) return false;
  return (announced[peerId] ?? []).includes(CAP_PREUPLOAD);
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
