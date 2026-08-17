/**
 * 给无障碍扫描用的**浏览器端**同源 API 夹具。
 *
 * 为什么需要它：`vite preview` 只吐 `dist`，`/api/*` 后面没有任何东西。于是 /pricing
 * 的 `onMount` 拿到一份 HTML、`res.json()` 抛错、组件停在 loadError 分支——CI 扫到的
 * 是一句红色提示，**四张真实的档位卡一张都没扫过**。而那正是这一轮要修的
 * heading-order 违规所在的地方：只有 `/api/plans` 真正解析成功，`h1 → h3` 才会出现。
 * 一个只在"后端挂了"这条分支上跑的门，永远看不见它要守的东西。
 *
 * 为什么不接一个真后端：那会给一条纯前端的 CI 门加上 Go 服务器 + 数据库 + 迁移 +
 * 种子数据的依赖，而它们任何一个抖一下，红的都是无障碍扫描——一个指向完全错误方向的
 * 失败。夹具在页面自己的进程里，确定、离线、和 `npm run build` 的产物一一对应。
 *
 * 补丁的四条纪律（每一条都对应一种"夹具本身把页面测坏了"的方式）：
 *  1. **`Request` 和字符串/`URL` 都要认**。`fetch(new Request(u))` 的 URL 在 `.url`
 *     上，`String(request)` 只会得到 `[object Request]`，于是匹配静默失效。
 *  2. **没匹配上的一律原样放行**，连参数都不重建——被夹具吞掉的请求会让页面停在一个
 *     线上永远不存在的状态里。
 *  3. **只接管 GET**。写操作放行到真网络（在 preview 下就是 404），免得把一次
 *     结账/改档假装成成功。
 *  4. **只认同源**。第三方 URL 不是这份夹具的事。
 *
 * 注入方式是 `Page.addScriptToEvaluateOnNewDocument`，而它是**按标签页会话**下发的
 * （见 harness.mjs 的 newTab）：每一格扫描各开各的标签页，夹具不会漏到别的目标上。
 */

/**
 * 四档真实形状的档位，字段与 server/account/billing.go 的 publicPlanView 一一对应。
 * 值取自 src/lib/PricingPage.test.ts 用的同一份表：一个 Free、三个付费档，月付/年付
 * 都可购买——付费卡的 CTA、价格排版和 popular 缎带因此全都真的渲染出来。
 */
export const PLANS = [
  { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
  { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
  { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
  { id: "max", name: "Max", storageBytes: 2e11, trafficBytes: 4e12, retentionSecs: 14 * 86400, priceMonthly: 1990, priceYearly: 19900, purchasableMonthly: true, purchasableYearly: true },
];

/**
 * 一个**免费档**的已登录用户。免费档是关键：Account.svelte 只在 `hasBilling` 为假时
 * 才把 Pricing 内联进弹窗（有订阅的人走的是 Stripe 门户），所以这就是那条内联分支
 * 唯一能到达的会话形状。
 */
export const FREE_USER = {
  id: "a11y-fixture-user",
  email: "a11y@relayium.test",
  displayName: "A11y",
  hasPassword: true,
  linkedMethods: ["password"],
  planId: "free",
  subscriptionStatus: "",
  subscriptionEnd: 0,
  hasBilling: false,
  scheduledPlanId: "",
  billingCycle: "",
};

/** fetchAuthMethods() 的形状（auth.svelte.ts 的 AuthMethods）。 */
export const AUTH_METHODS = { password: true, google: false, apple: false, magic: false };

/** 标准 /pricing：只要真的档位，会话状态保持登出。 */
export const PRICING_ROUTES = {
  "/api/plans": PLANS,
};

/** 账户弹窗里的内联 Pricing：免费档已登录用户 + 登录方式 + 真的档位。 */
export const FREE_USER_ROUTES = {
  "/api/plans": PLANS,
  "/api/me": { user: FREE_USER },
  "/api/auth/methods": AUTH_METHODS,
};

/**
 * 一台真的 Device Inbox 设备（`GET /api/devices` 里的 `Inbox` 子树，协议 §9）。
 *
 * 这一块存在的理由和上面 `LOADED_TIERS` 一样：`/me` 的设备卡片只有在设备**真的**
 * 报了收件箱之后才渲染发送区、状态徽章、可拖放区和常驻的活动区域。没有夹具时
 * `/api/devices` 在 preview 后面是 404，列表是空的，于是这一整块——包括这一轮新增
 * 的每一个可交互控件——一次都没被 axe 看过，而扫描仍然全绿。
 */
const DEVICE_KEY = { ID: "k1", Algorithm: "x25519-sealedbox-v1", PublicKey: "A".repeat(43), Generation: 1, CreatedAt: 1754000000, SupersededAt: 0, RevokedAt: 0 };
const inbox = (over) => ({
  Presence: "online", LastHeartbeatAt: 1754600000, PresenceExpiresAt: 1754600090,
  HeartbeatIntervalSeconds: 30, ProtocolVersion: 3,
  Capabilities: ["inbox.receive.v3", "inbox.autoaccept.v1", "inbox.text.v1"], ReceiveCapability: "inbox.receive.v3",
  AutoAccept: "auto", ReceiveDirReady: true, Platform: "linux", AppVersion: "0.21.0",
  Revoked: false, CanReceive: true, RegisteredAt: 1754000000, Key: DEVICE_KEY, ...over,
});

/**
 * 四种发送态各一行，四种都要扫：能发的卡片有拖放区和按钮，不能发的卡片只有一段
 * 说明文字，两者的对比度、焦点样式和标题层级是分开的东西。撤销按钮在每一行都在。
 */
export const ME_DEVICES = {
  devices: [
    { ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", Name: "build-server", CreatedAt: 1750000000, LastSeenAt: 1754600000, Kind: "cli", Inbox: inbox() },
    { ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2", Name: "Lily's MacBook", CreatedAt: 1750000000, LastSeenAt: 1754500000, Kind: "app", Inbox: inbox({ Presence: "offline", AutoAccept: "ask", Platform: "darwin" }) },
    { ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3", Name: "old-vps", CreatedAt: 1740000000, LastSeenAt: 0, Kind: "cli", Inbox: inbox({ AutoAccept: "off", Presence: "offline" }) },
    { ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4", Name: "lost-laptop", CreatedAt: 1740000000, LastSeenAt: 1741000000, Kind: "cli", Inbox: inbox({ Revoked: true, CanReceive: false, Presence: "offline" }) },
  ],
};

/** `/me`：已登录 + 用量 + 一份有收件箱的设备列表。 */
export const ME_ROUTES = {
  "/api/plans": PLANS,
  "/api/me": { user: FREE_USER },
  "/api/auth/methods": AUTH_METHODS,
  "/api/me/usage": {
    period: "202608", resetsAt: 1756684800,
    traffic: { used: 1e8, cap: 1e9 }, storage: { used: 2e8, cap: 1e9 },
    plan: { id: "free", retentionSecs: 86400 },
  },
  "/api/stats": { transfers: 4, downloads: 7, uploadBytes: 1e8, downloadBytes: 2e8, relayBytes: 0 },
  "/api/files": { files: [] },
  "/api/nodes/mine": { nodes: [] },
  "/api/devices": ME_DEVICES,
};

/**
 * 生成注入用的源码。`routes` 是 `pathname → JSON body`，一律 200 + JSON。
 */
export function apiFixtureScript(routes) {
  return `(() => {
  const ROUTES = ${JSON.stringify(routes)};
  const realFetch = window.fetch.bind(window);

  // 命中就返回那条路由的 body，否则返回 undefined（= 放行）。
  const match = (input, init) => {
    let raw, method;
    if (typeof Request === "function" && input instanceof Request) {
      raw = input.url;
      method = input.method;
    } else {
      raw = String(input);
      method = "GET";
    }
    // init.method 按 fetch 规范压过 Request 上的那个。
    if (init && init.method) method = init.method;
    if (String(method).toUpperCase() !== "GET") return undefined;
    let url;
    try { url = new URL(raw, document.baseURI); } catch { return undefined; }
    if (url.origin !== location.origin) return undefined;
    return Object.prototype.hasOwnProperty.call(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
  };

  window.fetch = function (input, init) {
    let body;
    try { body = match(input, init); } catch { body = undefined; }
    // 参数原样转交，不重建：任何重建都会悄悄丢掉 signal / credentials / body。
    if (body === undefined) return realFetch(input, init);
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
})();`;
}
