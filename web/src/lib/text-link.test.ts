import { describe, it, expect, vi } from "vitest";
import { isTextOffer, createTextLink } from "./text-link";
import type { InboundSignal } from "./webrtc";

describe("isTextOffer", () => {
  it("accepts a text-generation offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(true);
  });

  // Untagged is the file generation, which listenForIncoming owns. Claiming one
  // here would start a message session on someone else's file transfer.
  it("rejects an untagged offer", () => {
    expect(isTextOffer({ sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // A resume never runs a handshake, so it can never open a message session.
  it("rejects a resume, tagged or not", () => {
    expect(isTextOffer({ resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, resume: true, sdp: { type: "offer", sdp: "v=0" } })).toBe(false);
  });

  // An answer or a candidate belongs to a connection that already exists.
  it("rejects anything that is not an offer", () => {
    expect(isTextOffer({ text: true, sdp: { type: "answer", sdp: "v=0" } })).toBe(false);
    expect(isTextOffer({ text: true, ice: { candidate: "c" } })).toBe(false);
    expect(isTextOffer({ text: true })).toBe(false);
  });

  it("rejects the other piggybacks that share this envelope", () => {
    expect(isTextOffer({ caps: ["text/1"] })).toBe(false);
    expect(isTextOffer({ rename: "Bob" })).toBe(false);
    expect(isTextOffer({ relayRtt: { r1: 9 } })).toBe(false);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 0, "", "text", [], { text: "yes" }, { text: 1 }]) {
      expect(isTextOffer(junk), JSON.stringify(junk) ?? "undefined").toBe(false);
    }
  });
});

function fakeSignaling() {
  const cbs: ((from: string, data: unknown) => void)[] = [];
  const sent: { to: string; data: InboundSignal }[] = [];
  return {
    sent,
    client: {
      onSignal(cb: (from: string, data: unknown) => void) { cbs.push(cb); return () => cbs.splice(cbs.indexOf(cb), 1); },
      sendSignal(to: string, data: unknown) { sent.push({ to, data: data as InboundSignal }); },
    },
    inject(from: string, data: InboundSignal) { cbs.forEach((cb) => cb(from, data)); },
  };
}
const TEXT_OFFER: InboundSignal = { text: true, sdp: { type: "offer", sdp: "v=0" } };

describe("createTextLink listen", () => {
  // 拒绝要发生在**握手之前**：等到会话状态机拿到连接再关掉，等于白跑一次
  // commit-reveal，跨网络上还白占一次 TURN 分配。
  it("does not connect when the session cannot accept, and tells the peer it is busy", () => {
    const sig = fakeSignaling();
    const canAccept = vi.fn(() => false);
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }), canAccept });
    link.listen(() => { throw new Error("must not be handed a connection"); });
    // RTCPeerConnection 没有 stub：真去建连就会抛，所以"没抛"本身也是断言的一部分。
    sig.inject("p2", TEXT_OFFER);
    expect(canAccept).toHaveBeenCalledWith("p2");
    // busy 回包必须带 text 标记，否则发起方按世代把它丢掉，白等 30 秒的 ICE 超时。
    expect(sig.sent).toEqual([{ to: "p2", data: { busy: true, text: true } }]);
  });

  it("does not reply busy to a signal that is not a text offer", () => {
    const sig = fakeSignaling();
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }), canAccept: () => false });
    link.listen(() => {});
    for (const d of [{ sdp: { type: "offer", sdp: "v=0" } }, { caps: ["text/1"] }, { text: true, resume: true, sdp: { type: "offer", sdp: "v=0" } }] as InboundSignal[]) {
      sig.inject("p2", d);
    }
    expect(sig.sent).toEqual([]);
  });

  it("treats a missing canAccept as permission, so nothing existing has to pass one", () => {
    const sig = fakeSignaling();
    const link = createTextLink({ signaling: () => sig.client as never, rtcConfig: () => ({ iceServers: [] }) });
    link.listen(() => {});
    sig.inject("p2", TEXT_OFFER);
    // 没有 canAccept 就不该发 busy——它会去建连（这里必然失败，被 catch 记日志）。
    expect(sig.sent).toEqual([]);
  });
});
