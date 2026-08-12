import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { codeRoomProbeScript, dumpTab, withTimelines } from "./code-room-probe.mjs";

/**
 * 这套用例把探针**装进一个真的 JS 领域里跑**，而不是去比对它的源码字符串。
 *
 * 理由很直接：这个探针唯一的产品契约是"我什么都不改"。一条只断言 `toContain("send")`
 * 的用例，在探针把 `send` 的载荷改坏、把 `onmessage` 的投递吞掉、或者把某个静态属性
 * 藏起来的时候，全都是绿的。所以下面每一条都真的建一条假 socket / 假 pc，走一遍
 * 应用会走的调用，然后同时问两件事：**应用看到的行为一模一样**，而且**时间线记下了
 * 这一步**。
 */

/** 假的浏览器面：两种 socket 形状各一份——夹具那种普通对象（`onmessage` 是自有数据
 *  属性、没有 addEventListener），和真 WebSocket 那种（原型上的取值/赋值器 + 事件
 *  派发）。探针必须在两种形状上都既记得下来、又不吞投递。 */
const FAKE_BROWSER = `
  globalThis.consoleCalls = [];
  globalThis.console = {
    error: (...args) => { consoleCalls.push(["error", args]); return "real-error"; },
    warn: (...args) => { consoleCalls.push(["warn", args]); return "real-warn"; },
  };

  class PlainSocket {
    constructor(url) { this.url = url; this.sent = []; this.onmessage = null; this.closed = false; }
    send(raw) { this.sent.push(raw); return "sent:" + raw.length; }
    close() { this.closed = true; }
    deliver(envelope) { this.onmessage && this.onmessage({ data: JSON.stringify(envelope) }); }
  }

  class RealishSocket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = []; this.handler = null; this.closed = false; }
    get onmessage() { return this.handler; }
    set onmessage(fn) { this.handler = fn; }
    addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); }
    send(raw) { this.sent.push(raw); return "sent:" + raw.length; }
    close() { this.closed = true; }
    deliver(envelope) {
      const event = { data: JSON.stringify(envelope) };
      for (const fn of this.listeners) fn(event);
      this.handler && this.handler(event);
    }
  }

  function FakeWebSocket(url, protocols) {
    return url.includes("realish") ? new RealishSocket(url) : new PlainSocket(url);
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  FakeWebSocket.MARK = "ws-static";

  class FakeChannel {
    constructor(label) { this.label = label; this.readyState = "connecting"; this.listeners = {}; this.closes = 0; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
    close() { this.closes++; return "closed:" + this.label; }
  }

  class FakePC {
    constructor(config) {
      this.config = config;
      this.connectionState = "new"; this.iceConnectionState = "new";
      this.iceGatheringState = "new"; this.signalingState = "stable";
      this.listeners = {}; this.made = []; this.closes = 0;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event) { for (const fn of this.listeners[type] || []) fn(event ?? { type }); }
    createDataChannel(label, options) {
      const channel = new FakeChannel(label);
      this.made.push({ label, options, channel });
      return channel;
    }
    close() { this.closes++; return "pc-closed"; }
  }
  FakePC.MARK = "pc-static";

  globalThis.RTCDataChannel = FakeChannel;
  globalThis.RTCPeerConnection = FakePC;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = { WebSocket: FakeWebSocket, RTCPeerConnection: FakePC };
  globalThis.FakeChannel = FakeChannel;
  globalThis.PlainSocket = PlainSocket;
  // 探针**之前**那一层，用来问"包完之后还是不是同一个可观察面"。
  globalThis.PrevWebSocket = FakeWebSocket;
  globalThis.PrevPC = FakePC;
`;

/** 装好探针的一个领域。返回的 `window` 就是应用眼里的那个 window。 */
function installedProbe(options) {
  const context = createContext({});
  runInContext(FAKE_BROWSER, context);
  runInContext(codeRoomProbeScript(options), context);
  return context;
}

const timeline = (context) => context.window.__e2eProbe;

describe("the code-room probe leaves the page's behaviour alone", () => {
  it("hands the signalling socket the exact bytes the app sent, and its return value back", () => {
    const context = installedProbe();
    const socket = new context.window.WebSocket("wss://host/ws?code=483920");
    const raw = JSON.stringify({ type: "signal", to: "bbbb2222", data: { sdp: { type: "offer" } } });

    const returned = socket.send(raw);

    expect(socket.sent).toEqual([raw]);
    expect(returned).toBe(`sent:${raw.length}`);
    expect(timeline(context).sig).toEqual([
      expect.objectContaining({ dir: "out", peer: "bbbb2222", gen: "file", kind: "sdp:offer" }),
    ]);
  });

  it("still delivers messages to a fixture-shaped socket whose onmessage is a plain property", () => {
    const context = installedProbe();
    const socket = new context.window.WebSocket("wss://host/ws?code=483920");
    const seen = [];
    socket.onmessage = (event) => { seen.push(event.data); return "app-return"; };

    socket.deliver({ type: "signal", from: "aaaa1111", data: { reveal: "x" } });

    expect(seen).toEqual([JSON.stringify({ type: "signal", from: "aaaa1111", data: { reveal: "x" } })]);
    expect(timeline(context).sig).toEqual([
      expect.objectContaining({ dir: "in", peer: "aaaa1111", kind: "reveal" }),
    ]);
  });

  it("still delivers messages to a real-WebSocket-shaped socket instead of swallowing them", () => {
    const context = installedProbe();
    const socket = new context.window.WebSocket("wss://host/realish");
    const seen = [];
    socket.onmessage = (event) => seen.push(event.data);

    socket.deliver({ type: "peers", peers: [{ id: "aaaa1111" }] });

    expect(seen).toHaveLength(1);
    expect(timeline(context).sig).toEqual([
      expect.objectContaining({ dir: "in", kind: "peers[aaaa1111]" }),
    ]);
  });

  it("keeps a handler the app can read back, and lets it be cleared", () => {
    const context = installedProbe();
    const socket = new context.window.WebSocket("wss://host/ws?code=483920");
    expect(socket.onmessage).toBe(null);

    socket.onmessage = () => {};
    expect(socket.onmessage).toBeTruthy();

    socket.onmessage = null;
    expect(socket.onmessage).toBeFalsy();
    expect(() => socket.deliver({ type: "peers", peers: [] })).not.toThrow();
  });

  it("keeps the WebSocket constructor's prototype and every static the app may read", () => {
    const context = installedProbe();
    const socket = new context.window.WebSocket("wss://host/ws?code=483920");

    // 包过之后 `instanceof` 的答案必须和包之前**逐字**一样，socket 自己的原型链
    // 一个环都不能动。
    expect(context.window.WebSocket.prototype).toBe(context.PrevWebSocket.prototype);
    expect(Object.getPrototypeOf(socket)).toBe(context.PlainSocket.prototype);
    expect(context.window.WebSocket.OPEN).toBe(1);
    expect(context.window.WebSocket.CLOSED).toBe(3);
    // 静态面必须整份继承，不能只搬那四个常量：应用（或将来的夹具）读到的任何一个
    // 静态属性，包过之后都得还在。
    expect(context.window.WebSocket.MARK).toBe("ws-static");
  });

  it("does not add enumerable properties to a socket the app may iterate", () => {
    const context = installedProbe();
    const bare = new context.PlainSocket("wss://host/ws?code=483920");
    const probed = new context.window.WebSocket("wss://host/ws?code=483920");

    expect(Object.keys(probed)).toEqual(Object.keys(bare));
  });

  it("keeps the RTCPeerConnection constructor's prototype, instanceof and statics", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection({ iceTransportPolicy: "relay" });

    expect(pc instanceof context.window.RTCPeerConnection).toBe(true);
    expect(context.window.RTCPeerConnection.prototype).toBe(context.PrevPC.prototype);
    expect(context.window.RTCPeerConnection.MARK).toBe("pc-static");
    expect(timeline(context).rtc).toEqual([
      expect.objectContaining({ pc: 1, event: "new", value: "relay" }),
    ]);
  });

  it("survives a peer connection built with no configuration at all", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection();

    expect(pc.config).toBe(undefined);
    expect(timeline(context).rtc[0]).toEqual(expect.objectContaining({ event: "new", value: "all" }));
  });

  it("records connection state transitions without touching them", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection({});
    pc.connectionState = "connected";
    pc.iceConnectionState = "checking";

    pc.emit("connectionstatechange");
    pc.emit("iceconnectionstatechange");

    expect(timeline(context).rtc.map((r) => `${r.event}=${r.value}`)).toEqual([
      "new=all", "conn=connected", "ice=checking",
    ]);
  });

  it("returns the real DataChannel from createDataChannel and watches its whole life", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection({});

    const channel = pc.createDataChannel("relayium-text", { ordered: true });

    expect(channel).toBe(pc.made[0].channel);
    expect(pc.made[0].options).toEqual({ ordered: true });

    channel.emit("open");
    channel.emit("error");
    channel.emit("close");
    expect(timeline(context).rtc.map((r) => r.event)).toEqual([
      "new", "channel:local", "channel-open", "channel-error", "channel-close",
    ]);
  });

  it("watches a remotely opened channel too", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection({});
    const channel = new context.FakeChannel("relayium-file");

    pc.emit("datachannel", { channel });
    channel.emit("open");

    expect(timeline(context).rtc.map((r) => r.event)).toEqual(["new", "channel:remote", "channel-open"]);
  });

  it("names who closed a pc or a channel, and still closes it", () => {
    const context = installedProbe();
    const pc = new context.window.RTCPeerConnection({});
    const channel = pc.createDataChannel("relayium-text");

    const pcResult = pc.close();
    const channelResult = channel.close();

    expect(pc.closes).toBe(1);
    expect(channel.closes).toBe(1);
    expect(pcResult).toBe("pc-closed");
    expect(channelResult).toBe("closed:relayium-text");
    const notes = timeline(context).notes.map((n) => n.text);
    expect(notes.some((t) => t.startsWith("pc1.close()"))).toBe(true);
    expect(notes.some((t) => t.startsWith("dc(relayium-text).close()"))).toBe(true);
  });

  it("forwards console.warn and console.error while recording them", () => {
    const context = installedProbe();

    const returned = context.console.error("boom", 42);
    context.console.warn("careful");

    expect(returned).toBe("real-error");
    expect(context.consoleCalls).toEqual([["error", ["boom", 42]], ["warn", ["careful"]]]);
    expect(timeline(context).notes.map((n) => n.text)).toEqual(["error: boom 42", "warn: careful"]);
  });

  it("never stalls the page: unknown options cannot buy a delay", () => {
    // 复现脚本里那个"钉住主线程"的旋钮**不在**这份可维护探针里。它是个诊断期的
    // 交错制造器，不是观测；留着它，一次误传的选项就能把真实运行改成另一回事。
    const context = installedProbe({ stallMs: 400, stallLabel: "relayium-text" });
    const pc = new context.window.RTCPeerConnection({});

    const started = Date.now();
    pc.emit("datachannel", { channel: new context.FakeChannel("relayium-text") });

    expect(Date.now() - started).toBeLessThan(100);
  });

  it("stops growing its timelines at the cap instead of holding the page's memory forever", () => {
    const context = installedProbe({ max: 3 });
    const pc = new context.window.RTCPeerConnection({});
    for (let i = 0; i < 20; i++) pc.emit("connectionstatechange");

    expect(timeline(context).rtc).toHaveLength(3);
  });
});

/** dumpTab / withTimelines 用的假标签页：两条 evaluate 按表达式分辨。 */
function fakeTab({ probe = {}, view = {}, failOn = null } = {}) {
  return {
    evaluate: vi.fn(async (expression) => {
      if (failOn && expression.includes(failOn)) throw new Error("page stopped responding");
      if (expression.includes("__e2eProbe")) {
        return { sig: probe.sig ?? [], rtc: probe.rtc ?? [], notes: probe.notes ?? [] };
      }
      return { selfId: "aaaa1111", heads: 0, ...view };
    }),
  };
}

describe("dumpTab", () => {
  it("folds one tab's ui, signalling, transport and notes into readable lines", async () => {
    const tab = fakeTab({
      probe: {
        sig: [{ ms: 12, dir: "out", peer: "bbbb2222", gen: "file", kind: "sdp:offer" }],
        rtc: [{ ms: 30, pc: 1, event: "conn", value: "connected" }],
        notes: [{ ms: 40, text: "pc1.close() ← somewhere" }],
      },
      view: { heads: 1 },
    });

    const dump = await dumpTab(tab, "tab A");

    expect(dump).toContain("── tab A (aaaa1111) ──");
    expect(dump).toContain('"heads":1');
    expect(dump).toContain("12ms → bbbb2222 [file] sdp:offer");
    expect(dump).toContain("30ms pc1 conn=connected");
    expect(dump).toContain("40ms pc1.close() ← somewhere");
  });

  it("leaves the notes section out when the page had nothing to say", async () => {
    const dump = await dumpTab(fakeTab(), "tab B");
    expect(dump).not.toContain("notes:");
  });
});

describe("withTimelines", () => {
  it("costs a passing run nothing at all: no evaluate, no output", async () => {
    const tabs = [["tab A", fakeTab()], ["tab B", fakeTab()]];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await withTimelines(tabs, async () => "fine");

      for (const [, tab] of tabs) expect(tab.evaluate).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("rethrows the original failure after dumping both tabs", async () => {
    const a = fakeTab({ probe: { sig: [{ ms: 1, dir: "out", peer: "bbbb2222", gen: "file", kind: "sdp:offer" }] } });
    const b = fakeTab({ probe: { sig: [] } });
    const boom = new Error("timed out waiting for tab B's unified workspace header");

    const thrown = await withTimelines([["tab A", a], ["tab B", b]], async () => { throw boom; })
      .then(() => null, (err) => err);

    // 抛出来的必须是**同一个**错误对象：调用方靠它的 stack 找到失败的那一行。
    expect(thrown).toBe(boom);
    expect(thrown.message).toContain("timed out waiting for tab B's unified workspace header");
    expect(thrown.message).toContain("── tab A (aaaa1111) ──");
    expect(thrown.message).toContain("── tab B (aaaa1111) ──");
    expect(thrown.message).toContain("1ms → bbbb2222 [file] sdp:offer");
    expect(a.evaluate).toHaveBeenCalled();
    expect(b.evaluate).toHaveBeenCalled();
  });

  it("still reports the other tab when one of them cannot be read", async () => {
    const a = fakeTab({ failOn: "__e2eProbe" });
    const b = fakeTab({ probe: { rtc: [{ ms: 5, pc: 1, event: "conn", value: "failed" }] } });

    const thrown = await withTimelines([["tab A", a], ["tab B", b]], async () => { throw new Error("nope"); })
      .then(() => null, (err) => err);

    expect(thrown.message).toContain("── tab A ── (unreadable: page stopped responding)");
    expect(thrown.message).toContain("5ms pc1 conn=failed");
  });
});
