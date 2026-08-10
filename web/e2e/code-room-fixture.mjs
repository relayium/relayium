/**
 * 让两个真标签页真的处在**同一个配对码房间**里的那份夹具。
 *
 * 为什么需要它：`/api/pair` 铸一个跨网络配对码要一个登录且验证过的账号，服务器的 ws
 * 路由又会拒掉任何没被铸出来的码。所以 CDP harness 没法加入一个**真**的配对码房间
 * ——这条限制在 `web/e2e/README.md` 里写着，也正是"配对码房间的策略"过去只有确定性
 * 单元用例覆盖的原因。
 *
 * 现在这条路由不再是"拒绝"，而是"和 LAN 一样开统一工作区"，所以它需要一次真浏览器
 * 的证明。这份夹具给的就是那个：
 *
 *  - **信令**：把 `window.WebSocket` 换成一条 BroadcastChannel 上的假房间。协议按
 *    `docs/protocol/relayium-signaling-v1.md` 复刻 join/welcome/peers/signal/left
 *    这五帧——**只**复刻这五帧。它不是服务器的替身，它是一台会合机。
 *  - **ICE**：`/api/ice` 返回一份**空**的 iceServers。空表示 `chooseRtcConfig` 不会
 *    强制 relay-only，于是两个标签页用 host 候选在环回上直连。
 *
 * 由此而来的、必须说清楚的**局限**：这条路径上没有 TURN，所以中继凭据的有效期边界
 * （relay-deadline.ts / mixed-session 的 warn+terminal 计时器）在这里**一次都没有跑
 * 到**。那一半是确定性覆盖的（`src/lib/relay-deadline.test.ts`、
 * `src/lib/mixed-link-lifecycle.test.ts`），而且只能是确定性覆盖的：真浏览器没有办法
 * 按需让一份 TURN 凭据在中途过期。这里证明的是**路由与界面**：配对码房间里的两个
 * 升级过的对端真的开出了统一工作区，一条链路一个 SAS，文本和文件走同一条连接。
 *
 * 页面本身是**原样的构建产物**，跑的是原样的策略。被换掉的只有页面外面的两样东西
 * ——会合服务和 ICE 下发——它们本来就是服务器的职责。产品里没有因此多出任何开关。
 */

/** 房间协议里这份夹具认识的全部帧。多一帧都没有。 */
const CHANNEL = "relayium-e2e-code-room";

/**
 * 生成注入脚本。
 *
 * @param {object} opts
 * @param {string} opts.selfId 这个标签页在房间里的 peer id。**显式**传入而不是随机：
 *   initiator/responder 是按 `selfId < peerId` 定的，随机 id 会让每次运行的角色分配
 *   不同——一个只在某一半角色上出现的回归就会变成偶发红。
 * @param {string} [opts.name] 名册里显示的设备名（服务器同样是从 join 帧里取的）。
 */
export function codeRoomSignalingScript({ selfId, name }) {
  return `(() => {
  const CHANNEL = ${JSON.stringify(CHANNEL)};
  const SELF_ID = ${JSON.stringify(selfId)};
  const SELF_NAME = ${JSON.stringify(name ?? selfId)};
  const RealWebSocket = window.WebSocket;

  // 只接管信令那一条。别的 WebSocket（现在没有，将来可能有）照走真实现。
  const isSignaling = (url) => {
    try { return new URL(url, location.href).pathname === "/ws"; } catch { return false; }
  };
  const roomOf = (url) => {
    try { return new URL(url, location.href).searchParams.get("code") || ""; } catch { return ""; }
  };

  // 这个标签页的信令是不是被**单独**掐掉了。掐掉之后连不回来，这一点是有意的：
  // 真实世界里那台机器的 WebSocket 断了，服务器会给它发一个新的 peer id，旧的那个
  // 就永远回不来了。让它在夹具里"用同一个 id 重连"会把这条用例变成另一回事。
  let signalingDropped = false;
  const liveSockets = new Set();

  /** 一条永远连不上的 socket。App 的重连尝试落在这里，安静地什么都不发生。 */
  class DeadSignalingSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0; // CONNECTING，永远
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
    }
    send() { /* 发不出去 */ }
    close() { this.readyState = 3; }
  }

  class FakeSignalingSocket {
    constructor(url) {
      this.url = String(url);
      this.room = roomOf(this.url);
      this.readyState = 0; // CONNECTING
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      // name → peer，只在这个房间里。名册每次变化都整份重发，和服务器一样。
      this.peers = new Map();
      this.chan = new BroadcastChannel(CHANNEL);
      this.chan.onmessage = (e) => this.receive(e.data);
      // 异步 open：真 WebSocket 不会在构造函数里同步回调，而 SignalingClient 正是
      // 在 onopen 里发 join 帧的。同步触发会让它在 onopen 被赋值之前就跑掉。
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.onopen && this.onopen();
      }, 0);
      liveSockets.add(this);
      window.addEventListener("pagehide", () => this.close());
    }

    /** 页面 → 房间。SignalingClient 只发 join / signal / activate 三种。 */
    send(raw) {
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }
      if (frame.type === "join") {
        this.name = frame.name || SELF_NAME;
        // welcome 先到，页面才知道自己的 id（角色和 SAS 都要用它）。
        this.deliver({ type: "welcome", name: SELF_ID, ip: "127.0.0.1" });
        this.deliver({ type: "peers", peers: [...this.peers.values()] });
        this.post({ t: "join", room: this.room, id: SELF_ID, name: this.name });
        return;
      }
      if (frame.type === "signal") {
        this.post({ t: "sig", room: this.room, from: SELF_ID, to: frame.to, data: frame.data });
        return;
      }
      // activate 是 LAN 名册的分组信号；配对码房间里服务器本来就忽略它。
    }

    /** 房间 → 这个页面。 */
    receive(msg) {
      if (!msg || msg.room !== this.room || this.readyState !== 1) return;
      if (msg.id === SELF_ID) return; // 自己发的那一份，BroadcastChannel 不回送但别赌
      if (msg.t === "join" || msg.t === "here") {
        const known = this.peers.has(msg.id);
        this.peers.set(msg.id, { id: msg.id, name: msg.name });
        // 新来的要知道我们在——服务器是从自己的房间状态里发整份名册的，
        // 这里由每个成员各自应答一次，效果一样。
        if (msg.t === "join") this.post({ t: "here", room: this.room, id: SELF_ID, name: this.name });
        if (!known) this.deliver({ type: "peers", peers: [...this.peers.values()] });
        return;
      }
      if (msg.t === "bye") {
        if (!this.peers.delete(msg.id)) return;
        // 先 left（"这条物理连接没了"），再 peers。顺序和服务器一致：客户端用
        // left 结束绑在那个 id 上的会话，用 peers 重画选择器。
        this.deliver({ type: "left", peer: msg.id });
        this.deliver({ type: "peers", peers: [...this.peers.values()] });
        return;
      }
      if (msg.t === "sig" && msg.to === SELF_ID) {
        this.deliver({ type: "signal", from: msg.from, data: msg.data });
      }
    }

    deliver(envelope) {
      this.onmessage && this.onmessage({ data: JSON.stringify(envelope) });
    }

    post(msg) {
      try { this.chan.postMessage(msg); } catch { /* 页面正在卸载 */ }
    }

    close() {
      liveSockets.delete(this);
      if (this.readyState === 3) return;
      this.readyState = 3; // CLOSED
      this.post({ t: "bye", room: this.room, id: SELF_ID });
      try { this.chan.close(); } catch { /* 已经关了 */ }
      this.onclose && this.onclose();
    }
  }

  window.WebSocket = function (url, protocols) {
    if (isSignaling(url)) return signalingDropped ? new DeadSignalingSocket(url) : new FakeSignalingSocket(url);
    return new RealWebSocket(url, protocols);
  };
  window.WebSocket.prototype = RealWebSocket.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = RealWebSocket[k];

  // 这个标签页自称是谁，给断言读。
  window.__e2eSelfId = SELF_ID;

  /**
   * 只掐**这一个标签页的信令 socket**，页面和它的 DataChannel 一个字都不动。
   *
   * 这是"相关性丢失"那条不变式在真浏览器里唯一能被制造出来的样子：一边掉了
   * WebSocket，房间因此告诉另一边"它走了"，而两边之间那条数据通道还活着、还在
   * 搬字节。产品里没有因此多出任何开关——被换掉的仍然只是会合服务本身。
   */
  window.__e2eDropSignaling = () => {
    signalingDropped = true;
    for (const sock of [...liveSockets]) sock.close();
    return true;
  };
})();`;
}

/**
 * `/api/ice` 与页面启动时会打的其它同源 GET。
 *
 * `iceServers: []` 是**有意**的空，不是懒得填：一旦里面有 turn: 条目，
 * `chooseRtcConfig` 就会把 ICE 强制成 relay-only，而这台机器上并没有 TURN 服务器
 * ——于是一个候选都收集不到，连接永远建不起来。空列表让两个标签页用 host 候选在
 * 环回上直连，这正是"loopback direct 足够证明路由与界面"那句话的兑现方式。
 */
/**
 * 铸码那一步的夹具：`POST /api/pair`。
 *
 * `apiFixtureScript` 只答 GET（有意的：它是给只读页面用的），而"先选文件、再铸码"
 * 这条入口——也就是**预置队列**的真实来源之一——必须真的走一次 CodePairing 的
 * `pickAndSend`，否则测到的就不是产品里那条路径。这里只替换这一个 POST，其余原样
 * 转交给上一层 fetch。
 *
 * @param {object} opts
 * @param {string} opts.code 铸出来的六位码。
 * @param {number} [opts.ttlSecs] 距今多久过期，默认 10 分钟（远长于这条用例）。
 */
export function pairMintScript({ code, ttlSecs = 600 }) {
  return `(() => {
  const CODE = ${JSON.stringify(code)};
  const TTL = ${Number(ttlSecs)};
  const prevFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let url = "";
    let method = "GET";
    try {
      if (typeof Request === "function" && input instanceof Request) { url = input.url; method = input.method; }
      else url = String(input);
      if (init && init.method) method = init.method;
      url = new URL(url, document.baseURI).pathname;
    } catch { return prevFetch(input, init); }
    if (String(method).toUpperCase() !== "POST" || url !== "/api/pair") return prevFetch(input, init);
    return Promise.resolve(new Response(
      JSON.stringify({ code: CODE, expiresAt: Math.floor(Date.now() / 1000) + TTL }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  };
})();`;
}

export const CODE_ROOM_ROUTES = {
  "/api/ice": { iceServers: [], relays: [] },
  "/api/me": { user: null },
  "/api/auth/methods": { password: true, google: false, apple: false, magic: false },
  "/api/plans": [],
  "/api/me/usage": {
    period: "202608", resetsAt: 0,
    traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
    plan: { id: "free", retentionSecs: 86400 },
  },
  "/api/stats": { transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 },
  "/api/files": { files: [] },
  "/api/devices": { devices: [] },
  "/api/nodes/mine": { nodes: [] },
};

/**
 * 同一份路由，但**已登录**。
 *
 * 只有登录过的账号才看得到 CodePairing 的"选文件 → 铸码"入口，而那条入口正是预置
 * 队列（和 OS 分享目标同一个 outbox）在产品里的真实来源。收方那一边不需要账号。
 */
export const CODE_ROOM_SIGNED_IN_ROUTES = {
  ...CODE_ROOM_ROUTES,
  "/api/me": {
    user: {
      id: "u_e2e", email: "sender@example.com", displayName: "Sender",
      hasPassword: true, linkedMethods: ["password"], planId: "free",
      subscriptionStatus: "", subscriptionEnd: 0, hasBilling: false,
    },
  },
};
