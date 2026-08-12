/**
 * 一份**只读**的观测层，给配对码房间那条真浏览器路径用。
 *
 * 它存在的唯一理由：`code-room.mjs` 里那两句"等工作区头部出来"失败的时候，日志只有
 * 一句"某一边的头部没出来"。那一句话下面至少压着六种完全不同的故障——offer 丢了、
 * answer 丢了、ICE 候选乱序、两条 DataChannel 只开了一条、commit-reveal 只走完一半、
 * 以及链路其实建好了但界面没把它发布出来。它们在 CI 的日志里长得一模一样，所以那条
 * 日志没有指向任何东西。托管 CI 上那次失败很贵：复现要几百轮，而每一轮都只还回同一句话。
 *
 * 这里把六者分开：界面此刻的样子、信令帧（进/出，按世代和种类）、每个
 * RTCPeerConnection 的状态迁移、每条 DataChannel 的建立/开/关/错，以及是谁调用了
 * close。全部只**记录**：`send` 原样转交并原样回传返回值，`onmessage` 原样投递，
 * RTCPeerConnection 的方法一个都没改语义。这里没有任何延时、重试、超时调整或者
 * 备用成功路径——探针在绿的那一次必须一个字节都不产出。
 *
 * 注入顺序上它必须排在 `codeRoomSignalingScript` **后面**：它包的就是那份夹具装上去的
 * `window.WebSocket`。包在真 WebSocket 上会漏掉整条假房间。
 */

/** 一帧信令的**种类**，用于人读的时间线。故意不记内容：SDP 有几千字节，而这里要
 *  回答的问题是"它到底有没有到"，不是"它长什么样"。 */
const FRAME_KIND_SOURCE = `
  (data) => {
    if (!data || typeof data !== "object") return "?";
    const parts = [];
    if (data.sdp) parts.push("sdp:" + data.sdp.type);
    if (data.commit) parts.push("commit");
    if (data.reveal) parts.push("reveal");
    if (data.ice) parts.push("ice");
    if (data.busy) parts.push("busy");
    if (data.leave) parts.push("leave");
    if (data.linkRequest) parts.push("linkRequest");
    if (Array.isArray(data.caps)) parts.push("caps[" + data.caps.join(" ") + "]");
    if (data.relayRtt) parts.push("relayRtt");
    if (data.rename) parts.push("rename");
    return parts.length ? parts.join("+") : "?";
  }
`;

/** 世代标记，和 webrtc-core 的 signalGeneration 一致（这里只读，不共享代码：
 *  产物是打包过的，探针进不去模块作用域）。 */
const GENERATION_SOURCE = `
  (data) => {
    if (!data || typeof data !== "object") return "file";
    if (data.resume) return "resume";
    if (data.link) return "link";
    if (data.text) return "text";
    return "file";
  }
`;

/**
 * 生成探针脚本。
 *
 * @param {object} [opts]
 * @param {number} [opts.max] 每条时间线最多保留多少条。默认 600：一次建连的
 *   信令是个位数到几十条，600 足够放下三幕里最长的一次，又不会让页面攒出一个
 *   永远长大的数组。
 */
export function codeRoomProbeScript({ max = 600 } = {}) {
  return `(() => {
  const MAX = ${Number(max)};
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const kindOf = ${FRAME_KIND_SOURCE};
  const genOf = ${GENERATION_SOURCE};

  const probe = {
    /** 信令帧时间线：{ ms, dir: "out"|"in", peer, gen, kind } */
    sig: [],
    /** 每条 RTCPeerConnection 的一生：{ ms, pc, event, value } */
    rtc: [],
    /** 页面自己说出来的话：console.warn/error，以及每一次 close 的调用栈。 */
    notes: [],
    pcs: 0,
  };
  const push = (list, entry) => { if (list.length < MAX) list.push(entry); };
  window.__e2eProbe = probe;

  /** 装一个**不可枚举**的自有属性。原生的 send/createDataChannel 都在原型上，
   *  所以直接赋值会给对象凭空多出一个可枚举键——那是应用能看见的差别。 */
  const shadow = (target, name, value) => {
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };
  const stackOf = () => new Error("x").stack.split("\\n").slice(2, 6).join(" ⇐ ");

  // ── 页面说出来的话：console.error/warn 原样转发，同时进时间线 ──────────────
  for (const level of ["error", "warn"]) {
    const real = console[level].bind(console);
    console[level] = (...args) => {
      try {
        push(probe.notes, {
          ms: at(),
          text: level + ": " + args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" "),
        });
      } catch { /* 记不下来也不能挡住输出 */ }
      return real(...args);
    };
  }

  // ── 谁在关连接/通道：close 调用带栈，直接指认拆除者 ────────────────────────
  const pcIds = new WeakMap();
  const realPcClose = RTCPeerConnection.prototype.close;
  shadow(RTCPeerConnection.prototype, "close", function (...args) {
    push(probe.notes, { ms: at(), text: "pc" + (pcIds.get(this) ?? "?") + ".close() ← " + stackOf() });
    return realPcClose.apply(this, args);
  });
  if (typeof RTCDataChannel !== "undefined") {
    const realDcClose = RTCDataChannel.prototype.close;
    shadow(RTCDataChannel.prototype, "close", function (...args) {
      push(probe.notes, { ms: at(), text: "dc(" + this.label + ").close() ← " + stackOf() });
      return realDcClose.apply(this, args);
    });
  }

  // ── 信令：包住夹具装上去的那个 WebSocket ────────────────────────────────────
  const PrevWebSocket = window.WebSocket;
  const recordOut = (raw) => {
    try {
      const frame = JSON.parse(raw);
      if (frame && frame.type === "signal") {
        push(probe.sig, { ms: at(), dir: "out", peer: frame.to, gen: genOf(frame.data), kind: kindOf(frame.data) });
      } else if (frame && frame.type) {
        push(probe.sig, { ms: at(), dir: "out", peer: "", gen: "-", kind: frame.type });
      }
    } catch { /* 不是 JSON（二进制帧就不是），照发 */ }
  };
  const recordIn = (event) => {
    try {
      const envelope = JSON.parse(event.data);
      if (envelope && envelope.type === "signal") {
        push(probe.sig, { ms: at(), dir: "in", peer: envelope.from, gen: genOf(envelope.data), kind: kindOf(envelope.data) });
      } else if (envelope && envelope.type) {
        const detail = envelope.type === "peers"
          ? envelope.type + "[" + (envelope.peers || []).map((p) => p.id).join(" ") + "]"
          : envelope.type === "left" ? "left:" + envelope.peer : envelope.type;
        push(probe.sig, { ms: at(), dir: "in", peer: "", gen: "-", kind: detail });
      }
    } catch { /* 记不下来也不能挡住投递 */ }
  };

  function ProbedWebSocket(...args) {
    const sock = new PrevWebSocket(...args);
    if (!sock || typeof sock !== "object") return sock;

    if (typeof sock.send === "function") {
      const realSend = sock.send;
      shadow(sock, "send", function (...sendArgs) {
        recordOut(sendArgs[0]);
        return realSend.apply(sock, sendArgs);
      });
    }

    if (typeof sock.addEventListener === "function") {
      // 真 WebSocket 那一侧：'message' 监听器是**纯附加**的，onmessage 一个字都
      // 不碰。用取值/赋值器截 onmessage 在这里会致命——原生的赋值器在原型上，
      // 自有属性一盖，处理器就再也装不到 socket 上，整条消息投递被吞掉。
      sock.addEventListener("message", recordIn);
    } else if ("onmessage" in sock) {
      // 夹具那一侧：onmessage 是构造函数里赋的普通数据属性，房间靠
      // "this.onmessage && this.onmessage(...)" 投递，没有事件派发可用。
      let assigned = null;
      const wrapper = function (event) {
        recordIn(event);
        return assigned.apply(this, arguments);
      };
      Object.defineProperty(sock, "onmessage", {
        configurable: true,
        enumerable: true,
        // 装了处理器就返回包过的那个（否则投递不会经过这里），没装就如实返回
        // 原值，让 "this.onmessage &&" 这种判断保持原来的答案。
        get: () => (typeof assigned === "function" ? wrapper : assigned),
        set: (fn) => { assigned = fn; },
      });
    }
    return sock;
  }
  // 原型和整个静态面都照搬：instanceof 的答案和包之前逐字一样，CONNECTING/OPEN
  // 之类的常量（以及将来任何一个静态属性）都还在。
  ProbedWebSocket.prototype = PrevWebSocket.prototype;
  Object.setPrototypeOf(ProbedWebSocket, PrevWebSocket);
  window.WebSocket = ProbedWebSocket;

  // ── 传输：每个 pc 的状态迁移和每条通道的开合 ────────────────────────────────
  const RealPC = window.RTCPeerConnection;
  function ProbedPC(...args) {
    const pc = new RealPC(...args);
    const id = ++probe.pcs;
    pcIds.set(pc, id);
    const log = (event, value) => push(probe.rtc, { ms: at(), pc: id, event, value: String(value) });
    log("new", (args[0] && args[0].iceTransportPolicy) || "all");
    pc.addEventListener("connectionstatechange", () => log("conn", pc.connectionState));
    pc.addEventListener("iceconnectionstatechange", () => log("ice", pc.iceConnectionState));
    pc.addEventListener("icegatheringstatechange", () => log("gather", pc.iceGatheringState));
    pc.addEventListener("signalingstatechange", () => log("signal", pc.signalingState));
    const watch = (ch, origin) => {
      log("channel:" + origin, ch.label + ":" + ch.readyState);
      ch.addEventListener("open", () => log("channel-open", ch.label));
      ch.addEventListener("close", () => log("channel-close", ch.label));
      ch.addEventListener("error", () => log("channel-error", ch.label));
    };
    const realCreate = pc.createDataChannel;
    shadow(pc, "createDataChannel", function (...createArgs) {
      const ch = realCreate.apply(pc, createArgs);
      watch(ch, "local");
      return ch;
    });
    pc.addEventListener("datachannel", (ev) => watch(ev.channel, "remote"));
    return pc;
  }
  ProbedPC.prototype = RealPC.prototype;
  Object.setPrototypeOf(ProbedPC, RealPC);
  window.RTCPeerConnection = ProbedPC;
})();`;
}

/** 页面这一刻**在界面上**是什么样。信令/传输的时间线回答"连上了没有"，这一份回答
 *  "连上了却没画出来"——两者分开正是这个探针存在的理由。 */
export const DIAGNOSE = `(() => {
  const head = document.querySelector('.workspace-head');
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  return {
    heads: document.querySelectorAll('.workspace-head').length,
    sas: text('.workspace-head .sas code'),
    state: text('.workspace-head .wh-state'),
    warns: [...document.querySelectorAll('.workspace-head .wh-warn')].map((n) => n.textContent.trim()),
    restart: document.querySelectorAll('.workspace-head .wh-restart').length,
    peers: document.querySelectorAll('.peers').length,
    peerNames: [...document.querySelectorAll('.pname')].map((n) => n.textContent.trim()),
    openWorkspace: document.querySelectorAll('.open-workspace').length,
    composer: document.querySelectorAll('.msgpanel textarea').length,
    consent: document.querySelectorAll('.msgpanel .req').length,
    request: document.querySelectorAll('.request').length,
    hash: location.hash,
    selfId: window.__e2eSelfId ?? '',
    head: !!head,
  };
})()`;

/** 把一个标签页的时间线折成人能读的几行。 */
export async function dumpTab(tab, who) {
  const [probe, view] = await Promise.all([
    tab.evaluate("({ sig: window.__e2eProbe?.sig ?? [], rtc: window.__e2eProbe?.rtc ?? [], notes: window.__e2eProbe?.notes ?? [] })"),
    tab.evaluate(DIAGNOSE),
  ]);
  const lines = [`  ── ${who} (${view.selfId}) ──`, `     ui: ${JSON.stringify(view)}`];
  lines.push("     signalling:");
  for (const s of probe.sig) {
    lines.push(`       ${String(s.ms).padStart(6)}ms ${s.dir === "out" ? "→" : "←"} ${s.peer || "room"} [${s.gen}] ${s.kind}`);
  }
  lines.push("     transport:");
  for (const r of probe.rtc) lines.push(`       ${String(r.ms).padStart(6)}ms pc${r.pc} ${r.event}=${r.value}`);
  if (probe.notes.length) {
    lines.push("     notes:");
    for (const n of probe.notes) lines.push(`       ${String(n.ms).padStart(6)}ms ${n.text}`);
  }
  return lines.join("\n");
}

/**
 * 跑一段断言，失败就把**两边**的时间线一起附到那个错误上再原样抛出去。
 *
 * 两边一起打是重点：一条丢掉的 offer 在发方那里是"发出去了"，在收方那里是"没有"，
 * 只看一边的日志永远说不清是丢了还是没发。
 *
 * 通过的那一次这里什么都不做：一次 evaluate 都不发，一行都不打印。
 */
export async function withTimelines(tabs, run) {
  try {
    await run();
  } catch (err) {
    const dumps = [];
    for (const [who, tab] of tabs) {
      try { dumps.push(await dumpTab(tab, who)); }
      catch (dumpErr) { dumps.push(`  ── ${who} ── (unreadable: ${dumpErr?.message ?? dumpErr})`); }
    }
    // 抛回**同一个**错误对象：调用方的 stack 仍然指向失败的那一行断言。
    err.message = `${err.message}\n${dumps.join("\n")}`;
    throw err;
  }
}
