/**
 * 无障碍扫描的目标表。
 *
 * 单独一个模块，是为了让它**可以被测试导入**：a11y-scan.mjs 顶层就 await 起浏览器、
 * 起 preview 并跑完整轮扫描，import 它等于跑一次完整的 CI。目标表是这套门里最容易
 * 悄悄退化的东西（一个 readySelector 松一点，一整块界面就再也没被扫过），所以它必须
 * 是能被真断言盯住的数据，而不是只能拿正则去猜的源码字符串。
 */
import { FREE_USER_ROUTES, ME_DEVICES, ME_ROUTES, PLANS, PRICING_ROUTES } from "./a11y-fixtures.mjs";

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

// 一张**真的**档位卡：`.tier-name` 只在 `/api/plans` 解析成功后的分支里渲染，骨架屏
// 那四张挂的是 `.sk-name` 且整个网格 aria-hidden。要求 PLANS.length 个，是为了让
// "只到了第一张卡" 也算没准备好——扫一张卡和扫一格空壳一样测不出东西。
export const LOADED_TIERS = ".tier:not(.tier-skeleton) .tier-name";

/**
 * 扫描目标。
 *
 * 每个目标都钉死了视口、配色方案和一个 readySelector——**不用固定 sleep**。固定 sleep
 * 在快机器上浪费时间，在慢机器上给出的是一张还没画完的页面，然后同一份代码今天绿明天红。
 *
 * readySelector 要选的是**这一格真正想扫的内容**，不是页面外壳。`ready` 加可选的
 * `readyCount`（默认 1）判"至少这么多个节点在了"：定价格子要的是四张真卡全到齐，
 * 而不是骨架屏还在时的那个 `.pricing-page` 容器。
 *
 * `fixture` 是一份浏览器端的同源 API 桩（a11y-fixtures.mjs）。只有真的需要后端数据
 * 才会给的东西——preview 后面没有 `/api/*`，缺了它 /pricing 只能停在 loadError 上。
 *
 * `drive` 是一串按顺序执行的「点一下、等到位」步骤。
 */
export const TARGETS = [
  // ── 静态产物：4 个模板 + 404，含一份 RTL ────────────────────────────────
  { id: "static/landing/ar", url: "/ar/", ready: "footer", viewport: DESKTOP, scheme: "light",
    note: "landing 模板 + RTL（dir=rtl 只有阿拉伯语走）" },
  { id: "static/article/en", url: "/compare/snapdrop/", ready: "footer", viewport: DESKTOP, scheme: "light",
    note: "article 模板（约 50 篇文章共用）" },
  { id: "static/article/ar", url: "/ar/compare/snapdrop/", ready: "footer", viewport: DESKTOP, scheme: "light",
    note: "article 模板的 RTL 分支" },
  // mode 模板（cross-network / offline-transfer）**没有**英文静态页——英文走 SPA
  // 路由——所以只能从本地化 URL 进。少了这一格，这个模板就是没人扫过的。
  { id: "static/mode/zh", url: "/zh/cross-network/", ready: "footer", viewport: DESKTOP, scheme: "light",
    note: "mode 模板只有 8 种本地化语言有静态页" },
  { id: "static/guides-index/en", url: "/guides/", ready: "footer", viewport: DESKTOP, scheme: "light" },
  { id: "static/legal/en", url: "/privacy/", ready: "footer", viewport: DESKTOP, scheme: "light" },
  { id: "static/notfound/en", url: "/404.html", ready: "h1", viewport: DESKTOP, scheme: "light" },

  // ── SPA：必须等真组件挂上来 ────────────────────────────────────────────
  // 首页折叠线以下的内容是一个动态 import。等首屏 .lan-workspace 只在本地快磁盘上
  // 偶然把它一起扫到；生产网络会少掉整个营销区块却照样显示全绿。等懒加载块里的
  // 稳定 heading，才代表这一个目标的完整 DOM 已经到齐。
  { id: "spa/landing/desktop-light", url: "/", ready: "#home-text-title", viewport: DESKTOP, scheme: "light" },
  { id: "spa/landing/mobile-dark", url: "/", ready: "#home-text-title", viewport: MOBILE, scheme: "dark",
    note: "同一个完整页面的另一套令牌：深色的对比度和浅色是两回事" },
  { id: "spa/cross-network", url: "/cross-network", ready: ".crosspage", viewport: DESKTOP, scheme: "light" },
  // 等的是 `.pricing-page .tier-name`，不是 `.pricing-page`。外壳在 `/api/plans` 失败
  // 时也照样在，于是这一格过去扫的一直是那句红色的 loadError——四张真卡、它们的标题
  // 层级、价格排版和 CTA 一个都没进过 axe。夹具让真数据落地，选择器让"落地了没有"
  // 成为一个能失败的断言。
  { id: "spa/pricing", url: "/pricing", ready: `.pricing-page ${LOADED_TIERS}`, readyCount: PLANS.length,
    viewport: DESKTOP, scheme: "light", fixture: PRICING_ROUTES,
    note: "真档位网格：h1 之后的第一块内容，heading-order 只在这里才看得见" },
  { id: "spa/apps", url: "/apps", ready: ".apps", viewport: DESKTOP, scheme: "light" },
  { id: "spa/cli", url: "/cli", ready: ".cli", viewport: DESKTOP, scheme: "light" },
  // /device-inbox waits for the LAST platform section, not for `.dinbox`: the
  // shell is present before the six sections are, and a target that is satisfied
  // by the container would scan a hero and call the page clean. Six is the count
  // the PRD requires the page to name, so the number is the assertion.
  { id: "spa/device-inbox", url: "/device-inbox", ready: "[data-platform]", readyCount: 6,
    viewport: DESKTOP, scheme: "light",
    note: "six platform sections, definition lists, status badges and the signed-out start block" },
  // Same page, dark tokens and 390px: the badge colours are computed styles, and
  // the two-column definition list collapses to one below 720px.
  { id: "spa/device-inbox/mobile-dark", url: "/device-inbox", ready: "[data-platform]", readyCount: 6,
    viewport: MOBILE, scheme: "dark",
    note: "the same page's dark tokens and its single-column narrow layout" },
  // 登录态的 /device-inbox。等的是 `[data-di="devices"] li`，数量钉死成夹具里的行数：
  // 这一页的操作区——发送按钮、拖放区、状态徽章、常驻活动区域、"不能发"的说明——
  // 全在行里面，等外壳只能证明文章部分在。它和 /me 是同一批组件的两种配置（这一边
  // 关掉了改名/吊销），两种配置的焦点样式和对比度是分开的东西，所以两格都要扫。
  { id: "spa/device-inbox/signed-in", url: "/device-inbox",
    ready: '[data-di="devices"] li', readyCount: ME_DEVICES.devices.length,
    viewport: DESKTOP, scheme: "light", fixture: ME_ROUTES,
    note: "已登录的设备收件箱：页内可发送 / 需批准 / 已关闭 / 已吊销 四种卡片" },

  // My Devices as a SENDER directory. 等的是 `.devicelist li`，数量钉死成夹具里的
  // 行数：等 `.accountdevices` 只能证明区块外壳在，而这一块新增的控件——拖放区、
  // 发送按钮、状态徽章、常驻活动区域——全都在行里面。四行覆盖四种发送态，能发的
  // 两行还要额外证明拖放区真的渲染了。
  { id: "spa/me/devices", url: "/me", ready: ".devicelist li", readyCount: ME_DEVICES.devices.length,
    viewport: DESKTOP, scheme: "light", fixture: ME_ROUTES,
    note: "已登录的 My Devices：可发送 / 需批准 / 已关闭 / 已吊销 四种卡片" },
  // 同一块界面的深色 + 窄屏：卡片在 520px 以下换成两列网格，拖放区改成整宽按钮，
  // 而对比度是**计算后**的样式——浅色扫过不代表深色扫过。
  { id: "spa/me/devices/mobile-dark", url: "/me", ready: ".devicelist li", readyCount: ME_DEVICES.devices.length,
    viewport: MOBILE, scheme: "dark", fixture: ME_ROUTES,
    note: "同一块界面的深色令牌与窄屏布局" },

  // ── 两个动态决策态 ─────────────────────────────────────────────────────
  // 真正的"同意/验证"决策态需要两个 peer 和一台信令服务器，那是 mixed-link /
  // code-room 上的事。这里取的是账户弹窗的两种会话：登出态的登录表单，和已登录
  // 免费用户展开的内联档位。它同时是三处 role="dialog" 之一。
  // 账户按钮只在 cross / offline / pricing / me 四条路由上渲染（Nav.svelte），
  // 所以这两格挂在 /cross-network 上而不是首页。
  { id: "spa/cross-network/account-modal", url: "/cross-network", ready: ".crosspage",
    viewport: DESKTOP, scheme: "light",
    note: "动态决策态：登出态的账户/登录弹窗",
    drive: [
      { click: ".acct-btn", ready: '.modal[role="dialog"]' },
    ] },

  // Pricing 的**第二处**嵌入。同一个组件，完全不同的语境：一个 role="dialog" 里面、
  // 一个已登录免费用户、可视宽度只有弹窗那么宽。上一格（登出态）到不了这里——
  // `.billing-section` 只在有会话时渲染，内联 Pricing 又只在 hasBilling 为假时渲染。
  // 只扫 /pricing 就等于宣称"这个组件是干净的"，而它在弹窗里的那一份从没被看过。
  { id: "spa/cross-network/account-modal/pricing", url: "/cross-network", ready: ".crosspage",
    viewport: DESKTOP, scheme: "light", fixture: FREE_USER_ROUTES,
    note: "动态决策态：已登录免费用户在账户弹窗里展开内联档位",
    drive: [
      // 等 `.billing-section` 而不是 `.modal`：它只在 session().user 落地后才存在，
      // 所以它同时证明了"登录态夹具确实生效了"。
      { click: ".acct-btn", ready: '.modal[role="dialog"] .billing-section' },
      { click: '.modal[role="dialog"] .billing-section .btn-ghost', ready: `.pricing-inline ${LOADED_TIERS}`, readyCount: PLANS.length },
    ] },
];
