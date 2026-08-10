// 显式 .js 后缀：vite-plugin-pwa.ts 会 import 本文件取 LANGS（构建期要按语言清单校验
// precache 覆盖），于是本文件也进了 tsconfig.node.json 的 nodenext 程序，那里的相对
// 导入必须带扩展名。这是纯类型导入，打包时整条被抹掉。
import type { SameLength, PICK_MODES, FLAG_ROWS, TRUST_FILES, GUIDES } from "../cli-page-data.js";
import type { InboxPlatformId } from "../device-inbox-platforms.js";

// Pure i18n types and locale-independent helpers. No message data and no
// runtime state live here, so language tables and the reactive facade can both
// import it without a cycle.

export type Lang = "zh" | "en" | "ja" | "ko" | "de" | "fr" | "ar" | "es" | "pt";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "ar", label: "العربية" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

/** One page's "how it works" walkthrough: three sequential step cards. */
export interface HowSection {
  title: string;
  sub: string;
  ways: { name: string; how: string; tag: string }[];
}

export interface Messages {
  langLabel: string;
  theme: { label: string; system: string; light: string; dark: string };
  tagline: string;
  connected: (name: string) => string;
  ipLabel: string; // prefix shown before the device's server-observed public IP
  connecting: string;
  unavailable: string;
  unsupported: string;
  guideTitle: string;
  step1: string;
  step2: string;
  step3: (max: number) => string;
  step4: string;
  hint: string;
  requestHead: (name: string, count: number, size: string) => string;
  codeLabel: string;
  codeCompare: string;
  pathLan: string; // connection-path badge: host↔host on the local network
  pathP2p: string; // direct P2P over the public internet (NAT-traversed)
  pathRelay: string; // traffic going through a TURN relay
  sharePending: (n: number, size: string) => string; // local queued-file summary before device choice
  sendFile: string; // button: choose files to send
  sendFolder: string; // button: choose a folder to send
  accept: string;
  decline: string;
  // 接收侧内存提示：为什么 + 会怎样 + 怎么办，带上这一批的总大小。下载页的
  // download.memWarn* 讲的是「这个链接」，实时接收没有链接，措辞不能复用。
  recvMemWarn: (size: string) => string;
  recvMemWarnAccept: string; // 按钮：仍要接收
  // 点「接收」之前告诉用户点下去会发生什么。二选一，由 filesink 的 asksWhereToSave
  // 决定：会弹保存位置选择器 / 直接落到浏览器的下载目录。线上事故里用户说的
  // 「没看到任何选择器，也不知道该怎么选」，缺的就是这一句。
  // 手机上恒为后者，因为那里整条选择器分支都关着 —— 文案与实际行为逐字一致。
  recvSaveHintPicker: string;
  recvSaveHintDownload: string;
  // 上一次接收被用户在保存选择器里取消了，同意卡片正在**再问一次**（桌面独有）。
  // 那次取消在线路上什么都没留下，所以这不是失败文案，而是「还能再来一次」。
  // 必须说清楚传输还活着，否则按了取消的用户只会看到卡片原地不动。
  recvSaveRetry: string;
  sendTo: (name: string) => string;
  recvFrom: (name: string) => string;
  fileCounter: (i: number, n: number) => string;
  close: string;
  cancel: string; // abort an in-progress transfer and return to idle
  dialogConfirm: string; // ConfirmModal's affirmative button label
  dialogCancel: string; // ConfirmModal's dismiss button label
  share: string; // Web Share button label (opens the OS share sheet for a link)
  startOver: string; // leave the current room and return to the method choices
  peersTitle: string;
  crossPeersTitle: string; // heading for the single connected peer on the cross-network page
  emptyPeers: string;
  emptyCrossCta: string; // LAN empty-state escape hatch → cross-network transfer
  dragSendOne: (name: string) => string;
  dragSendMany: string;
  pickHint: (max: number) => string;
  maxSize: (size: string) => string; // upload max-size hint shown near the file picker, e.g. "Max 200 MB"
  pickSendTo: (name: string) => string; // prominent single-peer send label
  generating: string; // transient "creating…" state while a code/link is minted
  footer: string;
  offlineFooter: string; // async page's own footer: random-key AES-256-GCM, ciphertext durably stored (NOT the LAN/realtime X25519 footer)
  busy: string;
  tooMany: (max: number, n: number) => string;
  titleDefault: string;
  descDefault?: string; // home <meta description>; falls back to titleDefault when absent
  titleCross: string; // <title> for the cross-network (realtime) route
  titleOffline: string; // <title> for the offline-transfer (stored-link) route
  descCross: string; // <meta description> for the cross-network route
  descOffline: string; // <meta description> for the offline-transfer route
  reconnecting: string; // signalling socket dropped, trying to reconnect
  confirmLeave: string; // confirm() before an action would interrupt an active transfer
  // 这条确认栏出现在**建连之前**，所以此刻还没有 SAS 可以并排显示（sasCode 要等
  // 握手完成才算得出来）。而 name 是对端自己设的，一个拿到配对码进了房间的人可以把
  // 自己叫成任何名字。所以文案必须把它写成**自称**——界面不该暗示一件它并不知道的事。
  confirmRecv: (name: string) => string; // 'A device calling itself "<name>" wants to receive'
  // The instruction that makes the bar above worth stopping for. It is only ever
  // rendered with advanced verification on — i.e. with a verification code
  // actually on screen — and it MUST name comparing that code. Without it the
  // prompt states a risk and no way to answer it, which is a click-through.
  confirmRecvCompare: string;
  // The other half of the same stop, for the case where the code does not exist
  // YET: a preselected batch (share sheet, or files picked before the code was
  // minted) arms this bar before any link is built, and a link-capable peer's
  // verification code only appears once the workspace is open. Rendered in place
  // of the comparison instruction, next to the action that opens it.
  confirmRecvNeedsCode: string;
  confirmRecvSend: string;
  confirmRecvCancel: string;
  status: {
    connecting: string;
    waitingAccept: string;
    rejected: string;
    sending: string;
    finishing: string;
    sendDone: (n: number) => string;
    sendFail: string;
    receiving: string;
    recvDone: (n: number) => string;
    integrityFail: string;
    recvFail: string;
    resuming: string; // connection dropped mid-transfer, reconnecting to resume
    // 用户自己在保存位置选择器里取消了，**而且这次同意已经救不回来**（链路换了、
    // 同意窗口走完了、通道关了）。取消本身通常不走到这里：卡片会原地再问一次，
    // 见 recvSaveRetry。
    // **只有**用户取消才用这句：把「浏览器的保存这一段坏了」也说成用户取消，等于
    // 让用户去找一个不存在的选择器（线上事故就是这么来的）。那一种用下面的 saveFail。
    noSave: string;
    saveFail: string; // 保存这一段失败（选择器坏了、写盘被拒），不是用户的选择
    connectFail: string;
    peerBusy: string; // the peer refused the offer because it's already in a transfer
  };
  account: {
    /** Accessible names for the account dialog's five submodes. One <div
     *  role="dialog"> hosts all of them, so the name has to follow the mode —
     *  announcing "Account" to somebody being asked to verify an email is worse
     *  than the no-name state this replaced. `createAccount` and `signIn` below
     *  already say the right thing for the register/login forms and are reused. */
    verifyPanel: string;
    forgotPanel: string;
    panel: string;
    signIn: string;
    signOut: string;
    email: string;
    sendLink: string;
    linkSent: string;
    continueGoogle: string;
    continueApple: string;
    or: string;
    signedInAs: (email: string) => string;
    password: string;
    createAccount: string;
    logInBtn: string;
    toRegister: string;
    toLogin: string;
    errTooShort: string;
    errEmailTaken: string;
    errLogin: string;
    errNetwork: string; // request never reached the server (offline / fetch threw)
    pendingDeletion: string; // frozen-account reactivate banner (fragment token)
    reactivate: string;
    reactivateError: string;
    changePassword: string;
    setPassword: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    pwChanged: string;
    errCurrentWrong: string;
    errMismatch: string;
    linkedTitle: string; // heading for the linked-login-methods list
    unlink: string; // remove a linked provider button
    errLastMethod: string; // refused: can't remove the only login method
    personalCenter: string; // menu entry → /me
    verifySentBody: (email: string) => string; // "check your email" panel body after register
    resendVerification: string; // resend button label on the "check your email" panel
    resendVerificationBtn: string; // resend button label on the inline unverified-login notice
    resendVerificationSent: string; // ack shown after a resend click
    unverifiedNotice: string; // inline notice when passwordLogin returns unverified
    forgotPasswordLink: string; // "忘记密码？" link on the login form
    resetPasswordSend: string; // submit button on the forgot-password panel
    resetPasswordSent: string; // neutral post-submit message (never reveals account existence)
    checkSpamHint: string; // muted follow-up under any "we emailed you" state: check spam + allowlist noreply@relayium.com. Also reused (via t.account.*) on VerifyEmail.svelte's invalid-token panel.
  };
  // Pricing tiers (Pricing.svelte) + account billing section (Account.svelte).
  billing: {
    monthly: string; // billing-cycle toggle: monthly option
    yearly: string; // billing-cycle toggle: yearly option
    cycleLabel: string; // accessible name of the billing-cycle button group
    loadingPlans: string; // status announced while GET /api/plans is pending
    perMonth: string; // price suffix, e.g. "$9.00/mo"
    perYear: string; // price suffix, e.g. "$90.00/yr"
    free: string; // price shown for the free tier
    currentFree: string; // note under the free tier: you're already on it
    upgrade: string; // CTA on a purchasable tier / account panel
    downgrade: string; // CTA to switch to a cheaper tier than the current one
    // CTA when only the billing cycle changes on the tier the user already has.
    // "Upgrade"/"Downgrade" would misread there — the tier is not moving.
    switchToYearly: string;
    switchToMonthly: string;
    current: string; // badge/label on the tier the user is currently subscribed to
    popular: string; // "Most popular" ribbon on the highlighted tier
    save2mo: string; // yearly-toggle savings badge (yearly = 10x monthly => 2 months free)
    changeError: string; // in-app plan change (POST /api/billing/change-plan) failed
    changeSuccess: string; // toast after a successful (immediate) upgrade
    downgradeScheduled: string; // toast after a downgrade is scheduled for period end
    previewLoading: string; // 弹窗加载预览时
    upgradeSummary: (charge: string, next: string, cycle: string, date: string) => string;
    downgradeSummary: (date: string) => string;
    confirmChange: string; // 弹窗确认按钮
    cancel: string; // 弹窗取消按钮
    previewError: string; // 预览请求失败
    scheduledNote: (plan: string) => string; // banner: a downgrade to <plan> is pending at period end
    scheduledBadge: string; // badge on the tier a pending downgrade will switch to
    keepCurrentPlan: string; // CTA to cancel the pending downgrade (stay on the current tier)
    cancelScheduledError: string; // canceling the scheduled downgrade failed
    notAvailable: string; // tier not yet purchasable
    signInRequired: string; // checkout attempted while signed out (401)
    checkoutError: string; // generic checkout-start failure
    loadError: string; // GET /api/plans failed
    storage: string; // tier capability line label
    traffic: string; // tier capability line label
    retention: string; // tier capability line label
    days: (n: number) => string; // "N day(s)" retention value
    currentPlan: string; // "Plan" label in the account billing section
    manageBilling: string; // CTA that opens the Stripe billing portal (manage payment/invoices, and cancel)
    downgradeToFree: string; // Free-tier CTA for subscribers → portal (Free has no Stripe price, so leaving = cancel)
    cancelSubscription: string; // standalone Cancel link on the plan card / account menu → portal
    portalError: string; // billing-portal open failure
    checkoutSuccess: string; // banner after Stripe Checkout success redirect
    checkoutCanceled: string; // banner after Stripe Checkout cancel redirect
    // PlanCard info-card redesign (Task 4).
    cycleMonthly: string; // 周期徽章：月付
    cycleYearly: string; // 周期徽章：年付
    changePlan: string; // 会员卡 CTA：更改套餐（可升可降可换周期）
    renewsOn: (date: string) => string; // active：下次续费 {date}
    trialEndsOn: (date: string) => string; // trialing：试用中 · {date} 到期
    pastDueNotice: string; // past_due：扣款失败 · 请更新支付方式
    canceledUntil: (date: string) => string; // canceled：已取消 · {date} 前有效
    scheduledDowngradeRow: (name: string, date: string) => string; // 已排期：{date} 期末降到 {name}
  };
  // Standalone /pricing marketing page (PricingPage.svelte).
  pricingPage: {
    navLink: string; // "Pricing" link in the footer / account panel
    title: string; // page H1
    subtitle: string; // one-line intro under the H1
    signedOutCta: string; // note for logged-out visitors above the tiers
    // "Always free" explainer card
    freeTitle: string;
    freeLead: string;
    free1: string; // LAN transfers
    free2: string; // direct P2P
    free3: string; // E2E, unlimited, never touch servers
    freeWhy: string; // why they're free
    // "What you pay for" explainer card
    paidTitle: string;
    paidLead: string;
    paid1: string; // relay fallback
    paid2: string; // temporary cloud storage
    paid3: string; // higher limits
    paidWhy: string; // why we charge for these
    // Self-host (BYO node) callout
    selfhostTitle: string;
    selfhostBody: string;
    selfhostCta: string; // link to the account page's Add-node flow
    // FAQ
    faqTitle: string;
    q1: string; a1: string; // is it really free?
    q2: string; a2: string; // direct vs relayed transfers
    q3: string; a3: string; // why is there a paid tier?
    q4: string; a4: string; // can I avoid paying entirely? (self-host)
    q5: string; a5: string; // can I change plans later?
    q6: string; a6: string; // billing / cancellation
    back: string; // link back to the app/home
  };
  // 当月用量表（个人中心）与接近上限时的提醒条（传输界面）。cap === 0 表示无限。
  quota: {
    title: string;
    traffic: string;
    storage: string;
    left: (left: string) => string; // 剩余量，left 已是格式化好的体积字符串
    resets: (date: string) => string; // date 已按当前语言本地化
    unlimited: string;
    warn: (pct: number) => string; // 用量达 80% 时的提醒
    upgrade: string; // 提醒条上的按钮文案
  };
  // 发版后仍开着的旧标签页会一直跑旧代码，全站更新提示条就是收口（见
  // app-update.svelte.ts）。ready 会进 aria-live 区域，三句都不含任何受保护内容。
  appUpdate: {
    ready: string; // 已装好一份更新的构建
    refresh: string; // 按钮文案；永远只由用户点，绝不自动刷新
    // 按钮停用时说明为什么、以及要先做什么。刷新会打断的东西不止「文件传输」：还有
    // 在途的流式下载（新版本正因此被压着没放行）、活着的链接、开着的消息会话、以及
    // 只存在于内存里的待发队列。所以这句必须写得够宽，不能只提传输。
    busy: string;
  };
  me: {
    title: string;
    back: string; // link back to the home page
    loginRequired: string; // shown when /me is opened without a session
    signIn: string; // sign-in button on the login-required state
    // 个人中心的会员卡（PlanCard）。等级名与升级/管理订阅按钮复用 billing.* 的
    // 既有文案，这里只补卡片独有的三段。
    plan: {
      // 权益一行；三个参数都已格式化好（体积字符串 + 下面两个 retention 文案之一）
      perks: (storage: string, traffic: string, retention: string) => string;
      retentionDays: (n: number) => string; // 文件保留 n 天
      retentionForever: string; // retentionSecs === 0 的无限档
      hint: string; // 引导句：不够用可以升级
      topTier: string; // 已在最高档时替代升级按钮
    };
    transfers: string; // stat card: stored links created
    downloads: string; // stat card: total downloads of my files
    traffic: string; // stat card: total bytes
    trafficParts: (up: string, down: string, relay: string) => string; // breakdown line
    privacyNote: string; // reassurance: aggregate only, no downloader info
    filesTitle: string;
    filesEmpty: string;
    noName: string; //列表标题旁的说明：零知识加密，无文件名
    downloadsN: (n: number) => string; // per-file download count
    burnTag: string; // burn-after-read badge
    expiresIn: (left: string) => string; // per-file expiry countdown
    expiringSoon: string; // <1h marker
    del: string; // delete button
    confirmDel: string; // confirm() before deleting a file
    nodesTitle: string; // "My Nodes" section heading
    nodesEmpty: string; // no BYO relay nodes registered yet
    routingTitle: string; // aria-label for the routing radio group
    routeAuto: string; // option 1: auto-pick the fastest node by speed test
    routeAutoHint: string; // hint under the auto-routing option
    strictLabel: string; // option 2 label: restrict this account to only its own nodes
    strictHint: string; // one-line explanation under the only-own-nodes option
    nodeRename: string; // rename/label a node button
    addNode: string; // "Add node" button
    nodeNamePlaceholder: string; // placeholder for the new-node name field
    addNodeSubmit: string; // confirm button inside the add-node mini-form
    addNodeCancel: string; // cancel button inside the add-node mini-form
    tokenNote: string; // instruction shown above the one-time paste-in command
    tokenPortsNote: string; // note above the firewall/ports block
    tokenPortsTitle: string; // title of the ufw ports CommandBlock
    tokenGuideLink: string; // link text to the full "bring your own node" guide
    tokenDone: string; // "Done" button that clears the one-time token from memory
    nodeOnline: string; // online-status label
    nodeOffline: string; // offline-status label
    nodeRelayed: (bytes: string) => string; // relayed-traffic figure through this node
    nodeStored: (bytes: string) => string; // bytes stored on this node
    nodeFreeTag: string; // "(free)" tag next to relayed/stored figures — own-node traffic isn't billed
    nodeStorageFree: (free: string, total: string) => string; // "X free of Y" disk line
    nodesTrafficHint: string; // explains relay-vs-storage: stored files don't count as "relayed"
    checkNode: string; // "test connectivity" button per node
    nodeReachable: (ms: string) => string; // probe succeeded, with round-trip latency
    nodeUnreachable: string; // probe failed — node not reachable from central
    delNode: string; // remove-node button
    confirmDelNode: string; // confirm() before removing a node
    copyLink: string; // copy the rebuilt share link for a stored file (key held locally)
    linkHint: string; // note: links are recoverable only on the browser that uploaded
    // 账号级、可吊销的持令牌设备。GET /api/devices 返回两类：CLI（relayium login）
    // 和 App（macOS/iOS 原生登录，Kind = "app"）——两类持有的是同一种能代表账号
    // 传输/上传的 bearer 令牌，DELETE /api/devices/{id} 会连带删掉它。浏览器那一类
    // 不在这里（会话 cookie，不是能拷走的令牌），所以导语必须自己说清楚这件事。
    //
    // 文案不能只说 CLI：那样原生 App 的登录在用户眼里就成了「不在这个列表里」，
    // 而确认框里的「CLI 令牌」也会对着一台 App 设备说出错误的后果。
    //
    // 每一行还必须**能被认出来**（DECISION-LOG 2026-08-04）。`relayium login` 从前
    // 给每台设备起的名字都叫 "CLI"，于是三台服务器就是三行一模一样的
    // `CLI / CLI / 从未使用 / 吊销`，用户没法判断那个不可撤销的按钮会断掉哪一台。
    // 所以一行要同时说出：标签、类型、设备 ID 的短后缀、登录时间、以及"自登录以来
    // 用过没有"。后缀和登录时间是给**老行**用的——它们没有历史主机名可查，也不该为
    // 此做一次数据库回填。
    deviceTitle: string;
    deviceIntro: string;
    deviceEmpty: string;
    deviceEmptyHint: string; // 空列表下面的下一步：怎么让一台机器出现在这里
    deviceLastUsed: (when: string) => string;
    deviceIP: (ip: string) => string; // server-observed hint; may be NAT/VPN
    // "自登录以来没用过"，不是光秃秃的"从未使用"。刚批准完的令牌本来就还没用过，
    // 而旧文案把那种正常状态说成了像是出了错。
    deviceNotUsedSinceSignIn: string;
    deviceSignedIn: (when: string) => string; // 这枚凭据是什么时候被批准的
    deviceRef: (suffix: string) => string; // 设备 ID 的短后缀——**只有**这一小截，永不显示完整 ID
    deviceRevoke: string; // 每行都一样的可见按钮文字
    // 可访问名称与确认框都要带齐「标签 + 类型 + 后缀 + 登录时间」：同名两行时，
    // 这四样里后三样才是真正能区分它们的东西。
    deviceRevokeLabel: (name: string, kind: string, ref: string, signedIn: string) => string;
    deviceConfirmRevoke: (name: string, kind: string, ref: string, signedIn: string) => string;
    deviceKindApp: string; // 行内类型标签：原生 App 登录
    deviceKindCli: string; // 行内类型标签：CLI 登录
    // 行内改名。走的是本来就有的 PATCH /api/devices/{id}；重名是允许的，靠后缀区分。
    deviceRename: string; // 可见按钮文字
    deviceRenameLabel: (name: string) => string; // 可访问名称——指名要改哪一台
    deviceRenameField: (name: string) => string; // 输入框的可访问名称
    deviceRenameSave: string;
    deviceRenameCancel: string;
    deviceRenameRejected: string; // 服务端说这个名字不能用（控制字符、方向覆盖、太长）
    deviceRenameFailed: string; // 请求没成功，名字没有变——可以重试
    actionFailed: string; // generic "the request failed" notice for the write actions on this page
    // 账户注销入口。服务端的双重确认流程（POST /api/account/delete/request 只发一封
    // 确认邮件，真正的删除发生在邮件里的链接被打开之后）早就有了，法律文本也已经写明
    // 「可以在网页端的账户设置里删除账户」——但网页上一直没有这个按钮。
    //
    // 这几条文案本身就是安全机制：按钮按下去只发一封邮件，所以每一句都不能读成
    // 「已经删了」。`deleteRequested` 尤其如此——端点无论真发了邮件、被节流吞掉还是
    // 发信失败都回同一个 200，所以那句话只能声称「请求已提交」，不能声称「已发送」。
    deleteTitle: string; // danger 区块标题
    deleteBody: (email: string) => string; // 按下之前先说清楚会发生什么
    deleteAction: string; // 可见的破坏性控件
    deleteConfirm: (email: string) => string; // 应用内确认弹窗的全文（唯一说明后果的地方）
    deleteConfirmAction: string; // 弹窗里的肯定按钮：按它做的事是「发邮件」，标签就得这么写
    deleteRequesting: string; // 请求在途时的按钮文案
    deleteRequested: (email: string) => string; // 只能声称「已请求」，见上
    deleteFailed: string; // 明确的失败，且可重试
  };
  // Device Inbox, sender half — the My Devices card that sends files to one of
  // your own machines (DEVICE-INBOX-PRD.md §7, §10;
  // docs/protocol/relayium-device-inbox-v1.md §§5, 6, 14, 16).
  //
  // Two rules govern every string in here, and both are product requirements
  // rather than style:
  //
  //  1. **Presence never reads as permission.** An offline device that is
  //     properly enrolled is still a valid target: the file queues and lands
  //     when it comes back. So "offline" copy says *queued*, never *cannot*.
  //  2. **Never say "sent".** PRD §10 forbids one vague word covering both
  //     "the ciphertext reached Relayium" and "the target device saved it".
  //     `stateSaved` is the ONLY string that may claim a file landed, and the
  //     UI reaches it only from the server's own `saved` plus its commit
  //     timestamp.
  //
  // The `err*` and `sendErr*` families are closed sets copied from protocol
  // §16. They exist so a server token is never rendered as text: an
  // unrecognised one falls to `errUnknown`/`sendErrUnknown`.
  deviceInbox: {
    sectionHint: string; // one line under the devices heading: what sending to a device means
    // Where the send control comes from. The feature shipped invisible: a
    // signed-in owner with three CLI devices saw no send affordance anywhere
    // and no explanation of why, because the control only exists on an
    // enrolled row and nothing said so. These three strings are that
    // explanation, and they are a product requirement rather than a hint.
    sendWhere: string; // when and where the "Send files" control appears
    noneEnrolled: string; // devices exist, none has an inbox turned on yet
    setupCta: string; // link text to the /cli Device Inbox instructions
    // Presence (protocol §6). Advisory — see rule 1 above.
    online: string;
    offline: string;
    lastSeen: (when: string) => string; // last heartbeat, localized timestamp
    neverSeen: string; // enrolled but has never heartbeated
    platformLine: (platform: string, version: string) => string; // "linux · Relayium 0.15.0"
    // The device owner's automatic-receive policy (protocol §5).
    policyLabel: string;
    policyOff: string;
    policyAsk: string;
    policyAuto: string;
    dirReady: string; // its receive folder was usable at the last heartbeat
    dirNotReady: string; // …and was not
    // Why a device cannot be sent to. One sentence each, naming what the user
    // would have to change — the remedies genuinely differ.
    blockNotEnrolled: string;
    blockRevoked: string;
    blockCannotReceive: string;
    blockUnsupportedKey: string;
    blockUnsupportedCapability: string;
    blockReceiveOff: string;
    blockUnsupported: string; // a device this build cannot describe (unknown policy / unusable id)
    // True qualifications on a send that IS allowed.
    caveatQueued: string; // offline: it waits in the queue until that device is back
    caveatApproval: string; // policy `ask`: someone at that machine must accept
    caveatDirNotReady: string; // policy `auto`, folder unusable: it waits for a fix
    // The send affordance. Drag is never required: the button is the primary
    // control and the drop zone is an addition to it.
    sendButton: string; // visible label on the choose-files button
    sendButtonLabel: (name: string) => string; // accessible name — names the device
    dropHint: string; // "or drop files here"
    dropActive: string; // shown while a file drag is over this card
    dropRejected: string; // a drop that carried no ordinary file
    // Sender-local phases (PRD §10 items 1-2). Central stores neither.
    phaseEncrypting: (pct: number) => string;
    phaseUploading: (pct: number) => string;
    phaseRegistering: string;
    progressLabel: (name: string) => string; // accessible name of the progress bar
    cancel: string;
    cancelLabel: (name: string) => string; // accessible name of the cancel button
    // Server states (PRD §10 items 3-12 / protocol §13). `uploadedNotSaved`
    // is the sentence that keeps "queued" from being read as "delivered".
    uploadedNotSaved: string;
    stateQueued: string;
    stateNotified: string;
    stateDownloading: string;
    stateVerifying: string;
    stateSaved: string;
    stateSavedAt: (when: string) => string; // the commit timestamp the device reported
    stateAttention: string;
    stateExpired: string;
    stateRevoked: string;
    stateFailedRetryable: string;
    stateFailedTerminal: string;
    stateUnknown: string; // a state this build does not know — never rendered raw
    // Task error tokens (protocol §16), device-submittable plus central's own.
    errDownloadFailed: string;
    errDecryptFailed: string;
    errVerifyFailed: string;
    errDiskFull: string;
    errPermissionDenied: string;
    errDirectoryUnavailable: string;
    errNameConflict: string;
    errUserDeclined: string;
    errUnsupported: string;
    errInternal: string;
    errLeaseExpired: string;
    errAttemptsExhausted: string;
    errKeyRevoked: string;
    errStoredObjectUnavailable: string;
    errUnknown: string;
    // Why a send did not produce a task: central's create refusals (§16) plus
    // the failures decided in this browser.
    sendErrAutoReceiveDisabled: string;
    sendErrDeviceCannotReceive: string;
    sendErrDeviceInboxRevoked: string;
    sendErrStaleTargetKey: string;
    sendErrIdempotencyConflict: string;
    sendErrStoredObjectUnavailable: string;
    sendErrStoredObjectAlreadyBound: string;
    sendErrQueueFull: string;
    sendErrUnsupportedKeyAlgorithm: string;
    sendErrUnsupportedAutoAcceptCapability: string;
    sendErrMalformedWrappedKey: string;
    sendErrInvalidIdempotencyKey: string;
    sendErrTooLarge: string;
    sendErrQuota: string;
    sendErrSignedOut: string;
    sendErrNetwork: string;
    sendErrCancelled: string;
    sendErrUnsupportedKey: string;
    sendErrNoFiles: string;
    sendErrUnknown: string;
    // Managing what was queued.
    cancelTask: string;
    cancelTaskLabel: (name: string) => string;
    cancelTaskConfirm: (name: string) => string; // this deletes the queued ciphertext too
    cancelTaskFailed: string;
    dismiss: string; // clear a finished/failed send from the card
    fileSummary: (n: number, size: string) => string; // what this send carries — count and size only
    privacyNote: string; // names/paths never leave this browser
  };
  // Shared "why an account?" explainer shown on the two login-gated feature pages
  // (/cross-network, /offline-transfer) and, compact, on the /me login gate.
  why: {
    heading: string; // small eyebrow above the three points (compact variant hides it)
    costTitle: string; // point 1 — why login is required
    costBody: string; // these features cost us; free allowance then paid
    selfhostTitle: string; // point 2 — run your own node for free
    selfhostBody: string; // traffic goes through your node, not us, so we don't charge
    selfhostCta: string; // link text to the bring-your-own-node guide
    privacyTitle: string; // point 3 — our promise
    privacyBody: string; // your data and config are only ever usable by you
  };
  // /verify-email — landing page for the emailed verification link (?token=).
  verifyEmail: {
    title: string; // visible h1 and private-route title source
    confirmPrompt: string; // ask the user to confirm their signup password before verifying
    confirmBtn: string; // submit the confirm-password form
    noPasswordLink: string; // "I signed up without a password" — verify passwordless
    checking: string; // transient state while the token is being verified
    successBody: string; // token accepted, session cookie set, redirecting home
    noToken: string; // opened without a ?token= param
    invalidTitle: string; // token rejected (expired / already used / malformed)
    backHome: string; // link back to the app
  };
  // /reset-password — landing page for the emailed reset link (?token=).
  resetPassword: {
    title: string; // visible h1 and private-route title source
    lead: string; // valid-token form introduction
    noToken: string; // opened without a ?token= param
    minHint: string; // client-side password-length hint under the new-password field
    submitBtn: string;
    successBody: string; // token accepted, new password set, session cookie set, redirecting home
    invalidBody: string; // fuller explanation + prompts a fresh forgot-password request
    errGeneric: string; // any other server error on submit
    backHome: string; // link back to the app
  };
  // /magic-link 落地页。这一页存在的唯一理由是它需要一次点击——邮件网关的预取
  // 不会点按钮，所以令牌不会被烧掉、会话 cookie 也不会发给扫描器。
  magicLink: {
    title: string;
    lead: string;
    cta: string;
    working: string;
    done: string;
    expired: string;
    noToken: string;
    home: string;
  };
  // primaryLabel / footerLabel name the two <nav> landmarks. Two landmarks of the
  // same role with the same (or no) accessible name are indistinguishable in a
  // screen reader's landmark list, so both must be named — and named in the
  // user's language, like every other string a screen reader reads aloud.
  nav: {
    primaryLabel: string; footerLabel: string;
    /** App.svelte's footer holds TWO nav landmarks side by side. They need
     *  distinct names — reusing footerLabel for both would make them collide
     *  exactly the way the top nav and the page footer used to. */
    footerLegalLabel: string; footerGuidesLabel: string;
    lanTab: string; crossTab: string; offlineTab: string; cliTab: string; appsTab: string;
    /** Sixth primary destination: /device-inbox. It is a product entry point of
     *  the same rank as the other five (PRD §12), not a page reachable only from
     *  a device card, so it gets a nav label rather than a link buried in prose.
     *  Keep it SHORT — six labels share one row, and nine languages have to fit
     *  a 320px rail without any of them being truncated. */
    deviceInboxTab: string;
  };
  // Full page headings for the cross/offline pages. The nav.*Tab strings are the
  // short pill labels; these are the descriptive <h1> titles.
  crossTitle: string;
  offlineTitle: string;
  cli: { subtitle: string };
  cliCallout: { heading: string; blurb: string; cta: string };
  // /apps downloads/apps hub page (AppsPage.svelte). One end-to-end encrypted
  // transfer across web, CLI, macOS & iOS. The release manifest decides whether
  // the macOS CTA is live; iOS remains "coming soon".
  appsPage: {
    metaTitle: string; // <title> for /apps (page-meta.ts)
    metaDesc: string; // <meta description> for /apps
    heading: string; // <h1>
    subhead: string; // one-line pitch under the h1
    availableBadge: string; // "Available"
    comingSoonBadge: string; // "Coming soon"
    yourPlatformNote: (os: string) => string; // "We think you're on {os}." highlight caption
    cliInstallLabel: string; // label above the curl one-liner
    androidNote: string; // "On Android? Use the web app — it runs in your browser."
    cards: {
      web: { name: string; desc: string; cta: string };
      cli: { name: string; desc: string; cta: string };
      mac: { name: string; desc: string; cta: string };
      ios: { name: string; desc: string }; // no cta — coming soon
    };
  };
  // /device-inbox — the public, first-class entry point for Device Inbox
  // (DeviceInboxPage.svelte). PRD §12 requires this to be a product page, not a
  // marketing stub: it has to explain the model, state the prerequisites, give a
  // signed-out visitor an executable way in, give a signed-in one their real next
  // step, and describe six named platforms with an honest status each.
  //
  // Two invariants are enforced by i18n-device-inbox-page.test.ts because losing
  // either in one translation is a lie only that language's readers would see:
  //
  //  1. **Upload is not save** (PRD §10). `notSavedBody` is the sentence that
  //     keeps "the ciphertext reached Relayium" apart from "the device wrote the
  //     file to disk".
  //  2. **A public download link is a different permission** (PRD §8). A
  //     capability link lets a holder download by hand; it can never make a
  //     device write to disk. `linkBoundary` carries that.
  //
  // Commands, paths and unit names are NOT here — they are locale-invariant and
  // live in device-inbox-platforms.ts.
  deviceInboxPage: {
    metaTitle: string; // <title> for /device-inbox (page-meta.ts + shells.mjs)
    metaDesc: string; // <meta description> for /device-inbox
    heading: string; // <h1>
    subhead: string;
    badges: string[]; // rendered by iteration; no index pairing
    // ── What it is ────────────────────────────────────────────────────────
    howH2: string;
    howLead: string;
    howSteps: string[]; // iterated; the browser → own folder walkthrough
    notSavedH3: string;
    notSavedBody: string;
    // ── Before it can work ────────────────────────────────────────────────
    prereqH2: string;
    prereqAccount: string; // the receiving machine needs an account …
    prereqSameAccount: string; // … the same account as the sender, in the MVP
    prereqEnable: string; // … and receiving must be switched on AT the device
    prereqOffline: string; // offline is a queue, not a refusal
    linkBoundaryH3: string;
    linkBoundary: string; // a share link never writes to a device
    // ── Start (account-aware; the half that is not a static article) ──────
    startH2: string;
    startChecking: string;
    signedOutLead: string;
    signInCta: string;
    createAccountCta: string;
    signedInLead: (email: string) => string;
    /** Heading over the account's own device rows, which carry the send
     *  controls. This block is the primary journey; /me is not on the path. */
    devicesH3: string;
    /** Secondary link to /me. Names what /me is FOR — renaming and revoking —
     *  because the rows here deliberately carry neither. */
    manageDevicesCta: string;
    /** In-page link from a platform section back up to the send block. */
    sendHereCta: string;
    /** The one state whose remedy is another request. */
    retryCta: string;
    /** A background presence refresh failed while rows were already on screen.
     *  They stay — they are the last thing the server actually said — and this
     *  says what may be stale about them. */
    refreshFailed: string;
    /** `/api/devices` did not answer. Says so — and must NOT be worded as "no
     *  devices" or "ready", because the page does not know which is true. */
    stateUnknown: string;
    stateNone: string;
    stateNoInbox: (n: number) => string;
    stateReady: (n: number) => string;
    /** In-page link from the start block down to the server section. */
    setUpServerCta: string;
    // ── Platforms ─────────────────────────────────────────────────────────
    platformsH2: string;
    platformsLead: string;
    statusAvailable: string;
    statusTesting: string;
    statusPlanned: string;
    /** Accessible prefix for the badge, e.g. "Status: available now". */
    statusLabel: (status: string) => string;
    labelUse: string;
    labelSetup: string;
    labelFiles: string;
    labelResidency: string;
    labelSend: string;
    labelRecovery: string;
    labelStop: string;
    /** Keyed by InboxPlatformId, so adding a platform to
     *  device-inbox-platforms.ts is a compile error in all nine locales until
     *  each one has written the section. */
    platforms: Record<
      InboxPlatformId,
      {
        name: string;
        use: string; // what this platform is FOR
        setup: string; // prose around the command block, or the truthful path
        files: string; // where received files land
        residency: string; // does it survive logout / reboot / backgrounding
        send: string; // how you send TO it today
        recovery: string; // what to do when permission or the folder is lost
        stop: string; // pause / stop / revoke
      }
    >;
    /** Why the macOS section has no download button while the app is an
     *  engineering build. Shown only while native-releases.json is unavailable. */
    macNoDownload: string;
    /** Label of the macOS download link, used only if the release manifest
     *  actually carries a build. */
    macDownloadCta: string;
    // ── Boundaries + further reading ──────────────────────────────────────
    safetyH2: string;
    safetyPoints: string[]; // iterated
    docsH2: string;
    docsServerGuide: string;
    docsCli: string;
    docsMyDevices: string;
  };
  // /cli docs page body. Command blocks stay literal English (code); only prose
  // and labels are localised.
  //
  // 四个数组是**按下标**和 cli-page-data.ts 里的常量配对渲染的（第 i 条解释配第 i
  // 个 flag），所以它们的类型是与那些常量等长的**元组**而不是 string[]：少一条、多
  // 一条，或者往常量数组里加了一项却忘了补翻译，都会在这里变成编译错误。
  // 手写"badges 3, pickWhen 5…"那种注释守不住——它自己就曾经漂移过（写着
  // flagMeanings 8，实际是 15）。badges 例外：它是遍历渲染的，不和任何常量配对。
  cliPage: {
    metaTitle: string;
    metaDesc: string;
    badges: string[];
    freenote: string;
    installH2: string;
    installIntro: string;
    installReleases: string;
    installBuild: string;
    installHelp: string;
    whichH2: string;
    whichIntro: string;
    pickWhen: SameLength<typeof PICK_MODES>;
    mode1Title: string;
    mode1Tag: string;
    mode1Body: string;
    mode2Title: string;
    mode2Tag: string;
    mode2Body: string;
    mode3Title: string;
    mode3Tag: string;
    mode3Body: string;
    step1Label: string;
    step1Body: string;
    step2Label: string;
    step2Body: string;
    step3Label: string;
    step3Body: string;
    refH2: string;
    flagsH3: string;
    thFlag: string;
    thApplies: string;
    thMeaning: string;
    flagMeanings: SameLength<typeof FLAG_ROWS>;
    trustH3: string;
    trustIntro: string;
    fileDescs: SameLength<typeof TRUST_FILES>;
    integrityH3: string;
    integrityNote: string;
    footerSource: string;
    footerReleases: string;
    footerBrowser: string;
    guidesH2: string;
    guides: SameLength<typeof GUIDES>;
    syncH2: string;
    syncNote: string;
    cloudH2: string;
    cloudTag: string;
    cloudIntro: string;
    cloudBody: string;
    cloudLoginNote: string;
    cloudInteropNote: string;
    cloudPrivacyNote: string;
    // Device Inbox — the recommended way to get a file from the Web onto a
    // server or NAS you own. It is the only CLI mode that does not need both
    // ends online at once, and the only one whose sending half is a browser.
    //
    // Everything here must describe commands that EXIST. No official container
    // image is published (an image is a supply-chain artifact needing its own
    // signing and provenance). Linux servers use the inspectable installer for
    // a resident low-privilege systemd service; `inbox run` remains the explicit
    // foreground diagnostic/container entrypoint.
    inboxH2: string;
    inboxTag: string; // "recommended" badge
    inboxIntro: string;
    inboxStep1Label: string; // install/update the CLI on the receiving machine
    inboxStep1Body: string;
    inboxStep2Label: string; // relayium login (+ --device-name)
    inboxStep2Body: string;
    inboxStep3Label: string; // install the resident receiver, then status
    inboxStep3Body: string;
    inboxStep4Label: string; // send from My Devices in the browser
    inboxStep4Body: string;
    inboxServiceNote: string; // keeping it running: systemd/launchd/container entrypoint
    inboxNoImageNote: string; // there is no official Relayium container image
    inboxQueueNote: string; // offline devices queue; "uploaded" is not "saved"
    inboxPrivacyNote: string; // sealed to a key only that machine holds
    inboxCta: string; // link text → My Devices
    inboxCtaHint: string; // the account gating, stated truthfully
    inboxDocs: string; // link text → the full CLI receiver document
    // `relayium text` — ephemeral encrypted messages between two machines.
    textH2: string;
    textTag: string;
    textIntro: string;
    textPipeNote: string;
    textSasNote: string;
    textLimitNote: string;
  };
  crossnet: {
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
    signInToSend: string; // gate hint on the mint card when signed out
    relayQuotaWarn: string; // proactive banner on the minter's code card when over the monthly relay cap
    relayQuotaFail: string; // shown when a cross-network transfer fails and no relay was available (over cap)
    // The other three ways a session ends up with no relay. Each used to be
    // silent — the transfer simply sat at 0% and then said "connection failed",
    // which told the user nothing about what to do next. See RelayAvailability.
    relayUnverifiedWarn: string; // owner's email is unverified, so TURN was withheld
    relayUnverifiedFail: string;
    relayUnavailableWarn: string; // /api/ice could not be read (rate limit, network blip)
    relayUnavailableFail: string;
    relayNoneWarn: string; // the server issued no relay for this code at all
    relayNoneFail: string;
  };
  offline: {
    tagline: string; // page subtitle — encrypt-then-store, ciphertext-only server
    pitch: string; // one-paragraph how/why under the header
    signIn: string; // hint beside the sign-in button on the gated card
    cliNote: string; // note that the same flow works from the CLI (relayium up/down)
    cliLink: string; // link label to the cloud-async CLI guide
    planNote: string; // stored transfers use plan limits; precedes a link to /pricing
  };
  crossSell: {
    // Directional cross-links between the two cross-network pages.
    realtime: { lead: string; cta: string }; // rendered on the OFFLINE page → go realtime
    offline: { lead: string; cta: string }; // rendered on the REALTIME page → go offline
  };
  methods: {
    realtime: { name: string; sub: string; badge: string };
    stored: { name: string; sub: string; badge: string };
  };
  pair: {
    sendCode: string;
    enterCode: string;
    enterHint: string;
    joinBtn: string;
    yourCode: string;
    scanHint: string; // caption under the pairing-code QR
    waiting: string;
    queued: (n: number, size: string) => string; // files picked before pairing, auto-send on join
    // Secondary BUTTON: open a room without picking files (receiver-initiated
    // flows). Short — it sits under two primary buttons and must not read as a
    // sentence about them.
    bareConnect: string;
    expiresIn: (s: string) => string; // countdown on the minter's card — names the CODE, not the transfer
    // Says out loud what the countdown does and does not govern. The owner read
    // a shrinking timer next to a live session as "the transfer expires in N",
    // so the two facts (code stops admitting / transfer runs to completion) are
    // stated together rather than left to be inferred.
    ttlNote: string;
    expired: string;
    copy: string;
    copied: string;
    copyLink: string; // copies the full join link for forwarding
    errExpired: string;
    mintFailed: string; // minting a fresh code failed (network/server), not expiry
    back: string; // return from code entry to the send/receive choice
  };
  stored: {
    pick: string;
    dropHint: string; // secondary line in the picker: drag files/folders here too
    uploading: string;
    encrypting: string; // phase 1: encrypting in the browser (progress bar tracks this)
    uploadingNow: string; // phase 2: ciphertext is being POSTed (bar sits full)
    burnLabel: string;
    ttlLabel: string;
    notBackup: string; // gentle reminder: stored links are temporary delivery, not a backup
    ttl1h: string;
    ttl1d: string;
    ttl3d: string;
    ttl7d: string;
    ttl14d: string;
    linkReady: string;
    expiresOn: (when: string) => string; // echoes the link's expiry back to the sender
    copy: string;
    copied: string;
    cliHeading: string; // "Fetch it from the terminal" — CLI command builder heading
    cliIntro: string; // one-line lead-in above the builder
    cliDestLabel: string; // label for the destination-directory input
    cliDestHint: string; // hint: paste your pwd, or leave . for the current dir
    cliCopy: string; // copy button for the full `relayium down …` command
    errTooLarge: string;
    errQuota: string;
    errUpload: string;
    // 提示发送方：这批文件大到接收方的手机浏览器可能下载不了。只提示，不拦上传。
    bigNote: string;
  };
  download: {
    title: string; // private download route title source
    loading: string;
    files: string;
    summary: (count: number, size: string) => string; // file count + total size
    expiresIn: (left: string) => string; // countdown, `left` pre-formatted by formatRemaining
    durUnits: { d: string; h: string; m: string }; // suffixes for the countdown
    zeroKnowledge: string; // reassurance + phishing caution
    burnWarning: string; // shown only for burn-after-read links
    sendPrompt: string; // reverse-acquisition lead-in
    sendCta: string; // reverse-acquisition button
    downloadBtn: string;
    downloading: string;
    done: string;
    notFound: string;
    noKey: string;
    decryptFail: string;
    unsupported: string;
    netFail: string; // download connection dropped — retryable, distinct from a decrypt failure
    // 字节都取到了，卡在"交给磁盘"这一段（service worker 被回收 / 部署换版 / 浏览器
    // 没来取流）。同样可重试，且**绝不能**落进 decryptFail —— 文件一个字节都没错。
    swFail: string;
    cancelled: string; // user cancelled the browser download — not a failure, and NOT a decrypt error
    // 服务端答了 429。两个闸门共用这个状态码：per-IP 的下载起始限流，和发件人账号的
    // 月流量上限。**只有英文响应体**能区分它们，而解析那段文本是把 UI 归因钉死在一句
    // 服务端文案上 —— 所以这里一句话同时覆盖两者，说清「等一会儿再开这条链接」。
    // 刻意不给重试按钮：立刻重试只会更快撞上同一个闸门。
    limited: string;
    // 结构化的非 404 / 非 429 响应失败（最终 403、5xx）。全都发生在读密文**之前**，
    // 所以既不是「链接指不向任何东西」，也绝不是「密钥错误或文件损坏」——一个字节都
    // 没解密过。服务端/存储侧的暂时故障，可重试。
    unavailable: string;
    retry: string; // button: retry a network-failed download
    // 没有流式落盘能力的浏览器（Firefox/Safari/所有手机）必须把整个文件读进
    // 内存，大文件足以掀掉页面 —— 下载开始前先说清楚，并给一个明确的继续入口。
    memWarn: (size: string) => string; // 为什么 + 会怎样，带上这批文件的总大小
    memWarnHow: string; // 怎么办：电脑上的 Chrome/Edge，或命令行工具
    memWarnContinue: string; // 按钮：仍要下载
    // ── 终端下载：两条路，而且它们不是同一个承诺 ──────────────────────────
    //
    // installed* 面向「这台机器已经装了 CLI」；temp* 是「无需安装」的诚实版本：
    // 把官方 CLI 下到临时目录、验签、跑一次、删掉。每种语言都必须同时说清
    //   (1) 这是临时执行而不是安装，
    //   (2) 发布签名 + 校验和都验过、任一不过就停，
    // 并且**不得**暗示普通 curl 能解密这条链接 —— 它做不到：#k= 从不发给服务器，
    // 服务端也没有内容密钥，curl 拿到的只是密文。i18n-temp-downloader.test.ts
    // 对九种语言逐条检查这三件事。
    cli: {
      heading: string; // 分区标题：也可以在终端里下载
      installedTitle: string; // 已装 CLI 的那条路
      installedIntro: string; // 一句话：在要落盘的那台机器上跑，下载不需要登录
      tempTitle: string; // 无需持久安装
      tempMeans: string; // 诚实定义：不写系统目录/不要 root/不登录/不留配置和设备身份
      tempCurlNote: string; // 为什么普通 curl 不成立（只能存密文，解不了）
      steps: string[]; // 可见的六步，与 tempDownloaderScript 的六段注释一一对应
      verified: string; // 供应链：checksums.txt 的 ECDSA 签名 + 压缩包 SHA-256
      keyStaysLocal: string; // #k= 只作为本地进程的参数，不进 URL / 服务端 / 日志
      windowsTitle: string;
      windowsNote: string; // POSIX 块覆盖不到 Windows 时的如实指引
      releasesLink: string; // 指向发布页的链接文案
    };
  };
  features: { title: string; sub: string; secureLink: string; items: { title: string; desc: string }[] };
  howItWorks: {
    realtime: HowSection;
    offline: HowSection;
  };
  // The three transfer modes, side by side. Two of them used to be here; LAN was
  // missing, which quietly made "which mode do I want?" a choice between the two
  // that need an account. Every column heading is a link to that mode's page, so
  // each of these three names has to work as link text on its own.
  compare: {
    title: string;
    sub: string;
    colFeature: string;
    colLan: string; // same-network, account-free
    colRealtime: string; // live pairing code, small files and text
    colStored: string; // encrypted upload + download link, the large-file path
    rows: { label: string; lan: string; realtime: string; stored: string }[];
  };
  useCases: {
    title: string;
    sub: string;
    items: { title: string; desc: string }[];
  };
  faq: {
    title: string;
    sub: string;
    items: { q: string; a: string }[]; // shared questions shown on every FAQ
    home: { q: string; a: string }[]; // LAN / same-network realtime page extras
    cross: { q: string; a: string }[]; // cross-network realtime page extras
    offline: { q: string; a: string }[]; // async download-link / stored page extras
  };
  crossPitch: string; // one-line pitch under the realtime page header
  homeCross: { title: string; desc: string; realtimeCta: string; offlineCta: string }; // homepage → the two cross-network pages
  // Homepage section that puts ephemeral text next to files instead of hiding it
  // behind the transfer surface. It must not read as stored chat: every locale
  // has to keep all three `points` (peer-scoped E2E · realtime, both online ·
  // never stored) and the `limit` line, which is the only place the homepage
  // states the per-message ceiling and the "send it as a file" escape hatch.
  // `limit` takes TEXT_MAX_BYTES so the number tracks text-wire.ts rather than
  // being frozen into nine translations.
  homeText: {
    title: string;
    sub: string;
    points: string[];
    limit: (max: number) => string;
  };
  // Footer labels for the generated static documents. `releases` is not a legal
  // page — nor is `support` — but it is the same kind of footer link to the same
  // kind of generated directory, and splitting the group would only add a second
  // place to look. Keep the values equal to RELEASES_LABELS in
  // scripts/pages/shared.mjs, which labels the same link on the static pages.
  legal: { privacy: string; terms: string; security: string; support: string; releases: string };
  // Footer link label for the generated static Guides hub page.
  learn: { hub: string };
  // Client-local "recent transfers" panel (localStorage-backed, this device only).
  historyTitle: string;
  historyEmpty: string;
  historyClear: string;
  historyKeep: string;
  // Per-device "advanced verification" preference (verify-pref.svelte.ts).
  // Default OFF: the SAS comparison is an optional endpoint check, not the thing
  // that protects the content, so `unaffected` has to say plainly what the switch
  // does NOT touch — otherwise "verification: off" reads as "encryption: off".
  verify: {
    title: string;
    toggle: string;
    note: string; // what the comparison is and what it detects
    unaffected: string; // what is never gated on it (keys, ciphertext relay, save consent)
  };
  // Unified peer workspace (`link/1`). One encrypted link carries both the
  // file and the text lane, so exactly one header owns the peer name, link state,
  // path badge, verification code and disconnect action. Legacy peers never reach
  // these strings — they keep the separate file and message surfaces.
  workspace: {
    heading: string; // accessible name of the trust header region
    peer: (name: string) => string;
    disconnect: string; // closes both lanes and erases the link keys
    // ── link states, addressed by PeerLinkStatus ──
    // All five MUST be plain strings; the header indexes them by status.
    stateIdle: string;
    stateRequesting: string;
    stateConnecting: string;
    stateOpen: string;
    stateFailed: string;
    // Explains that one encrypted connection carries both files and messages,
    // and which consent steps that does and does not include. It must NOT call
    // the link "verified" or imply a code comparison happened: commit-reveal and
    // AEAD are what always hold — protocol integrity, not identity — and
    // advanced verification is off by default, so on a default session nobody
    // compared anything and the peer is not established as the intended person.
    // What always holds on top of that is the file-receive prompt.
    lanesNote: string;
    // ── the bounded lifetime of a RELAYED link ──
    // A relayed link lives on a server-issued TURN credential with a stated
    // expiry (relay-deadline.ts). These three describe that boundary: the
    // warning while the link is still fully working, the terminal state at it,
    // and the action that answers the terminal state. LAN and P2P links have no
    // such boundary and never render any of them.
    //
    // `endedRelay` must read as "time ran out on this connection, start
    // another" — never as an error or a failure of either device, and never as
    // something waiting will fix.
    relayExpiring: string;
    endedRelay: string;
    // The other terminal reason: the transport died while this page had no
    // signalling membership to rebuild through (dropped, rejoined under a new
    // identity, or refused). Must not promise a retry either.
    endedSignaling: string;
    restart: string; // the one action on a terminal card
    // A link that WORKS but could not be brought back if it dropped. Present
    // tense, and explicitly not a failure — it is a warning, not a state.
    //
    // It must say BOTH halves, because the two are easy to conflate and only
    // one of them is bad news: the whole workspace keeps working — new file
    // batches and new messages included, not merely whatever was already in
    // flight — and it cannot be restored once the transport itself drops. Copy
    // that promises only "what is already open" reads as "this is dying, stop
    // using it", which is the opposite of what the connection can still do.
    recoveryUnavailable: string;
    // ── files queued before the link existed (OS share, or picked pre-pairing) ──
    // The workspace's standing release control. It exists so dismissing the send
    // confirmation cannot strand a batch: inside a workspace there is no peer
    // card left to send from. The button must read as "send these", not as
    // "confirm" — pressing it re-asks the confirmation.
    queuedRelease: (count: number, size: string) => string;
    queuedReleaseBtn: string;
    // ── queued outbound file batches ──
    queuedTitle: (count: number) => string;
    queuedHint: string;
    queuedRemove: string;
    queuedFiles: (count: number) => string;
    // ── the one action that starts a workspace ──
    // A link-capable LAN peer offers exactly ONE primary action instead of the
    // separate file / folder / message fork: everything the fork used to choose
    // between lives inside the workspace, on one connection. These three strings
    // must therefore promise files AND messages, never one of the two.
    open: string; // the single primary button on the peer card
    openWith: (name: string) => string; // the card's own lead line
    openHint: string; // secondary line when several devices are listed
  };
  // Ephemeral encrypted messages. In-memory only — nothing here is ever written to
  // localStorage, unlike the transfer history above.
  text: {
    panelTitle: string;
    open: string; // the button that starts a session
    availabilityHint: string; // visible before a capable peer is present; never an action
    composePlaceholder: string;
    send: string;
    sendHint: string; // must name Enter and the send chord; see the i18n test
    byteCount: (used: number, max: number) => string;
    useFileInstead: string;
    requestHead: (name: string) => string;
    accept: string;
    reject: string;
    // ── session states ──
    connecting: string;
    waitingAccept: string;
    open_: string; // the state "open"; `open` above is the button
    ended: string;
    // ── terminal errors, addressed by TextErrorKey ──
    // These six are indexed as t.text[errorKey] by the panel, so every one of them
    // MUST be a plain string. A parameterised one would render as "function…".
    // The byte limit is not named here on purpose: the composer's byteCount
    // counter sits next to this line and already shows it, and two copies of the
    // same number drift apart.
    tooLong: string;
    flooding: string;
    unsupported: string;
    peerBusy: string;
    failed: string;
    refused: string;
    // ── history ──
    copy: string;
    copied: string;
    clear: string;
    clearConfirm: string;
    emptyHistory: string;
    you: string;
    peer: (name: string) => string;
    newMessageFrom: (name: string) => string; // OS notification: the name, never a body
    ephemeralNote: string;
    clipboardNote: string;
    sasCompare: string;
  };
}

export function legalUrl(slug: "privacy" | "terms" | "security" | "support", l: Lang): string {
  return pageUrl(slug, l);
}

/** URL of a generated static page (article/landing) in the given language. */
export function pageUrl(slug: string, l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}

export type StatusKey = keyof Messages["status"];
