// Lightweight, dependency-free i18n for the Relayium SPA, driven by Svelte 5 runes.
// The current language lives in module-level $state, so any component that reads
// `messages[lang()]` inside a $derived/template re-renders when the language changes.

export type Lang = "zh" | "en" | "ja" | "ko" | "de" | "fr";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

export interface Messages {
  langLabel: string;
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
  accept: string;
  decline: string;
  sendTo: (name: string) => string;
  recvFrom: (name: string) => string;
  fileCounter: (i: number, n: number) => string;
  close: string;
  cancel: string; // abort an in-progress transfer and return to idle
  startOver: string; // leave the current room and return to the method choices
  peersTitle: string;
  crossPeersTitle: string; // heading for the single connected peer on the cross-network page
  emptyPeers: string;
  dragSendOne: (name: string) => string;
  dragSendMany: string;
  pickHint: (max: number) => string;
  pickSendTo: (name: string) => string; // prominent single-peer send label
  generating: string; // transient "creating…" state while a code/link is minted
  footer: string;
  busy: string;
  tooMany: (max: number, n: number) => string;
  titleDefault: string;
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
    noSave: string;
    connectFail: string;
  };
  account: {
    signIn: string;
    signOut: string;
    email: string;
    sendLink: string;
    linkSent: string;
    continueGoogle: string;
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
    changePassword: string;
    setPassword: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    pwChanged: string;
    errCurrentWrong: string;
    errMismatch: string;
  };
  nav: { lanTab: string; crossTab: string };
  crossnet: {
    sendAcross: string;
    loginFirst: string;
    shareHint: string;
    copy: string;
    copied: string;
    connecting: string;
    linkDead: string;
    realtimeTitle: string;
    realtimeSub: string;
    realtimeFoot: string;
  };
  methods: {
    pairing: { name: string; sub: string; badge: string };
    share: { name: string; sub: string; badge: string; signIn: string };
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
    expiresIn: (s: string) => string;
    expired: string;
    copy: string;
    copied: string;
    copyLink: string; // copies the full join link for forwarding
    errExpired: string;
  };
  stored: {
    pick: string;
    uploading: string;
    burnLabel: string;
    ttlLabel: string;
    ttl1d: string;
    ttl3d: string;
    ttl7d: string;
    linkReady: string;
    expiresOn: (when: string) => string; // echoes the link's expiry back to the sender
    copy: string;
    copied: string;
    errTooLarge: string;
    errQuota: string;
    errUpload: string;
  };
  download: {
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
  };
  features: { title: string; sub: string; items: { title: string; desc: string }[] };
  howItWorks: {
    title: string;
    sub: string;
    ways: { icon: string; name: string; how: string; tag: string }[];
  };
  compare: {
    title: string;
    sub: string;
    colFeature: string;
    colRealtime: string;
    colStored: string;
    rows: { label: string; realtime: string; stored: string }[];
  };
  useCases: {
    title: string;
    sub: string;
    items: { icon: string; title: string; desc: string }[];
  };
  faq: {
    title: string;
    sub: string;
    items: { q: string; a: string }[];
  };
  crossPitch: string; // one-line cross-network pitch under the two cards
  homeCross: { title: string; desc: string; cta: string }; // homepage → cross-network CTA
  legal: { privacy: string; terms: string };
}

export function legalUrl(slug: "privacy" | "terms", l: Lang): string {
  return l === "en" ? `/${slug}` : `/${l}/${slug}`;
}

export type StatusKey = keyof Messages["status"];

const zh: Messages = {
  langLabel: "语言",
  tagline: "端到端加密的点对点文件传输 · 文件不经过服务器",
  connected: (n) => `已连接 · 本机 ${n}`,
  ipLabel: "公网 IP",
  connecting: "正在连接信令服务器…",
  unavailable: "无法使用",
  unsupported: "需要 HTTPS（或 localhost）才能进行加密传输。请通过 https:// 访问本页面。",
  guideTitle: "如何使用",
  step1: "在同一网络下的另一台设备或浏览器打开本页面（同一公网 IP 归为同一「房间」）。",
  step2: "双方会出现在下方「附近的设备」列表中。",
  step3: (m) => `点击对方卡片选择文件，或把文件拖到对方卡片上（一次最多 ${m} 个）。`,
  step4: "对方点「接收」，核对两边校验码一致后开始传输。",
  hint: "推荐 Chrome（大文件流式落盘、多文件可直接选目标文件夹，不占内存）。若同一路由器下互相看不到设备，请关闭路由器的「AP 隔离 / 客户端隔离」。",
  requestHead: (n, c, s) => `📥 ${n} 想发送 ${c} 个文件 · 共 ${s}`,
  codeLabel: "校验码",
  codeCompare: "请与发送方屏幕核对一致后再接收",
  accept: "接收",
  decline: "拒绝",
  sendTo: (n) => `发送 → ${n}`,
  recvFrom: (n) => `接收 ← ${n}`,
  fileCounter: (i, n) => `文件 ${i}/${n}`,
  close: "关闭",
  cancel: "取消",
  startOver: "← 重新选择",
  peersTitle: "附近的设备",
  crossPeersTitle: "已连接的对方",
  pickSendTo: (n) => `点击或拖放文件，发送给 ${n}`,
  generating: "生成中…",
  emptyPeers: "还没有其它设备。请在同一网络下的另一台设备 / 另一个浏览器窗口打开本页面。",
  dragSendOne: (name) => `松手发送给 ${name}`,
  dragSendMany: "拖到某台设备上发送",
  pickHint: (m) => `点击选择文件 · 或拖放到此处（最多 ${m} 个）`,
  footer: "端到端加密（X25519 + AES-256-GCM）· 信令服务器只转发连接信息，看不到文件内容",
  busy: "已有传输进行中，请等待完成",
  tooMany: (m, n) => `一次最多 ${m} 个文件，已忽略多余的 ${n} 个`,
  titleDefault: "Relayium — 端到端加密文件传输",
  status: {
    connecting: "正在建立加密连接…",
    waitingAccept: "等待对方确认接收…",
    rejected: "对方已拒绝 ✗",
    sending: "发送中…",
    finishing: "正在完成…",
    sendDone: (n) => `发送完成 ✓（${n} 个文件）`,
    sendFail: "发送失败 ✗",
    receiving: "接收中…",
    recvDone: (n) => `接收完成 ✓（${n} 个文件）`,
    integrityFail: "完整性校验失败 ✗",
    recvFail: "接收失败 ✗",
    noSave: "未选择保存位置，已取消",
    connectFail: "建立连接失败 ✗",
  },
  account: {
    signIn: "登录",
    signOut: "退出登录",
    email: "邮箱地址",
    sendLink: "给我发送登录链接",
    linkSent: "登录链接已发送，请查收邮箱。",
    continueGoogle: "用 Google 继续",
    or: "或",
    signedInAs: (e) => `已登录：${e}`,
    password: "密码",
    createAccount: "注册",
    logInBtn: "登录",
    toRegister: "没有账号？去注册",
    toLogin: "已有账号？去登录",
    errTooShort: "密码至少 8 位。",
    errEmailTaken: "该邮箱已注册，请直接登录。",
    errLogin: "邮箱或密码错误。",
    changePassword: "修改密码",
    setPassword: "设置密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    confirmPassword: "确认新密码",
    pwChanged: "密码已更新，其他设备已登出。",
    errCurrentWrong: "当前密码不正确。",
    errMismatch: "两次输入的新密码不一致。",
  },
  nav: { lanTab: "局域网传输", crossTab: "跨网络传输" },
  crossnet: {
    sendAcross: "生成分享链接",
    loginFirst: "请先登录后再发起跨网络传输",
    shareHint: "把下面的链接发给对方；对方打开后，在下方核对 6 位校验码即可传输",
    copy: "复制链接",
    copied: "已复制",
    connecting: "正在通过跨网络链接连接…",
    linkDead: "链接已失效或正在被使用，请向发送方索要新链接",
    realtimeTitle: "实时直传",
    realtimeSub: "对方此刻在线 · 点对点直连 · 文件不经服务器",
    realtimeFoot: "免登录 · 登录可提升连通性",
  },
  methods: {
    pairing: { name: "🔢 配对码", sub: "一方生成 6 位配对码，另一方输入即刻点对点直连，最快上手。", badge: "免登录" },
    share: { name: "🔗 分享链接", sub: "生成带中继的链接或二维码发给对方，打开即实时直连，连通性更好。", badge: "需登录", signIn: "登录后即可生成分享链接" },
    stored: { name: "📦 下载链接", sub: "浏览器先加密再暂存，对方无需在线、无需登录，凭链接随时下载。", badge: "对方可离线" },
  },
  pair: {
    sendCode: "生成配对码",
    enterCode: "输入配对码",
    enterHint: "向对方索取 6 位配对码",
    joinBtn: "连接",
    yourCode: "你的配对码 —— 念给对方",
  scanHint: "或让对方扫码 / 打开链接加入",
    waiting: "等待对方加入…",
    expiresIn: (s) => `${s} 后失效`,
    expired: "配对码已失效，请重新生成",
    copy: "复制",
    copied: "已复制",
    copyLink: "复制链接",
    errExpired: "配对码无效或已过期",
  },
  stored: {
    pick: "选择文件上传",
    uploading: "正在加密并上传…",
    burnLabel: "阅后即焚（首次下载后删除）",
    ttlLabel: "有效期",
    ttl1d: "1 天",
    ttl3d: "3 天",
    ttl7d: "7 天",
    linkReady: "链接已生成，发给对方即可下载：",
    expiresOn: (w) => `此链接将于 ${w} 到期`,
    copy: "复制链接",
    copied: "已复制",
    errTooLarge: "文件超过单文件大小上限。",
    errQuota: "已超过今日上传额度，请稍后再试。",
    errUpload: "上传失败，请重试。",
  },
  download: {
    loading: "正在读取链接…",
    files: "待下载文件",
    summary: (c, s) => `共 ${c} 个文件 · 合计 ${s}`,
    expiresIn: (l) => `有效期剩余 ${l}`,
    durUnits: { d: "天", h: "小时", m: "分钟" },
    zeroKnowledge: "🔒 文件在发送方浏览器端加密，连我们的服务器也无法解密或查看内容。下载前请确认链接来自你信任的发送者。",
    burnWarning: "⚠️ 此文件仅可下载一次，下载完成后立即永久删除、不可恢复。请确保网络稳定，一次下完。",
    sendPrompt: "想反过来发送文件？",
    sendCta: "用 Relayium 安全发送 →",
    downloadBtn: "下载并解密",
    downloading: "正在下载并解密…",
    done: "下载完成 ✓",
    notFound: "链接无效、已过期或已被下载删除。",
    noKey: "链接不完整：缺少解密密钥（#k=）。",
    decryptFail: "解密失败：密钥错误或文件已损坏。",
    unsupported: "需要 HTTPS（或 localhost）才能解密下载。",
  },
  features: {
    title: "为什么选 Relayium",
    sub: "隐私优先、点对点直连、协议开源——文件传输本该如此。",
    items: [
      { title: "端到端加密", desc: "X25519 + AES-256-GCM，密钥只在两台设备间协商，服务器无从解密。" },
      { title: "文件不经服务器", desc: "实时直传通过 WebRTC 在设备间直接流动，绝不经过服务器；可选的下载链接仅为零知识加密暂存。" },
      { title: "防中间人", desc: "两边屏幕显示同一段校验码（SAS），核对一致即可排除中间人窃听。" },
      { title: "跨平台", desc: "Windows、macOS、Linux、Android、iOS，任意现代浏览器都能用，无需安装。" },
      { title: "开源可审计", desc: "协议与全部代码在 GitHub 公开，任何人都能审查、自托管或贡献。" },
      { title: "阅后即焚 · 可控有效期", desc: "下载链接可设 1/3/7 天有效期或首次下载后即焚，不留长期痕迹。" },
    ],
  },
  howItWorks: {
    title: "跨网络，三种方式",
    sub: "不在同一个局域网也能传：根据对方是否在线、是否愿意登录，挑一种最顺手的。",
    ways: [
      { icon: "🔢", name: "配对码", how: "双方都在线时，一方点「生成配对码」得到 6 位数字，另一方输入即刻建立点对点直连。免登录、最快上手。", tag: "文件不经服务器" },
      { icon: "🔗", name: "分享链接", how: "登录后生成一条带中继的分享链接或二维码，发给对方；对方打开即与你实时直连，连通性更好。即便流量经中继，也是端到端加密、无法解密。", tag: "端到端加密" },
      { icon: "📥", name: "下载链接", how: "浏览器先加密再上传，服务器只存密文。对方无需在线、无需登录，凭链接随时下载，可设有效期或阅后即焚。", tag: "仅存密文" },
    ],
  },
  compare: {
    title: "两种模式，怎么选",
    sub: "「实时直传」适合双方此刻都在线；「下载链接」适合对方稍后再取。",
    colFeature: "对比项",
    colRealtime: "⚡ 实时直传",
    colStored: "📦 下载链接",
    rows: [
      { label: "是否需登录", realtime: "免登录（登录可增强连通性）", stored: "发送方需登录" },
      { label: "对方是否需在线", realtime: "需要，双方同时在线", stored: "不需要，可异步下载" },
      { label: "文件是否经服务器", realtime: "否 · 点对点直连（分享链接在打洞失败时可经加密中继）", stored: "是，但仅存零知识密文" },
      { label: "有效期", realtime: "即传即走，不留存", stored: "1 / 3 / 7 天，或阅后即焚" },
      { label: "适合场景", realtime: "双方在线时直传大文件", stored: "对方不在线，或一次发多人取" },
    ],
  },
  useCases: {
    title: "适合这些场景",
    sub: "从异地协作到隐私敏感的一次性投递，都能覆盖。",
    items: [
      { icon: "🌍", title: "异地发大文件", desc: "把几个 G 的视频、设计稿或数据集直接发给外地的同事或家人，浏览器流式落盘，不占内存、不压缩画质。" },
      { icon: "⏳", title: "对方暂时不在线", desc: "生成一条加密下载链接，设好有效期发过去，对方有空时再取；也能一条链接发给多位接收人。" },
      { icon: "📱", title: "手机 ↔ 电脑互传", desc: "跨系统、跨网络在自己的设备之间搬文件，扫码或输码即连，不必依赖网盘或数据线。" },
      { icon: "🔒", title: "隐私敏感的一次性投递", desc: "端到端加密加上 SAS 校验码防中间人，配合阅后即焚，适合传合同、证件、密钥等敏感文件。" },
    ],
  },
  faq: {
    title: "常见问题",
    sub: "关于跨网络传输、连通性与安全，你可能想知道的。",
    items: [
      { q: "需要安装 App 吗？", a: "不需要。用任意现代浏览器打开网页即可传输，推荐 Chrome（大文件流式落盘、可选目标文件夹，不占内存）。" },
      { q: "连不上 / 看不到对方怎么办？", a: "配对码是纯点对点直连（仅走 STUN 打洞）；若网络受限连不上，改用分享链接更稳——它带 TURN 中继，打洞失败时会自动经加密中继转发。仍不行就用下载链接（异步、最稳妥）。" },
      { q: "文件能多大？", a: "实时直传采用流式传输，理论上没有硬性大小上限；下载链接受单文件大小上限与每日额度限制，页面会给出提示。" },
      { q: "服务器能看到我的文件吗？", a: "不能。实时直传的文件根本不经过服务器；下载链接在浏览器端先加密，服务器只保存无法解密的密文，密钥只存在于链接的分享者与接收者之间。" },
      { q: "一定要注册账号吗？", a: "配对码方式完全免登录。分享链接和下载链接需要发送方登录，以便生成带中继的链接与暂存密文。" },
      { q: "是开源的吗？", a: "是。协议设计与全部前后端代码都在 GitHub 公开，可自由审查、自托管或参与贡献。" },
    ],
  },
  crossPitch: "同一网络下用「局域网传输」更省事；不在同一网络，就用下面三种方式跨网直传。",
  homeCross: {
    title: "不在同一个网络？",
    desc: "跨网络传输支持配对码、分享链接与加密下载链接，异地也能端到端加密直传。",
    cta: "前往跨网络传输 →",
  },
  legal: { privacy: "隐私政策", terms: "服务条款" },
};

const en: Messages = {
  langLabel: "Language",
  tagline: "End-to-end encrypted peer-to-peer file transfer · files never touch the server",
  connected: (n) => `Connected · this device ${n}`,
  ipLabel: "public IP",
  connecting: "Connecting to the signaling server…",
  unavailable: "Unavailable",
  unsupported: "Encrypted transfer requires HTTPS (or localhost). Please open this page over https://.",
  guideTitle: "How to use",
  step1: "Open this page on another device or browser on the same network (devices sharing a public IP form one “room”).",
  step2: "Both devices then appear in the “Nearby devices” list below.",
  step3: (m) => `Click a device card to choose files, or drag files onto it (up to ${m} at a time).`,
  step4: "The recipient clicks “Accept”; once both verification codes match, the transfer begins.",
  hint: "Chrome is recommended (streams large files straight to disk and lets you pick a target folder for multiple files, without using memory). If devices on the same router can’t see each other, turn off the router’s “AP isolation / client isolation”.",
  requestHead: (n, c, s) => `📥 ${n} wants to send ${c} file(s) · ${s} total`,
  codeLabel: "Verification code",
  codeCompare: "compare it with the sender’s screen before accepting",
  accept: "Accept",
  decline: "Decline",
  sendTo: (n) => `Send → ${n}`,
  recvFrom: (n) => `Receive ← ${n}`,
  fileCounter: (i, n) => `File ${i}/${n}`,
  close: "Close",
  cancel: "Cancel",
  startOver: "← Start over",
  peersTitle: "Nearby devices",
  crossPeersTitle: "Connected peer",
  pickSendTo: (n) => `Click or drop files to send to ${n}`,
  generating: "Creating…",
  emptyPeers: "No other devices yet. Open this page on another device or browser window on the same network.",
  dragSendOne: (name) => `Release to send to ${name}`,
  dragSendMany: "Drop onto a device to send",
  pickHint: (m) => `Click to choose files · or drop them here (up to ${m})`,
  footer: "End-to-end encrypted (X25519 + AES-256-GCM) · the signaling server only relays connection info and never sees file contents",
  busy: "A transfer is already in progress — please wait for it to finish",
  tooMany: (m, n) => `Up to ${m} files at a time; ignored the extra ${n}`,
  titleDefault: "Relayium — end-to-end encrypted file transfer",
  status: {
    connecting: "Establishing an encrypted connection…",
    waitingAccept: "Waiting for the recipient to accept…",
    rejected: "Declined by the recipient ✗",
    sending: "Sending…",
    finishing: "Finishing…",
    sendDone: (n) => `Sent ✓ (${n} file${n === 1 ? "" : "s"})`,
    sendFail: "Send failed ✗",
    receiving: "Receiving…",
    recvDone: (n) => `Received ✓ (${n} file${n === 1 ? "" : "s"})`,
    integrityFail: "Integrity check failed ✗",
    recvFail: "Receive failed ✗",
    noSave: "No save location chosen — cancelled",
    connectFail: "Connection failed ✗",
  },
  account: {
    signIn: "Sign in",
    signOut: "Sign out",
    email: "Email address",
    sendLink: "Email me a sign-in link",
    linkSent: "Check your email for a sign-in link.",
    continueGoogle: "Continue with Google",
    or: "or",
    signedInAs: (e) => `Signed in as ${e}`,
    password: "Password",
    createAccount: "Create account",
    logInBtn: "Log in",
    toRegister: "No account? Sign up",
    toLogin: "Have an account? Log in",
    errTooShort: "Password must be at least 8 characters.",
    errEmailTaken: "That email is already registered — please log in.",
    errLogin: "Wrong email or password.",
    changePassword: "Change password",
    setPassword: "Set a password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    pwChanged: "Password updated. Other devices have been signed out.",
    errCurrentWrong: "Current password is incorrect.",
    errMismatch: "The new passwords do not match.",
  },
  nav: { lanTab: "LAN transfer", crossTab: "Cross-network" },
  crossnet: {
    sendAcross: "Generate share link",
    loginFirst: "Please sign in before starting a cross-network transfer",
    shareHint: "Send this link to the other person; once they open it, verify the 6-digit code below to transfer",
    copy: "Copy link",
    copied: "Copied",
    connecting: "Connecting over the cross-network link…",
    linkDead: "This link is invalid or already in use — ask the sender for a new one",
    realtimeTitle: "Realtime direct",
    realtimeSub: "Both online now · peer-to-peer · files never touch the server",
    realtimeFoot: "No sign-in needed · sign in for better connectivity",
  },
  methods: {
    pairing: { name: "🔢 Pairing code", sub: "One side creates a 6-digit code, the other types it in for an instant peer-to-peer link. Fastest to start.", badge: "No sign-in" },
    share: { name: "🔗 Share link", sub: "Generate a relayed link or QR code and send it over; opening it connects you in realtime, with better connectivity.", badge: "Sign-in", signIn: "Sign in to generate a share link" },
    stored: { name: "📦 Download link", sub: "Your browser encrypts then stores; the recipient downloads anytime, no live session and no account needed.", badge: "Offline OK" },
  },
  pair: {
    sendCode: "Create a pairing code",
    enterCode: "Enter a pairing code",
    enterHint: "Ask the sender for their 6-digit code",
    joinBtn: "Connect",
    yourCode: "Your pairing code — read it to the other person",
  scanHint: "or have them scan / open the link to join",
    waiting: "Waiting for the other device to join…",
    expiresIn: (s) => `expires in ${s}`,
    expired: "Pairing code expired — generate a new one",
    copy: "Copy",
    copied: "Copied",
    copyLink: "Copy link",
    errExpired: "Pairing code is invalid or expired",
  },
  stored: {
    pick: "Choose files to upload",
    uploading: "Encrypting and uploading…",
    burnLabel: "Burn after reading (delete on first download)",
    ttlLabel: "Expires in",
    ttl1d: "1 day",
    ttl3d: "3 days",
    ttl7d: "7 days",
    linkReady: "Link ready — send it to the recipient to download:",
    expiresOn: (w) => `This link expires on ${w}`,
    copy: "Copy link",
    copied: "Copied",
    errTooLarge: "The file exceeds the single-file size limit.",
    errQuota: "You've exceeded today's upload quota — please try again later.",
    errUpload: "Upload failed, please try again.",
  },
  download: {
    loading: "Reading the link…",
    files: "Files to download",
    summary: (c, s) => `${c} file${c === 1 ? "" : "s"} · ${s} total`,
    expiresIn: (l) => `Expires in ${l}`,
    durUnits: { d: "d", h: "h", m: "m" },
    zeroKnowledge: "🔒 Files are encrypted in the sender's browser — not even our server can decrypt or view them. Before downloading, make sure the link comes from someone you trust.",
    burnWarning: "⚠️ This file can be downloaded only once — it's permanently deleted right after, with no recovery. Make sure your connection is stable enough to finish in one go.",
    sendPrompt: "Need to send files back?",
    sendCta: "Send securely with Relayium →",
    downloadBtn: "Download & decrypt",
    downloading: "Downloading and decrypting…",
    done: "Download complete ✓",
    notFound: "This link is invalid, expired, or already downloaded and deleted.",
    noKey: "Incomplete link: the decryption key (#k=) is missing.",
    decryptFail: "Decryption failed: wrong key or corrupted file.",
    unsupported: "Decryption requires HTTPS (or localhost).",
  },
  features: {
    title: "Why Relayium",
    sub: "Privacy-first, peer-to-peer, open source — file transfer the way it should be.",
    items: [
      { title: "End-to-end encrypted", desc: "X25519 + AES-256-GCM; keys are negotiated only between the two devices and the server can't decrypt." },
      { title: "Files never touch the server", desc: "In realtime mode, bytes flow device-to-device over WebRTC and never touch the server; the optional download-link mode stores only zero-knowledge ciphertext." },
      { title: "Man-in-the-middle check", desc: "Both screens show the same code (SAS); match it to rule out an eavesdropping MITM." },
      { title: "Cross-platform", desc: "Windows, macOS, Linux, Android, iOS — any modern browser, nothing to install." },
      { title: "Open source & auditable", desc: "The protocol and all the code are public on GitHub — anyone can review it, self-host, or contribute." },
      { title: "Ephemeral by design", desc: "Download links can expire in 1/3/7 days or burn after the first download, leaving no lasting trace." },
    ],
  },
  howItWorks: {
    title: "Three ways across networks",
    sub: "Not on the same LAN? Pick whichever fits — based on whether the other person is online and willing to sign in.",
    ways: [
      { icon: "🔢", name: "Pairing code", how: "When both are online, one side taps “Create pairing code” for a 6-digit number; the other types it in to open a direct peer-to-peer link. No sign-in, fastest to start.", tag: "Files never touch the server" },
      { icon: "🔗", name: "Share link", how: "Sign in to generate a relayed link or QR code and send it over; the moment they open it you're connected in realtime, with better connectivity. Even relayed, traffic stays end-to-end encrypted.", tag: "End-to-end encrypted" },
      { icon: "📥", name: "Download link", how: "Your browser encrypts before upload; the server stores only ciphertext. The recipient needs no account and no live session — they download anytime, with an expiry or burn-after-reading.", tag: "Ciphertext only" },
    ],
  },
  compare: {
    title: "Which mode to choose",
    sub: "“Realtime direct” is for when both are online now; “Download link” is for picking up later.",
    colFeature: "Aspect",
    colRealtime: "⚡ Realtime direct",
    colStored: "📦 Download link",
    rows: [
      { label: "Sign-in needed", realtime: "No (sign in for better connectivity)", stored: "Sender signs in" },
      { label: "Recipient online?", realtime: "Yes — both online at once", stored: "No — download asynchronously" },
      { label: "Files via server?", realtime: "No — peer-to-peer (a share link can fall back to an encrypted relay)", stored: "Yes, but zero-knowledge ciphertext only" },
      { label: "Lifetime", realtime: "Send and gone, nothing stored", stored: "1 / 3 / 7 days, or burn after reading" },
      { label: "Best for", realtime: "Direct big-file transfer while both online", stored: "Recipient offline, or one link for many" },
    ],
  },
  useCases: {
    title: "Built for these moments",
    sub: "From remote collaboration to privacy-sensitive one-shot delivery.",
    items: [
      { icon: "🌍", title: "Send big files across the world", desc: "Fire a multi-gigabyte video, design file, or dataset straight to a colleague or family member abroad — streamed to disk, no memory bloat, no quality loss." },
      { icon: "⏳", title: "When they're not online", desc: "Generate an encrypted download link with an expiry and send it over; they grab it whenever they're free — and one link can serve several recipients." },
      { icon: "📱", title: "Phone ↔ computer", desc: "Move files between your own devices across systems and networks — scan or type a code to connect, no cloud drive or cable required." },
      { icon: "🔒", title: "Privacy-sensitive one-shot delivery", desc: "End-to-end encryption plus a SAS verification code against MITM, with burn-after-reading — ideal for contracts, IDs, or keys." },
    ],
  },
  faq: {
    title: "Frequently asked",
    sub: "What you might want to know about cross-network transfer, connectivity, and security.",
    items: [
      { q: "Do I need to install an app?", a: "No. Any modern browser can transfer straight from the web page — Chrome is recommended (streams large files to disk with an optional target folder, without using memory)." },
      { q: "What if it won't connect?", a: "A pairing code is direct-only (STUN hole-punching). If a restrictive network blocks it, a share link is more robust — it includes a TURN relay and falls back to an encrypted relay when hole-punching fails. Still stuck? A download link is the most reliable (asynchronous) option." },
      { q: "How big can files be?", a: "Realtime direct transfer streams data, so there's no hard size cap in practice; download links are bounded by a per-file size limit and a daily quota, which the page will tell you about." },
      { q: "Can the server see my files?", a: "No. Realtime transfers never touch the server; download links are encrypted in your browser and the server keeps only ciphertext it can't decrypt — the key lives solely with the link's sharer and recipient." },
      { q: "Do I have to create an account?", a: "The pairing-code flow needs no sign-in at all. Share links and download links require the sender to sign in, so a relayed link or stored ciphertext can be created." },
      { q: "Is it open source?", a: "Yes. The protocol design and all front-end and back-end code are public on GitHub — free to review, self-host, or contribute to." },
    ],
  },
  crossPitch: "On the same network, “LAN transfer” is simplest; when you're apart, use one of the three ways below to go direct across networks.",
  homeCross: {
    title: "Not on the same network?",
    desc: "Cross-network transfer supports pairing codes, share links, and encrypted download links — end-to-end encrypted, even across the world.",
    cta: "Go to cross-network transfer →",
  },
  legal: { privacy: "Privacy Policy", terms: "Terms of Service" },
};

const ja: Messages = {
  langLabel: "言語",
  tagline: "エンドツーエンド暗号化のP2Pファイル転送 · ファイルはサーバーを経由しません",
  connected: (n) => `接続済み · このデバイス ${n}`,
  ipLabel: "グローバル IP",
  connecting: "シグナリングサーバーに接続中…",
  unavailable: "利用不可",
  unsupported: "暗号化転送には HTTPS（または localhost）が必要です。https:// でこのページを開いてください。",
  guideTitle: "使い方",
  step1: "同じネットワーク上の別のデバイスやブラウザでこのページを開きます（同じグローバルIPは同一の「ルーム」になります）。",
  step2: "両方のデバイスが下の「近くのデバイス」一覧に表示されます。",
  step3: (m) => `相手のカードをクリックしてファイルを選ぶか、ファイルをカードにドラッグします（一度に最大 ${m} 個）。`,
  step4: "相手が「受信」をクリックし、両方の確認コードが一致したら転送が始まります。",
  hint: "Chrome を推奨します（大きなファイルをディスクに直接ストリーミングし、複数ファイルは保存先フォルダーを選べてメモリを消費しません）。同じルーター配下で相手が見えない場合は、ルーターの「AP 分離 / クライアント分離」をオフにしてください。",
  requestHead: (n, c, s) => `📥 ${n} さんが ${c} 個のファイルを送信しようとしています · 合計 ${s}`,
  codeLabel: "確認コード",
  codeCompare: "受信する前に送信側の画面と一致するか確認してください",
  accept: "受信",
  decline: "拒否",
  sendTo: (n) => `送信 → ${n}`,
  recvFrom: (n) => `受信 ← ${n}`,
  fileCounter: (i, n) => `ファイル ${i}/${n}`,
  close: "閉じる",
  cancel: "キャンセル",
  startOver: "← やり直す",
  peersTitle: "近くのデバイス",
  crossPeersTitle: "接続中の相手",
  pickSendTo: (n) => `クリックまたはドロップで ${n} に送信`,
  generating: "生成中…",
  emptyPeers: "他のデバイスはまだありません。同じネットワーク上の別のデバイスやブラウザウィンドウでこのページを開いてください。",
  dragSendOne: (name) => `${name} に送信するには離してください`,
  dragSendMany: "送信先のデバイスにドロップしてください",
  pickHint: (m) => `クリックしてファイルを選択 · またはここにドロップ（最大 ${m} 個）`,
  footer: "エンドツーエンド暗号化（X25519 + AES-256-GCM）· シグナリングサーバーは接続情報のみを中継し、ファイルの内容は見えません",
  busy: "すでに転送が進行中です。完了するまでお待ちください",
  tooMany: (m, n) => `一度に最大 ${m} 個まで。超過した ${n} 個は無視しました`,
  titleDefault: "Relayium — エンドツーエンド暗号化ファイル転送",
  status: {
    connecting: "暗号化接続を確立中…",
    waitingAccept: "相手の受信確認を待っています…",
    rejected: "相手に拒否されました ✗",
    sending: "送信中…",
    finishing: "完了処理中…",
    sendDone: (n) => `送信完了 ✓（${n} 個のファイル）`,
    sendFail: "送信に失敗しました ✗",
    receiving: "受信中…",
    recvDone: (n) => `受信完了 ✓（${n} 個のファイル）`,
    integrityFail: "整合性チェックに失敗しました ✗",
    recvFail: "受信に失敗しました ✗",
    noSave: "保存先が選択されなかったため、キャンセルしました",
    connectFail: "接続の確立に失敗しました ✗",
  },
  account: {
    signIn: "ログイン",
    signOut: "ログアウト",
    email: "メールアドレス",
    sendLink: "ログインリンクを送る",
    linkSent: "メールにログインリンクを送りました。ご確認ください。",
    continueGoogle: "Google で続ける",
    or: "または",
    signedInAs: (e) => `ログイン中：${e}`,
    password: "パスワード",
    createAccount: "登録",
    logInBtn: "ログイン",
    toRegister: "アカウントがない？新規登録",
    toLogin: "アカウントをお持ちの方はログイン",
    errTooShort: "パスワードは8文字以上にしてください。",
    errEmailTaken: "このメールは登録済みです。ログインしてください。",
    errLogin: "メールアドレスまたはパスワードが違います。",
    changePassword: "パスワードを変更",
    setPassword: "パスワードを設定",
    currentPassword: "現在のパスワード",
    newPassword: "新しいパスワード",
    confirmPassword: "新しいパスワード（確認）",
    pwChanged: "パスワードを更新しました。他の端末はログアウトされました。",
    errCurrentWrong: "現在のパスワードが正しくありません。",
    errMismatch: "新しいパスワードが一致しません。",
  },
  nav: { lanTab: "LAN 転送", crossTab: "ネットワーク間転送" },
  crossnet: {
    sendAcross: "共有リンクを生成",
    loginFirst: "ネットワーク間転送を始める前にサインインしてください",
    shareHint: "このリンクを相手に送ってください。相手が開いたら、下の6桁コードを確認して転送します",
    copy: "リンクをコピー",
    copied: "コピーしました",
    connecting: "ネットワーク間リンクで接続中…",
    linkDead: "リンクが無効か使用中です。送信者に新しいリンクを依頼してください",
    realtimeTitle: "リアルタイム直接転送",
    realtimeSub: "両者が今オンライン · P2P · ファイルはサーバーを経由しません",
    realtimeFoot: "ログイン不要 · ログインで接続性が向上",
  },
  methods: {
    pairing: { name: "🔢 ペアリングコード", sub: "一方が6桁のコードを発行し、もう一方が入力するだけで即座にP2P直結。最も手軽です。", badge: "ログイン不要" },
    share: { name: "🔗 共有リンク", sub: "リレー経由のリンクやQRコードを生成して送信。開いた瞬間にリアルタイム接続され、接続性も向上します。", badge: "要ログイン", signIn: "ログインすると共有リンクを生成できます" },
    stored: { name: "📦 ダウンロードリンク", sub: "ブラウザで暗号化してから一時保存。受信者はオンラインもアカウントも不要で、いつでもダウンロードできます。", badge: "相手オフライン可" },
  },
  pair: {
    sendCode: "ペアリングコードを生成",
    enterCode: "ペアリングコードを入力",
    enterHint: "送信者に 6 桁のコードを尋ねてください",
    joinBtn: "接続",
    yourCode: "あなたのペアリングコード — 相手に伝えてください",
  scanHint: "または相手にQRを読み取ってもらう / リンクを開いて参加",
    waiting: "相手の参加を待っています…",
    expiresIn: (s) => `${s} で失効`,
    expired: "ペアリングコードが失効しました。再生成してください",
    copy: "コピー",
    copied: "コピーしました",
    copyLink: "リンクをコピー",
    errExpired: "ペアリングコードが無効か期限切れです",
  },
  stored: {
    pick: "アップロードするファイルを選択",
    uploading: "暗号化してアップロード中…",
    burnLabel: "閲覧後に削除（最初のダウンロードで削除）",
    ttlLabel: "有効期限",
    ttl1d: "1 日",
    ttl3d: "3 日",
    ttl7d: "7 日",
    linkReady: "リンクを作成しました。相手に送ってダウンロードしてもらえます：",
    expiresOn: (w) => `このリンクは ${w} に失効します`,
    copy: "リンクをコピー",
    copied: "コピーしました",
    errTooLarge: "ファイルが単一ファイルの上限を超えています。",
    errQuota: "本日のアップロード上限を超えました。後でもう一度お試しください。",
    errUpload: "アップロードに失敗しました。もう一度お試しください。",
  },
  download: {
    loading: "リンクを読み込み中…",
    files: "ダウンロードするファイル",
    summary: (c, s) => `${c} 個のファイル · 合計 ${s}`,
    expiresIn: (l) => `残り ${l} で失効`,
    durUnits: { d: "日", h: "時間", m: "分" },
    zeroKnowledge: "🔒 ファイルは送信者のブラウザ内で暗号化され、当社のサーバーでも復号・閲覧できません。ダウンロード前に、信頼できる送信者からのリンクかご確認ください。",
    burnWarning: "⚠️ このファイルは一度だけダウンロードでき、完了後すぐに完全削除され、復元できません。安定した接続で一度に完了させてください。",
    sendPrompt: "ファイルを送り返しますか？",
    sendCta: "Relayium で安全に送る →",
    downloadBtn: "ダウンロードして復号",
    downloading: "ダウンロードして復号中…",
    done: "ダウンロード完了 ✓",
    notFound: "このリンクは無効、期限切れ、またはダウンロード済みで削除されています。",
    noKey: "リンクが不完全です：復号キー（#k=）がありません。",
    decryptFail: "復号に失敗しました：キーが違うかファイルが破損しています。",
    unsupported: "復号ダウンロードには HTTPS（または localhost）が必要です。",
  },
  features: {
    title: "Relayium が選ばれる理由",
    sub: "プライバシー優先・P2P直結・オープンソース——ファイル転送はこうあるべき。",
    items: [
      { title: "エンドツーエンド暗号化", desc: "X25519 + AES-256-GCM。鍵は2台の端末間だけでネゴシエートされ、サーバーは復号できません。" },
      { title: "ファイルはサーバーを経由しません", desc: "リアルタイムモードではデータはWebRTCで端末間を直接流れ、サーバーを経由しません。任意のダウンロードリンクモードでもゼロ知識の暗号文しか保存しません。" },
      { title: "中間者攻撃チェック", desc: "両方の画面に同じコード（SAS）が表示されます。一致を確認すれば盗聴を狙う中間者攻撃を排除できます。" },
      { title: "クロスプラットフォーム", desc: "Windows・macOS・Linux・Android・iOS——モダンブラウザさえあればインストール不要。" },
      { title: "オープンソースで監査可能", desc: "プロトコルとすべてのコードはGitHubで公開。誰でもレビュー・セルフホスト・貢献ができます。" },
      { title: "痕跡を残さない設計", desc: "ダウンロードリンクは1／3／7日で失効、または初回ダウンロード後に自動消去でき、痕跡を残しません。" },
    ],
  },
  howItWorks: {
    title: "ネットワークをまたぐ3つの方法",
    sub: "同じLANにいない？相手がオンラインか、ログインできるかに応じて、最適な方法を選べます。",
    ways: [
      { icon: "🔢", name: "ペアリングコード", how: "双方がオンラインなら、一方が「ペアリングコードを作成」で6桁の番号を発行し、もう一方が入力するだけで直接のP2P接続が開きます。ログイン不要で最も手軽です。", tag: "ファイルはサーバーを経由しません" },
      { icon: "🔗", name: "共有リンク", how: "ログインしてリレー経由のリンクまたはQRコードを生成し送信。相手が開いた瞬間にリアルタイム接続され、接続性も向上します。リレー経由でも通信はエンドツーエンド暗号化のままです。", tag: "エンドツーエンド暗号化" },
      { icon: "📥", name: "ダウンロードリンク", how: "アップロード前にブラウザ側で暗号化し、サーバーは暗号文しか保存しません。受信者はアカウントもリアルタイム接続も不要で、失効期限や閲覧後削除付きでいつでもダウンロードできます。", tag: "暗号文のみ" },
    ],
  },
  compare: {
    title: "どのモードを選ぶか",
    sub: "「リアルタイム直接転送」は双方が今オンラインの場合、「ダウンロードリンク」は後で受け取る場合に。",
    colFeature: "比較項目",
    colRealtime: "⚡ リアルタイム直接転送",
    colStored: "📦 ダウンロードリンク",
    rows: [
      { label: "ログインの要否", realtime: "不要（ログインで接続性が向上）", stored: "送信者はログインが必要" },
      { label: "相手はオンライン？", realtime: "必要——双方が同時にオンライン", stored: "不要——非同期でダウンロード" },
      { label: "ファイルはサーバー経由？", realtime: "いいえ · P2P直結（共有リンクはホールパンチング失敗時に暗号化リレーへ切替可）", stored: "はい、ただしゼロ知識の暗号文のみ" },
      { label: "有効期間", realtime: "送ったら消える、保存なし", stored: "1／3／7日、または閲覧後に削除" },
      { label: "適した用途", realtime: "双方オンライン時の大容量ファイル直接転送", stored: "受信者がオフライン、または1つのリンクを複数人へ" },
    ],
  },
  useCases: {
    title: "こんな場面のために",
    sub: "リモートコラボから、プライバシーに配慮した一度きりの受け渡しまで。",
    items: [
      { icon: "🌍", title: "海外へ大容量ファイルを送る", desc: "数ギガの動画・デザインファイル・データセットを、海外の同僚や家族へそのまま送信。ディスクへストリーミングするのでメモリを圧迫せず、画質の劣化もありません。" },
      { icon: "⏳", title: "相手がオフラインのとき", desc: "失効期限付きの暗号化ダウンロードリンクを生成して送れば、相手は都合のよいときに受け取れます。1つのリンクで複数の受信者にも対応できます。" },
      { icon: "📱", title: "スマホ ↔ パソコン", desc: "システムやネットワークをまたいで自分の端末間でファイルを移動。コードをスキャンまたは入力するだけで接続でき、クラウドドライブもケーブルも不要です。" },
      { icon: "🔒", title: "プライバシー重視の一度きりの受け渡し", desc: "エンドツーエンド暗号化に加え、中間者攻撃対策のSAS検証コードと閲覧後削除。契約書・身分証・鍵の受け渡しに最適です。" },
    ],
  },
  faq: {
    title: "よくある質問",
    sub: "ネットワークをまたぐ転送・接続性・セキュリティについて知っておきたいこと。",
    items: [
      { q: "アプリのインストールは必要？", a: "不要です。モダンブラウザならウェブページから直接転送できます。Chrome推奨（メモリを使わず、任意の保存先フォルダを指定して大容量ファイルをディスクへストリーミングできます）。" },
      { q: "接続できないときは？", a: "ペアリングコードはP2P直結のみ（STUNによるホールパンチング）。制限の厳しいネットワークでつながらない場合は共有リンクの方が確実です——TURNリレーを備え、ホールパンチング失敗時は暗号化リレーへ自動で切り替わります。それでも駄目ならダウンロードリンク（非同期で最も確実）を。" },
      { q: "ファイルはどれくらい大きくできる？", a: "リアルタイム直接転送はデータをストリーミングするため、実用上のサイズ上限はありません。ダウンロードリンクは1ファイルあたりのサイズ制限と1日の上限があり、ページ上で案内されます。" },
      { q: "サーバーは私のファイルを見られる？", a: "いいえ。リアルタイム転送はサーバーを一切経由しません。ダウンロードリンクはブラウザ内で暗号化され、サーバーは復号できない暗号文しか保持しません。鍵はリンクの共有者と受信者だけが持ちます。" },
      { q: "アカウント登録は必須？", a: "ペアリングコードのフローはログイン不要です。共有リンクとダウンロードリンクは、リレー経由のリンクや保存する暗号文を作成するため、送信者のログインが必要です。" },
      { q: "オープンソース？", a: "はい。プロトコル設計とフロントエンド・バックエンドのすべてのコードはGitHubで公開されており、自由にレビュー・セルフホスト・貢献できます。" },
    ],
  },
  crossPitch: "同じネットワーク内なら「LAN転送」が最も簡単です。離れている場合は、下の3つの方法のいずれかでネットワークをまたいで直接つなげます。",
  homeCross: {
    title: "同じネットワークにいない？",
    desc: "ネットワークをまたぐ転送は、ペアリングコード・共有リンク・暗号化ダウンロードリンクに対応。世界の反対側でもエンドツーエンド暗号化です。",
    cta: "ネットワーク間転送へ →",
  },
  legal: { privacy: "プライバシーポリシー", terms: "利用規約" },
};

const ko: Messages = {
  langLabel: "언어",
  tagline: "종단간 암호화 P2P 파일 전송 · 파일은 서버를 거치지 않습니다",
  connected: (n) => `연결됨 · 내 기기 ${n}`,
  ipLabel: "공인 IP",
  connecting: "시그널링 서버에 연결 중…",
  unavailable: "사용 불가",
  unsupported: "암호화 전송에는 HTTPS(또는 localhost)가 필요합니다. https:// 로 이 페이지를 열어 주세요.",
  guideTitle: "사용 방법",
  step1: "같은 네트워크의 다른 기기나 브라우저에서 이 페이지를 엽니다(같은 공인 IP는 하나의 ‘방’이 됩니다).",
  step2: "두 기기가 아래 ‘주변 기기’ 목록에 나타납니다.",
  step3: (m) => `상대 기기 카드를 클릭해 파일을 선택하거나 파일을 카드 위로 끌어다 놓습니다(한 번에 최대 ${m}개).`,
  step4: "상대가 ‘받기’를 클릭하고 양쪽 확인 코드가 일치하면 전송이 시작됩니다.",
  hint: "Chrome을 권장합니다(큰 파일을 디스크로 바로 스트리밍하고, 여러 파일은 대상 폴더를 선택할 수 있어 메모리를 쓰지 않습니다). 같은 공유기에서 서로 보이지 않으면 공유기의 ‘AP 격리 / 클라이언트 격리’를 끄세요.",
  requestHead: (n, c, s) => `📥 ${n} 님이 파일 ${c}개를 보내려 합니다 · 총 ${s}`,
  codeLabel: "확인 코드",
  codeCompare: "받기 전에 보내는 쪽 화면과 일치하는지 확인하세요",
  accept: "받기",
  decline: "거부",
  sendTo: (n) => `보내기 → ${n}`,
  recvFrom: (n) => `받기 ← ${n}`,
  fileCounter: (i, n) => `파일 ${i}/${n}`,
  close: "닫기",
  cancel: "취소",
  startOver: "← 다시 선택",
  peersTitle: "주변 기기",
  crossPeersTitle: "연결된 상대",
  pickSendTo: (n) => `클릭하거나 파일을 놓아 ${n}에게 전송`,
  generating: "생성 중…",
  emptyPeers: "아직 다른 기기가 없습니다. 같은 네트워크의 다른 기기나 브라우저 창에서 이 페이지를 여세요.",
  dragSendOne: (name) => `놓으면 ${name}에게 전송`,
  dragSendMany: "보낼 기기 위에 놓으세요",
  pickHint: (m) => `클릭하여 파일 선택 · 또는 여기에 드롭(최대 ${m}개)`,
  footer: "종단간 암호화(X25519 + AES-256-GCM) · 시그널링 서버는 연결 정보만 중계하며 파일 내용은 보지 못합니다",
  busy: "이미 전송이 진행 중입니다. 완료될 때까지 기다려 주세요",
  tooMany: (m, n) => `한 번에 최대 ${m}개까지. 초과한 ${n}개는 무시했습니다`,
  titleDefault: "Relayium — 종단간 암호화 파일 전송",
  status: {
    connecting: "암호화 연결을 설정하는 중…",
    waitingAccept: "상대의 수락을 기다리는 중…",
    rejected: "상대가 거부했습니다 ✗",
    sending: "보내는 중…",
    finishing: "마무리 중…",
    sendDone: (n) => `보내기 완료 ✓ (파일 ${n}개)`,
    sendFail: "보내기 실패 ✗",
    receiving: "받는 중…",
    recvDone: (n) => `받기 완료 ✓ (파일 ${n}개)`,
    integrityFail: "무결성 검사 실패 ✗",
    recvFail: "받기 실패 ✗",
    noSave: "저장 위치를 선택하지 않아 취소되었습니다",
    connectFail: "연결 실패 ✗",
  },
  account: {
    signIn: "로그인",
    signOut: "로그아웃",
    email: "이메일 주소",
    sendLink: "로그인 링크 보내기",
    linkSent: "이메일로 로그인 링크를 보냈습니다. 확인해 주세요.",
    continueGoogle: "Google로 계속",
    or: "또는",
    signedInAs: (e) => `로그인됨: ${e}`,
    password: "비밀번호",
    createAccount: "회원가입",
    logInBtn: "로그인",
    toRegister: "계정이 없으신가요? 가입하기",
    toLogin: "이미 계정이 있으신가요? 로그인",
    errTooShort: "비밀번호는 8자 이상이어야 합니다.",
    errEmailTaken: "이미 가입된 이메일입니다. 로그인해 주세요.",
    errLogin: "이메일 또는 비밀번호가 올바르지 않습니다.",
    changePassword: "비밀번호 변경",
    setPassword: "비밀번호 설정",
    currentPassword: "현재 비밀번호",
    newPassword: "새 비밀번호",
    confirmPassword: "새 비밀번호 확인",
    pwChanged: "비밀번호가 변경되었습니다. 다른 기기는 로그아웃되었습니다.",
    errCurrentWrong: "현재 비밀번호가 올바르지 않습니다.",
    errMismatch: "새 비밀번호가 일치하지 않습니다.",
  },
  nav: { lanTab: "LAN 전송", crossTab: "네트워크 간 전송" },
  crossnet: {
    sendAcross: "공유 링크 생성",
    loginFirst: "네트워크 간 전송을 시작하려면 먼저 로그인하세요",
    shareHint: "이 링크를 상대에게 보내세요. 상대가 열면 아래 6자리 코드를 확인하여 전송합니다",
    copy: "링크 복사",
    copied: "복사됨",
    connecting: "네트워크 간 링크로 연결 중…",
    linkDead: "링크가 유효하지 않거나 사용 중입니다. 보낸 사람에게 새 링크를 요청하세요",
    realtimeTitle: "실시간 직접 전송",
    realtimeSub: "양쪽 모두 온라인 · P2P · 파일은 서버를 거치지 않습니다",
    realtimeFoot: "로그인 불필요 · 로그인 시 연결성 향상",
  },
  methods: {
    pairing: { name: "🔢 페어링 코드", sub: "한쪽이 6자리 코드를 만들고 다른 쪽이 입력하면 즉시 P2P로 직접 연결됩니다. 가장 빠릅니다.", badge: "로그인 불필요" },
    share: { name: "🔗 공유 링크", sub: "중계 링크나 QR 코드를 생성해 보내면, 상대가 여는 순간 실시간으로 연결되고 연결 안정성도 좋습니다.", badge: "로그인 필요", signIn: "로그인하면 공유 링크를 만들 수 있습니다" },
    stored: { name: "📦 다운로드 링크", sub: "브라우저에서 암호화한 뒤 임시 보관하며, 받는 사람은 접속도 계정도 필요 없이 언제든 다운로드합니다.", badge: "상대 오프라인 OK" },
  },
  pair: {
    sendCode: "페어링 코드 생성",
    enterCode: "페어링 코드 입력",
    enterHint: "보내는 사람에게 6자리 코드를 요청하세요",
    joinBtn: "연결",
    yourCode: "내 페어링 코드 — 상대에게 알려주세요",
  scanHint: "또는 상대가 QR을 스캔하거나 링크를 열어 참여",
    waiting: "상대 기기의 참여를 기다리는 중…",
    expiresIn: (s) => `${s} 후 만료`,
    expired: "페어링 코드가 만료되었습니다. 다시 생성하세요",
    copy: "복사",
    copied: "복사됨",
    copyLink: "링크 복사",
    errExpired: "페어링 코드가 잘못되었거나 만료되었습니다",
  },
  stored: {
    pick: "업로드할 파일 선택",
    uploading: "암호화 후 업로드 중…",
    burnLabel: "열람 후 삭제 (첫 다운로드 시 삭제)",
    ttlLabel: "유효 기간",
    ttl1d: "1일",
    ttl3d: "3일",
    ttl7d: "7일",
    linkReady: "링크가 생성되었습니다. 상대에게 보내 다운로드하세요:",
    expiresOn: (w) => `이 링크는 ${w}에 만료됩니다`,
    copy: "링크 복사",
    copied: "복사됨",
    errTooLarge: "파일이 단일 파일 크기 한도를 초과했습니다.",
    errQuota: "오늘 업로드 한도를 초과했습니다. 나중에 다시 시도하세요.",
    errUpload: "업로드에 실패했습니다. 다시 시도하세요.",
  },
  download: {
    loading: "링크를 읽는 중…",
    files: "다운로드할 파일",
    summary: (c, s) => `파일 ${c}개 · 합계 ${s}`,
    expiresIn: (l) => `${l} 후 만료`,
    durUnits: { d: "일", h: "시간", m: "분" },
    zeroKnowledge: "🔒 파일은 보내는 사람의 브라우저에서 암호화되어 저희 서버도 복호화하거나 열람할 수 없습니다. 다운로드 전에 신뢰할 수 있는 사람이 보낸 링크인지 확인하세요.",
    burnWarning: "⚠️ 이 파일은 한 번만 다운로드할 수 있으며, 완료 직후 영구 삭제되어 복구할 수 없습니다. 안정적인 연결에서 한 번에 완료하세요.",
    sendPrompt: "파일을 되보내야 하나요?",
    sendCta: "Relayium으로 안전하게 보내기 →",
    downloadBtn: "다운로드 및 복호화",
    downloading: "다운로드 및 복호화 중…",
    done: "다운로드 완료 ✓",
    notFound: "유효하지 않거나 만료되었거나 이미 다운로드되어 삭제된 링크입니다.",
    noKey: "불완전한 링크: 복호화 키(#k=)가 없습니다.",
    decryptFail: "복호화 실패: 키가 틀리거나 파일이 손상되었습니다.",
    unsupported: "복호화 다운로드에는 HTTPS(또는 localhost)가 필요합니다.",
  },
  features: {
    title: "왜 Relayium인가",
    sub: "프라이버시 우선, P2P 직접 연결, 오픈소스 — 파일 전송은 이래야 합니다.",
    items: [
      { title: "종단간 암호화", desc: "X25519 + AES-256-GCM. 키는 두 기기 사이에서만 협상되며 서버는 복호화할 수 없습니다." },
      { title: "파일은 서버를 거치지 않습니다", desc: "실시간 모드에서는 데이터가 WebRTC로 기기 간 직접 전송되어 서버를 거치지 않으며, 선택적 다운로드 링크 모드는 제로 지식 암호문만 저장합니다." },
      { title: "중간자 공격 확인", desc: "양쪽 화면에 동일한 코드(SAS)가 표시됩니다. 서로 대조해 도청하는 중간자(MITM)를 차단하세요." },
      { title: "크로스 플랫폼", desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저만 있으면 되고, 설치할 것이 없습니다." },
      { title: "오픈소스이자 감사 가능", desc: "프로토콜과 모든 코드가 GitHub에 공개되어 있어 누구나 검토하고, 자체 호스팅하거나, 기여할 수 있습니다." },
      { title: "본질적으로 일회성", desc: "다운로드 링크는 1/3/7일 후 만료되거나 최초 다운로드 후 소멸하도록 설정해, 흔적을 남기지 않습니다." },
    ],
  },
  howItWorks: {
    title: "네트워크 간 전송의 세 가지 방법",
    sub: "같은 LAN이 아닌가요? 상대방이 온라인인지, 로그인할 의향이 있는지에 따라 알맞은 방법을 고르세요.",
    ways: [
      { icon: "🔢", name: "페어링 코드", how: "둘 다 온라인일 때 한쪽이 '페어링 코드 만들기'를 누르면 6자리 숫자가 나옵니다. 상대가 이를 입력하면 기기 간 직접 연결이 열립니다. 로그인 없이 가장 빠르게 시작합니다.", tag: "파일은 서버를 거치지 않습니다" },
      { icon: "🔗", name: "공유 링크", how: "로그인하면 중계 링크나 QR 코드를 생성해 보낼 수 있습니다. 상대가 여는 순간 실시간으로 연결되며 연결 안정성이 더 좋습니다. 중계되더라도 트래픽은 종단간 암호화됩니다.", tag: "종단간 암호화" },
      { icon: "📥", name: "다운로드 링크", how: "브라우저가 업로드 전에 암호화하므로 서버는 암호문만 저장합니다. 받는 사람은 계정도, 실시간 연결도 필요 없이 언제든 다운로드하며, 만료 또는 열람 후 삭제를 적용할 수 있습니다.", tag: "암호문만 저장" },
    ],
  },
  compare: {
    title: "어떤 모드를 선택할까",
    sub: "'실시간 직접 전송'은 지금 둘 다 온라인일 때, '다운로드 링크'는 나중에 받을 때 적합합니다.",
    colFeature: "비교 항목",
    colRealtime: "⚡ 실시간 직접 전송",
    colStored: "📦 다운로드 링크",
    rows: [
      { label: "로그인 필요", realtime: "불필요 (연결 안정성을 위해 로그인 가능)", stored: "보내는 사람이 로그인" },
      { label: "상대방 온라인 여부", realtime: "필요 — 둘 다 동시에 온라인", stored: "불필요 — 비동기로 다운로드" },
      { label: "파일이 서버를 거치는지", realtime: "아니요 · P2P 직접 연결 (공유 링크는 홀 펀칭 실패 시 암호화 중계로 대체 가능)", stored: "예, 단 제로 지식 암호문만" },
      { label: "유효 기간", realtime: "보내면 끝, 저장되지 않음", stored: "1 / 3 / 7일, 또는 열람 후 삭제" },
      { label: "적합한 상황", realtime: "둘 다 온라인일 때 대용량 파일 직접 전송", stored: "받는 사람이 오프라인이거나, 한 링크로 여러 명에게" },
    ],
  },
  useCases: {
    title: "이런 순간을 위해",
    sub: "원격 협업부터 프라이버시가 중요한 일회성 전달까지.",
    items: [
      { icon: "🌍", title: "멀리 떨어진 곳으로 대용량 파일 보내기", desc: "수 기가바이트의 영상, 디자인 파일, 데이터셋을 해외의 동료나 가족에게 바로 전송하세요. 디스크로 스트리밍되어 메모리 부담도, 품질 손실도 없습니다." },
      { icon: "⏳", title: "상대방이 온라인이 아닐 때", desc: "만료 기간이 있는 암호화 다운로드 링크를 만들어 보내면, 상대는 여유가 있을 때 받아 갑니다. 한 링크로 여러 명에게 전달할 수도 있습니다." },
      { icon: "📱", title: "휴대폰 ↔ 컴퓨터", desc: "시스템과 네트워크가 달라도 내 기기 간에 파일을 옮기세요. 코드를 스캔하거나 입력해 연결하며, 클라우드 드라이브나 케이블이 필요 없습니다." },
      { icon: "🔒", title: "프라이버시가 중요한 일회성 전달", desc: "종단간 암호화에 더해 MITM을 막는 SAS 검증 코드와 열람 후 삭제까지 — 계약서, 신분증, 키 전달에 적합합니다." },
    ],
  },
  faq: {
    title: "자주 묻는 질문",
    sub: "네트워크 간 전송, 연결, 보안에 관해 궁금할 만한 점들.",
    items: [
      { q: "앱을 설치해야 하나요?", a: "아니요. 최신 브라우저라면 웹 페이지에서 바로 전송할 수 있습니다. Chrome을 권장합니다(대용량 파일을 메모리 없이 디스크로 스트리밍하며 대상 폴더를 지정할 수 있습니다)." },
      { q: "연결이 안 되면 어떻게 하나요?", a: "페어링 코드는 순수 P2P 직접 연결입니다(STUN 홀 펀칭). 제한이 심한 네트워크에서 안 되면 공유 링크가 더 안정적입니다——TURN 중계가 있어 홀 펀칭 실패 시 암호화 중계로 자동 전환됩니다. 그래도 안 되면 다운로드 링크(비동기, 가장 확실)를 쓰세요." },
      { q: "파일은 얼마나 커도 되나요?", a: "실시간 직접 전송은 데이터를 스트리밍하므로 실질적인 크기 상한이 없습니다. 다운로드 링크는 파일당 크기 제한과 일일 할당량이 있으며, 페이지에서 안내합니다." },
      { q: "서버가 내 파일을 볼 수 있나요?", a: "아니요. 실시간 전송은 서버를 거치지 않습니다. 다운로드 링크는 브라우저에서 암호화되어 서버는 복호화할 수 없는 암호문만 보관하며, 키는 링크를 공유한 사람과 받는 사람에게만 있습니다." },
      { q: "반드시 계정을 만들어야 하나요?", a: "페어링 코드 방식은 로그인이 전혀 필요 없습니다. 공유 링크와 다운로드 링크는 중계 링크나 저장된 암호문을 만들기 위해 보내는 사람의 로그인이 필요합니다." },
      { q: "오픈소스인가요?", a: "네. 프로토콜 설계와 프런트엔드, 백엔드 코드 전체가 GitHub에 공개되어 있어 자유롭게 검토하고, 자체 호스팅하거나, 기여할 수 있습니다." },
    ],
  },
  crossPitch: "같은 네트워크에서는 'LAN 전송'이 가장 간단합니다. 서로 떨어져 있을 때는 아래 세 가지 방법으로 네트워크를 넘어 직접 전송하세요.",
  homeCross: {
    title: "같은 네트워크가 아닌가요?",
    desc: "네트워크 간 전송은 페어링 코드, 공유 링크, 암호화 다운로드 링크를 지원합니다 — 지구 반대편이라도 종단간 암호화로.",
    cta: "네트워크 간 전송으로 이동 →",
  },
  legal: { privacy: "개인정보 처리방침", terms: "이용약관" },
};

const de: Messages = {
  langLabel: "Sprache",
  tagline: "Ende-zu-Ende-verschlüsselte Peer-to-Peer-Dateiübertragung · Dateien erreichen nie den Server",
  connected: (n) => `Verbunden · dieses Gerät ${n}`,
  ipLabel: "öffentliche IP",
  connecting: "Verbindung zum Signalisierungsserver…",
  unavailable: "Nicht verfügbar",
  unsupported: "Verschlüsselte Übertragung erfordert HTTPS (oder localhost). Bitte öffnen Sie diese Seite über https://.",
  guideTitle: "So funktioniert’s",
  step1: "Öffnen Sie diese Seite auf einem anderen Gerät oder Browser im selben Netzwerk (Geräte mit derselben öffentlichen IP bilden einen „Raum“).",
  step2: "Beide Geräte erscheinen dann in der Liste „Geräte in der Nähe“ unten.",
  step3: (m) => `Klicken Sie auf eine Gerätekarte, um Dateien auszuwählen, oder ziehen Sie Dateien darauf (bis zu ${m} auf einmal).`,
  step4: "Der Empfänger klickt auf „Annehmen“; sobald beide Prüfcodes übereinstimmen, beginnt die Übertragung.",
  hint: "Chrome wird empfohlen (streamt große Dateien direkt auf die Festplatte und lässt Sie bei mehreren Dateien einen Zielordner wählen, ohne Speicher zu belegen). Wenn sich Geräte am selben Router nicht sehen, deaktivieren Sie die „AP-Isolierung / Client-Isolierung“ des Routers.",
  requestHead: (n, c, s) => `📥 ${n} möchte ${c} Datei(en) senden · ${s} gesamt`,
  codeLabel: "Prüfcode",
  codeCompare: "vergleichen Sie ihn vor dem Annehmen mit dem Bildschirm des Absenders",
  accept: "Annehmen",
  decline: "Ablehnen",
  sendTo: (n) => `Senden → ${n}`,
  recvFrom: (n) => `Empfangen ← ${n}`,
  fileCounter: (i, n) => `Datei ${i}/${n}`,
  close: "Schließen",
  cancel: "Abbrechen",
  startOver: "← Von vorn",
  peersTitle: "Geräte in der Nähe",
  crossPeersTitle: "Verbundener Peer",
  pickSendTo: (n) => `Klicken oder Dateien ablegen, um an ${n} zu senden`,
  generating: "Wird erstellt…",
  emptyPeers: "Noch keine anderen Geräte. Öffnen Sie diese Seite auf einem anderen Gerät oder Browserfenster im selben Netzwerk.",
  dragSendOne: (name) => `Loslassen, um an ${name} zu senden`,
  dragSendMany: "Zum Senden auf ein Gerät ziehen",
  pickHint: (m) => `Zum Auswählen klicken · oder hierher ziehen (bis zu ${m})`,
  footer: "Ende-zu-Ende-verschlüsselt (X25519 + AES-256-GCM) · der Signalisierungsserver leitet nur Verbindungsdaten weiter und sieht nie Dateiinhalte",
  busy: "Eine Übertragung läuft bereits – bitte warten Sie, bis sie abgeschlossen ist",
  tooMany: (m, n) => `Maximal ${m} Dateien auf einmal; ${n} überzählige ignoriert`,
  titleDefault: "Relayium — Ende-zu-Ende-verschlüsselte Dateiübertragung",
  status: {
    connecting: "Verschlüsselte Verbindung wird hergestellt…",
    waitingAccept: "Warten auf die Annahme des Empfängers…",
    rejected: "Vom Empfänger abgelehnt ✗",
    sending: "Senden…",
    finishing: "Wird abgeschlossen…",
    sendDone: (n) => `Gesendet ✓ (${n} Datei${n === 1 ? "" : "en"})`,
    sendFail: "Senden fehlgeschlagen ✗",
    receiving: "Empfangen…",
    recvDone: (n) => `Empfangen ✓ (${n} Datei${n === 1 ? "" : "en"})`,
    integrityFail: "Integritätsprüfung fehlgeschlagen ✗",
    recvFail: "Empfang fehlgeschlagen ✗",
    noSave: "Kein Speicherort gewählt – abgebrochen",
    connectFail: "Verbindung fehlgeschlagen ✗",
  },
  account: {
    signIn: "Anmelden",
    signOut: "Abmelden",
    email: "E-Mail-Adresse",
    sendLink: "Anmelde-Link senden",
    linkSent: "Prüfen Sie Ihr E-Mail-Postfach nach dem Anmelde-Link.",
    continueGoogle: "Mit Google fortfahren",
    or: "oder",
    signedInAs: (e) => `Angemeldet als ${e}`,
    password: "Passwort",
    createAccount: "Registrieren",
    logInBtn: "Anmelden",
    toRegister: "Kein Konto? Registrieren",
    toLogin: "Schon ein Konto? Anmelden",
    errTooShort: "Das Passwort muss mindestens 8 Zeichen haben.",
    errEmailTaken: "Diese E-Mail ist bereits registriert — bitte anmelden.",
    errLogin: "Falsche E-Mail oder falsches Passwort.",
    changePassword: "Passwort ändern",
    setPassword: "Passwort festlegen",
    currentPassword: "Aktuelles Passwort",
    newPassword: "Neues Passwort",
    confirmPassword: "Neues Passwort bestätigen",
    pwChanged: "Passwort aktualisiert. Andere Geräte wurden abgemeldet.",
    errCurrentWrong: "Aktuelles Passwort ist falsch.",
    errMismatch: "Die neuen Passwörter stimmen nicht überein.",
  },
  nav: { lanTab: "LAN-Übertragung", crossTab: "Netzübergreifend" },
  crossnet: {
    sendAcross: "Freigabelink erzeugen",
    loginFirst: "Bitte melde dich an, bevor du eine netzwerkübergreifende Übertragung startest",
    shareHint: "Sende diesen Link an die andere Person; sobald sie ihn öffnet, bestätige den 6-stelligen Code unten zur Übertragung",
    copy: "Link kopieren",
    copied: "Kopiert",
    connecting: "Verbindung über den netzwerkübergreifenden Link…",
    linkDead: "Dieser Link ist ungültig oder bereits in Gebrauch — bitte den Absender um einen neuen",
    realtimeTitle: "Echtzeit-Direktübertragung",
    realtimeSub: "Beide jetzt online · Peer-to-Peer · Dateien berühren nie den Server",
    realtimeFoot: "Keine Anmeldung nötig · angemeldet bessere Verbindung",
  },
  methods: {
    pairing: { name: "🔢 Kopplungscode", sub: "Eine Seite erzeugt einen 6-stelligen Code, die andere gibt ihn ein — sofort direkt Peer-to-Peer verbunden. Am schnellsten.", badge: "Ohne Anmeldung" },
    share: { name: "🔗 Freigabelink", sub: "Erzeuge einen weitergeleiteten Link oder QR-Code und verschick ihn; beim Öffnen seid ihr in Echtzeit verbunden, mit besserer Konnektivität.", badge: "Anmeldung nötig", signIn: "Melde dich an, um einen Freigabelink zu erzeugen" },
    stored: { name: "📦 Download-Link", sub: "Dein Browser verschlüsselt und speichert zwischen; die empfangende Person lädt jederzeit herunter — ohne Sitzung, ohne Konto.", badge: "Auch offline" },
  },
  pair: {
    sendCode: "Kopplungscode erstellen",
    enterCode: "Kopplungscode eingeben",
    enterHint: "Frag den Absender nach seinem 6-stelligen Code",
    joinBtn: "Verbinden",
    yourCode: "Dein Kopplungscode — sag ihn der anderen Person",
  scanHint: "oder die andere Person scannt den QR / öffnet den Link",
    waiting: "Warte darauf, dass das andere Gerät beitritt…",
    expiresIn: (s) => `läuft in ${s} ab`,
    expired: "Kopplungscode abgelaufen — bitte neu erzeugen",
    copy: "Kopieren",
    copied: "Kopiert",
    copyLink: "Link kopieren",
    errExpired: "Kopplungscode ist ungültig oder abgelaufen",
  },
  stored: {
    pick: "Dateien zum Hochladen wählen",
    uploading: "Verschlüsseln und hochladen…",
    burnLabel: "Nach dem Lesen löschen (beim ersten Download)",
    ttlLabel: "Gültig für",
    ttl1d: "1 Tag",
    ttl3d: "3 Tage",
    ttl7d: "7 Tage",
    linkReady: "Link bereit — senden Sie ihn dem Empfänger zum Herunterladen:",
    expiresOn: (w) => `Dieser Link läuft am ${w} ab`,
    copy: "Link kopieren",
    copied: "Kopiert",
    errTooLarge: "Die Datei überschreitet das Einzeldatei-Limit.",
    errQuota: "Das heutige Upload-Kontingent ist erschöpft — bitte später erneut versuchen.",
    errUpload: "Upload fehlgeschlagen, bitte erneut versuchen.",
  },
  download: {
    loading: "Link wird gelesen…",
    files: "Herunterzuladende Dateien",
    summary: (c, s) => `${c} Datei${c === 1 ? "" : "en"} · ${s} gesamt`,
    expiresIn: (l) => `Läuft in ${l} ab`,
    durUnits: { d: "d", h: "h", m: "min" },
    zeroKnowledge: "🔒 Dateien werden im Browser des Absenders verschlüsselt — nicht einmal unser Server kann sie entschlüsseln oder einsehen. Vergewissern Sie sich vor dem Download, dass der Link von einer vertrauenswürdigen Person stammt.",
    burnWarning: "⚠️ Diese Datei kann nur einmal heruntergeladen werden — danach wird sie unwiderruflich gelöscht. Sorgen Sie für eine stabile Verbindung, um sie in einem Zug abzuschließen.",
    sendPrompt: "Dateien zurücksenden?",
    sendCta: "Sicher mit Relayium senden →",
    downloadBtn: "Herunterladen & entschlüsseln",
    downloading: "Herunterladen und entschlüsseln…",
    done: "Download abgeschlossen ✓",
    notFound: "Dieser Link ist ungültig, abgelaufen oder bereits heruntergeladen und gelöscht.",
    noKey: "Unvollständiger Link: Der Entschlüsselungsschlüssel (#k=) fehlt.",
    decryptFail: "Entschlüsselung fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.",
    unsupported: "Für den entschlüsselten Download ist HTTPS (oder localhost) erforderlich.",
  },
  features: {
    title: "Warum Relayium",
    sub: "Datenschutz zuerst, Peer-to-Peer, Open Source — Dateiübertragung, wie sie sein sollte.",
    items: [
      { title: "Ende-zu-Ende-verschlüsselt", desc: "X25519 + AES-256-GCM; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, der Server kann nicht entschlüsseln." },
      { title: "Dateien erreichen nie den Server", desc: "Im Echtzeitmodus fließen die Bytes per WebRTC direkt von Gerät zu Gerät und erreichen nie den Server; der optionale Download-Link-Modus speichert nur Zero-Knowledge-Chiffretext." },
      { title: "Prüfung auf Man-in-the-Middle", desc: "Beide Bildschirme zeigen denselben Code (SAS); vergleiche ihn, um einen mithörenden MITM auszuschließen." },
      { title: "Plattformübergreifend", desc: "Windows, macOS, Linux, Android, iOS — jeder moderne Browser, nichts zu installieren." },
      { title: "Open Source & prüfbar", desc: "Das Protokoll und der gesamte Code liegen offen auf GitHub — jeder kann sie prüfen, selbst hosten oder mitwirken." },
      { title: "Von Grund auf flüchtig", desc: "Download-Links können nach 1/3/7 Tagen ablaufen oder nach dem ersten Download verbrennen — ohne bleibende Spur." },
    ],
  },
  howItWorks: {
    title: "Drei Wege über Netzgrenzen hinweg",
    sub: "Nicht im selben LAN? Wähle, was passt — je nachdem, ob die andere Person online ist und sich anmelden möchte.",
    ways: [
      { icon: "🔢", name: "Kopplungscode", how: "Wenn beide online sind, tippt eine Seite auf „Kopplungscode erstellen“ für eine 6-stellige Zahl; die andere gibt sie ein und öffnet eine direkte Peer-to-Peer-Verbindung. Ohne Anmeldung, am schnellsten startklar.", tag: "Dateien erreichen nie den Server" },
      { icon: "🔗", name: "Freigabelink", how: "Melde dich an, um einen weitergeleiteten Link oder QR-Code zu erzeugen und zu verschicken; sobald ihn die andere Person öffnet, seid ihr in Echtzeit verbunden — mit besserer Konnektivität. Auch weitergeleitet bleibt der Datenverkehr Ende-zu-Ende-verschlüsselt.", tag: "Ende-zu-Ende-verschlüsselt" },
      { icon: "📥", name: "Download-Link", how: "Dein Browser verschlüsselt vor dem Upload; der Server speichert nur Chiffretext. Die empfangende Person braucht kein Konto und keine laufende Sitzung — sie lädt jederzeit herunter, mit Ablauf oder Löschen nach dem Lesen.", tag: "Nur Chiffretext" },
    ],
  },
  compare: {
    title: "Welcher Modus passt",
    sub: "„Echtzeit-Direkt“ ist für jetzt, wenn beide online sind; „Download-Link“ ist zum späteren Abholen.",
    colFeature: "Aspekt",
    colRealtime: "⚡ Echtzeit-Direkt",
    colStored: "📦 Download-Link",
    rows: [
      { label: "Anmeldung nötig", realtime: "Nein (Anmeldung für bessere Konnektivität)", stored: "Sender meldet sich an" },
      { label: "Empfänger online?", realtime: "Ja — beide gleichzeitig online", stored: "Nein — asynchron herunterladen" },
      { label: "Dateien über Server?", realtime: "Nein · Peer-to-Peer (Freigabelink kann bei Fehlschlag auf ein verschlüsseltes Relay ausweichen)", stored: "Ja, aber nur Zero-Knowledge-Chiffretext" },
      { label: "Lebensdauer", realtime: "Senden und weg, nichts gespeichert", stored: "1 / 3 / 7 Tage oder Löschen nach dem Lesen" },
      { label: "Am besten für", realtime: "Direkte Übertragung großer Dateien, solange beide online sind", stored: "Empfänger offline, oder ein Link für viele" },
    ],
  },
  useCases: {
    title: "Für genau diese Momente gemacht",
    sub: "Von Remote-Zusammenarbeit bis zur datenschutzsensiblen Einmal-Zustellung.",
    items: [
      { icon: "🌍", title: "Große Dateien um die Welt senden", desc: "Schick ein mehrere Gigabyte großes Video, eine Design-Datei oder einen Datensatz direkt an Kollegen oder Familie im Ausland — direkt auf die Festplatte gestreamt, ohne Speicher-Overhead, ohne Qualitätsverlust." },
      { icon: "⏳", title: "Wenn die andere Person nicht online ist", desc: "Erzeuge einen verschlüsselten Download-Link mit Ablaufdatum und verschick ihn; sie holt ihn ab, wann immer sie Zeit hat — und ein Link kann mehrere Empfänger bedienen." },
      { icon: "📱", title: "Handy ↔ Computer", desc: "Verschiebe Dateien zwischen deinen eigenen Geräten über Systeme und Netzwerke hinweg — scanne oder tippe einen Code zum Verbinden, ohne Cloud-Speicher oder Kabel." },
      { icon: "🔒", title: "Datenschutzsensible Einmal-Zustellung", desc: "Ende-zu-Ende-Verschlüsselung plus ein SAS-Prüfcode gegen MITM, mit Löschen nach dem Lesen — ideal für Verträge, Ausweise oder Schlüssel." },
    ],
  },
  faq: {
    title: "Häufige Fragen",
    sub: "Was du über netzübergreifende Übertragung, Konnektivität und Sicherheit wissen möchtest.",
    items: [
      { q: "Muss ich eine App installieren?", a: "Nein. Jeder moderne Browser überträgt direkt von der Webseite aus — Chrome wird empfohlen (streamt große Dateien speicherschonend auf die Festplatte, optional in einen Zielordner)." },
      { q: "Was, wenn keine Verbindung zustande kommt?", a: "Ein Kopplungscode ist rein direkt (STUN-Hole-Punching). Blockiert ein restriktives Netzwerk das, ist ein Freigabelink robuster — er enthält ein TURN-Relay und weicht bei fehlgeschlagenem Hole-Punching auf ein verschlüsseltes Relay aus. Immer noch nichts? Ein Download-Link ist die zuverlässigste (asynchrone) Option." },
      { q: "Wie groß dürfen Dateien sein?", a: "Die Echtzeit-Direktübertragung streamt die Daten, in der Praxis gibt es also keine harte Größengrenze; Download-Links sind durch ein Größenlimit pro Datei und ein Tageskontingent begrenzt, über die dich die Seite informiert." },
      { q: "Kann der Server meine Dateien sehen?", a: "Nein. Echtzeitübertragungen erreichen nie den Server; Download-Links werden in deinem Browser verschlüsselt, und der Server behält nur Chiffretext, den er nicht entschlüsseln kann — der Schlüssel liegt allein bei der teilenden und der empfangenden Person." },
      { q: "Muss ich ein Konto anlegen?", a: "Der Kopplungscode-Ablauf braucht überhaupt keine Anmeldung. Freigabelinks und Download-Links erfordern, dass sich der Sender anmeldet, damit ein weitergeleiteter Link oder gespeicherter Chiffretext erstellt werden kann." },
      { q: "Ist es Open Source?", a: "Ja. Das Protokolldesign sowie der gesamte Frontend- und Backend-Code liegen offen auf GitHub — frei zum Prüfen, Selbst-Hosten oder Mitwirken." },
    ],
  },
  crossPitch: "Im selben Netzwerk ist „LAN-Übertragung“ am einfachsten; seid ihr getrennt, nutze einen der drei Wege unten, um netzübergreifend direkt zu verbinden.",
  homeCross: {
    title: "Nicht im selben Netzwerk?",
    desc: "Netzübergreifende Übertragung unterstützt Kopplungscodes, Freigabelinks und verschlüsselte Download-Links — Ende-zu-Ende-verschlüsselt, selbst um die halbe Welt.",
    cta: "Zur netzübergreifenden Übertragung →",
  },
  legal: { privacy: "Datenschutzerklärung", terms: "Nutzungsbedingungen" },
};

const fr: Messages = {
  langLabel: "Langue",
  tagline: "Transfert de fichiers pair-à-pair chiffré de bout en bout · les fichiers ne passent jamais par le serveur",
  connected: (n) => `Connecté · cet appareil ${n}`,
  ipLabel: "IP publique",
  connecting: "Connexion au serveur de signalisation…",
  unavailable: "Indisponible",
  unsupported: "Le transfert chiffré nécessite HTTPS (ou localhost). Veuillez ouvrir cette page via https://.",
  guideTitle: "Comment ça marche",
  step1: "Ouvrez cette page sur un autre appareil ou navigateur du même réseau (les appareils partageant une IP publique forment une même « salle »).",
  step2: "Les deux appareils apparaissent alors dans la liste « Appareils à proximité » ci-dessous.",
  step3: (m) => `Cliquez sur la carte d’un appareil pour choisir des fichiers, ou faites-les glisser dessus (jusqu’à ${m} à la fois).`,
  step4: "Le destinataire clique sur « Accepter » ; une fois les deux codes de vérification identiques, le transfert démarre.",
  hint: "Chrome est recommandé (diffuse les gros fichiers directement sur le disque et permet de choisir un dossier de destination pour plusieurs fichiers, sans utiliser la mémoire). Si des appareils sur le même routeur ne se voient pas, désactivez « l’isolation AP / isolation des clients » du routeur.",
  requestHead: (n, c, s) => `📥 ${n} veut envoyer ${c} fichier(s) · ${s} au total`,
  codeLabel: "Code de vérification",
  codeCompare: "comparez-le avec l’écran de l’expéditeur avant d’accepter",
  accept: "Accepter",
  decline: "Refuser",
  sendTo: (n) => `Envoi → ${n}`,
  recvFrom: (n) => `Réception ← ${n}`,
  fileCounter: (i, n) => `Fichier ${i}/${n}`,
  close: "Fermer",
  cancel: "Annuler",
  startOver: "← Recommencer",
  peersTitle: "Appareils à proximité",
  crossPeersTitle: "Correspondant connecté",
  pickSendTo: (n) => `Cliquez ou déposez des fichiers pour envoyer à ${n}`,
  generating: "Création…",
  emptyPeers: "Aucun autre appareil pour l’instant. Ouvrez cette page sur un autre appareil ou une autre fenêtre du même réseau.",
  dragSendOne: (name) => `Relâchez pour envoyer à ${name}`,
  dragSendMany: "Déposez sur un appareil pour envoyer",
  pickHint: (m) => `Cliquez pour choisir · ou déposez ici (jusqu’à ${m})`,
  footer: "Chiffré de bout en bout (X25519 + AES-256-GCM) · le serveur de signalisation ne relaie que les infos de connexion et ne voit jamais le contenu des fichiers",
  busy: "Un transfert est déjà en cours — veuillez attendre qu’il se termine",
  tooMany: (m, n) => `Jusqu’à ${m} fichiers à la fois ; ${n} en trop ignoré(s)`,
  titleDefault: "Relayium — transfert de fichiers chiffré de bout en bout",
  status: {
    connecting: "Établissement d’une connexion chiffrée…",
    waitingAccept: "En attente de l’acceptation du destinataire…",
    rejected: "Refusé par le destinataire ✗",
    sending: "Envoi…",
    finishing: "Finalisation…",
    sendDone: (n) => `Envoyé ✓ (${n} fichier${n === 1 ? "" : "s"})`,
    sendFail: "Échec de l’envoi ✗",
    receiving: "Réception…",
    recvDone: (n) => `Reçu ✓ (${n} fichier${n === 1 ? "" : "s"})`,
    integrityFail: "Échec du contrôle d’intégrité ✗",
    recvFail: "Échec de la réception ✗",
    noSave: "Aucun emplacement de sauvegarde choisi — annulé",
    connectFail: "Échec de la connexion ✗",
  },
  account: {
    signIn: "Se connecter",
    signOut: "Se déconnecter",
    email: "Adresse e-mail",
    sendLink: "M'envoyer un lien de connexion",
    linkSent: "Vérifiez votre boîte mail pour le lien de connexion.",
    continueGoogle: "Continuer avec Google",
    or: "ou",
    signedInAs: (e) => `Connecté en tant que ${e}`,
    password: "Mot de passe",
    createAccount: "Créer un compte",
    logInBtn: "Se connecter",
    toRegister: "Pas de compte ? S'inscrire",
    toLogin: "Déjà un compte ? Se connecter",
    errTooShort: "Le mot de passe doit comporter au moins 8 caractères.",
    errEmailTaken: "Cet e-mail est déjà enregistré — veuillez vous connecter.",
    errLogin: "E-mail ou mot de passe incorrect.",
    changePassword: "Changer le mot de passe",
    setPassword: "Définir un mot de passe",
    currentPassword: "Mot de passe actuel",
    newPassword: "Nouveau mot de passe",
    confirmPassword: "Confirmer le nouveau mot de passe",
    pwChanged: "Mot de passe mis à jour. Les autres appareils ont été déconnectés.",
    errCurrentWrong: "Le mot de passe actuel est incorrect.",
    errMismatch: "Les nouveaux mots de passe ne correspondent pas.",
  },
  nav: { lanTab: "Transfert LAN", crossTab: "Inter-réseaux" },
  crossnet: {
    sendAcross: "Générer un lien de partage",
    loginFirst: "Veuillez vous connecter avant de lancer un transfert inter-réseaux",
    shareHint: "Envoyez ce lien à l'autre personne ; une fois ouvert, vérifiez le code à 6 chiffres ci-dessous pour transférer",
    copy: "Copier le lien",
    copied: "Copié",
    connecting: "Connexion via le lien inter-réseaux…",
    linkDead: "Ce lien est invalide ou déjà utilisé — demandez-en un nouveau à l'expéditeur",
    realtimeTitle: "Transfert direct en temps réel",
    realtimeSub: "Les deux en ligne · pair-à-pair · les fichiers ne passent jamais par le serveur",
    realtimeFoot: "Sans connexion · connectez-vous pour une meilleure connectivité",
  },
  methods: {
    pairing: { name: "🔢 Code d'appairage", sub: "Un côté crée un code à 6 chiffres, l'autre le saisit pour une liaison pair-à-pair instantanée. Le plus rapide.", badge: "Sans connexion" },
    share: { name: "🔗 Lien de partage", sub: "Générez un lien relayé ou un QR code et envoyez-le ; en l'ouvrant, vous êtes connectés en temps réel, avec une meilleure connectivité.", badge: "Connexion requise", signIn: "Connectez-vous pour générer un lien de partage" },
    stored: { name: "📦 Lien de téléchargement", sub: "Votre navigateur chiffre puis stocke temporairement ; le destinataire télécharge quand il veut, sans session ni compte.", badge: "Même hors ligne" },
  },
  pair: {
    sendCode: "Créer un code d'appairage",
    enterCode: "Saisir un code d'appairage",
    enterHint: "Demandez à l'expéditeur son code à 6 chiffres",
    joinBtn: "Connecter",
    yourCode: "Votre code d'appairage — communiquez-le à l'autre personne",
  scanHint: "ou faites scanner le QR / ouvrir le lien à l'autre personne",
    waiting: "En attente de l'autre appareil…",
    expiresIn: (s) => `expire dans ${s}`,
    expired: "Code d'appairage expiré — générez-en un nouveau",
    copy: "Copier",
    copied: "Copié",
    copyLink: "Copier le lien",
    errExpired: "Code d'appairage invalide ou expiré",
  },
  stored: {
    pick: "Choisir des fichiers à envoyer",
    uploading: "Chiffrement et envoi…",
    burnLabel: "Détruire après lecture (supprimé au premier téléchargement)",
    ttlLabel: "Expire dans",
    ttl1d: "1 jour",
    ttl3d: "3 jours",
    ttl7d: "7 jours",
    linkReady: "Lien prêt — envoyez-le au destinataire pour télécharger :",
    expiresOn: (w) => `Ce lien expire le ${w}`,
    copy: "Copier le lien",
    copied: "Copié",
    errTooLarge: "Le fichier dépasse la taille maximale par fichier.",
    errQuota: "Quota d'envoi du jour dépassé — réessayez plus tard.",
    errUpload: "Échec de l'envoi, veuillez réessayer.",
  },
  download: {
    loading: "Lecture du lien…",
    files: "Fichiers à télécharger",
    summary: (c, s) => `${c} fichier${c === 1 ? "" : "s"} · ${s} au total`,
    expiresIn: (l) => `Expire dans ${l}`,
    durUnits: { d: "j", h: "h", m: "min" },
    zeroKnowledge: "🔒 Les fichiers sont chiffrés dans le navigateur de l'expéditeur — même notre serveur ne peut ni les déchiffrer ni les consulter. Avant de télécharger, assurez-vous que le lien provient d'une personne de confiance.",
    burnWarning: "⚠️ Ce fichier ne peut être téléchargé qu'une seule fois — il est ensuite définitivement supprimé, sans récupération possible. Assurez-vous d'une connexion stable pour tout télécharger d'un coup.",
    sendPrompt: "Besoin de renvoyer des fichiers ?",
    sendCta: "Envoyer en toute sécurité avec Relayium →",
    downloadBtn: "Télécharger et déchiffrer",
    downloading: "Téléchargement et déchiffrement…",
    done: "Téléchargement terminé ✓",
    notFound: "Ce lien est invalide, expiré, ou déjà téléchargé puis supprimé.",
    noKey: "Lien incomplet : la clé de déchiffrement (#k=) est absente.",
    decryptFail: "Échec du déchiffrement : mauvaise clé ou fichier corrompu.",
    unsupported: "Le téléchargement déchiffré nécessite HTTPS (ou localhost).",
  },
  features: {
    title: "Pourquoi Relayium",
    sub: "Confidentialité d'abord, pair-à-pair, open source — le transfert de fichiers tel qu'il devrait être.",
    items: [
      { title: "Chiffré de bout en bout", desc: "X25519 + AES-256-GCM ; les clés sont négociées uniquement entre les deux appareils et le serveur ne peut pas déchiffrer." },
      { title: "Les fichiers ne passent jamais par le serveur", desc: "En mode temps réel, les octets circulent d'appareil à appareil via WebRTC sans jamais passer par le serveur ; le mode lien de téléchargement optionnel ne stocke que du chiffré à divulgation nulle." },
      { title: "Vérification anti-interception", desc: "Les deux écrans affichent le même code (SAS) ; comparez-le pour écarter une attaque de l'homme du milieu." },
      { title: "Multiplateforme", desc: "Windows, macOS, Linux, Android, iOS — n'importe quel navigateur moderne, rien à installer." },
      { title: "Open source et auditable", desc: "Le protocole et tout le code sont publics sur GitHub — chacun peut l'examiner, l'auto-héberger ou y contribuer." },
      { title: "Éphémère par conception", desc: "Les liens de téléchargement peuvent expirer sous 1/3/7 jours ou se détruire après le premier téléchargement, sans laisser de trace durable." },
    ],
  },
  howItWorks: {
    title: "Trois façons de franchir les réseaux",
    sub: "Pas sur le même réseau local ? Choisissez celle qui convient — selon que votre correspondant est en ligne et prêt à se connecter.",
    ways: [
      { icon: "🔢", name: "Code d'appairage", how: "Quand les deux sont en ligne, l'un touche « Créer un code d'appairage » pour obtenir un nombre à 6 chiffres ; l'autre le saisit pour ouvrir un lien direct pair-à-pair. Sans connexion, le plus rapide à lancer.", tag: "Les fichiers ne passent jamais par le serveur" },
      { icon: "🔗", name: "Lien de partage", how: "Connectez-vous pour générer un lien relayé ou un QR code et l'envoyer ; dès qu'il l'ouvre, vous êtes connectés en temps réel, avec une meilleure connectivité. Même relayé, le trafic reste chiffré de bout en bout.", tag: "Chiffré de bout en bout" },
      { icon: "📥", name: "Lien de téléchargement", how: "Votre navigateur chiffre avant l'envoi ; le serveur ne stocke que du chiffré. Le destinataire n'a besoin ni de compte ni de session active — il télécharge quand il veut, avec expiration ou destruction après lecture.", tag: "Chiffré uniquement" },
    ],
  },
  compare: {
    title: "Quel mode choisir",
    sub: "« Direct en temps réel » quand les deux sont en ligne maintenant ; « Lien de téléchargement » pour récupérer plus tard.",
    colFeature: "Critère",
    colRealtime: "⚡ Direct en temps réel",
    colStored: "📦 Lien de téléchargement",
    rows: [
      { label: "Connexion requise", realtime: "Non (connectez-vous pour une meilleure connectivité)", stored: "L'expéditeur se connecte" },
      { label: "Destinataire en ligne ?", realtime: "Oui — les deux en ligne en même temps", stored: "Non — téléchargement asynchrone" },
      { label: "Fichiers via le serveur ?", realtime: "Non · pair-à-pair (le lien de partage peut basculer vers un relais chiffré)", stored: "Oui, mais uniquement du chiffré à divulgation nulle" },
      { label: "Durée de vie", realtime: "Envoyé puis disparu, rien de stocké", stored: "1 / 3 / 7 jours, ou destruction après lecture" },
      { label: "Idéal pour", realtime: "Transfert direct de gros fichiers pendant que les deux sont en ligne", stored: "Destinataire hors ligne, ou un lien pour plusieurs" },
    ],
  },
  useCases: {
    title: "Pensé pour ces moments",
    sub: "De la collaboration à distance à l'envoi unique sensible à la confidentialité.",
    items: [
      { icon: "🌍", title: "Envoyer de gros fichiers à l'autre bout du monde", desc: "Expédiez une vidéo de plusieurs gigaoctets, un fichier de conception ou un jeu de données directement à un collègue ou un proche à l'étranger — écrit en flux sur le disque, sans saturer la mémoire ni perte de qualité." },
      { icon: "⏳", title: "Quand il n'est pas en ligne", desc: "Générez un lien de téléchargement chiffré avec une expiration et envoyez-le ; il le récupère quand il est libre — et un seul lien peut servir à plusieurs destinataires." },
      { icon: "📱", title: "Téléphone ↔ ordinateur", desc: "Déplacez des fichiers entre vos propres appareils, d'un système et d'un réseau à l'autre — scannez ou saisissez un code pour vous connecter, sans cloud ni câble." },
      { icon: "🔒", title: "Envoi unique sensible à la confidentialité", desc: "Chiffrement de bout en bout et code de vérification SAS contre l'interception, avec destruction après lecture — idéal pour les contrats, pièces d'identité ou clés." },
    ],
  },
  faq: {
    title: "Questions fréquentes",
    sub: "Ce que vous voudrez peut-être savoir sur le transfert inter-réseaux, la connectivité et la sécurité.",
    items: [
      { q: "Dois-je installer une application ?", a: "Non. N'importe quel navigateur moderne transfère directement depuis la page web — Chrome est recommandé (écrit les gros fichiers en flux sur le disque, avec un dossier cible optionnel, sans utiliser la mémoire)." },
      { q: "Que faire si ça ne connecte pas ?", a: "Un code d'appairage est en direct uniquement (hole-punching STUN). Si un réseau restrictif le bloque, un lien de partage est plus robuste — il inclut un relais TURN et bascule vers un relais chiffré quand le hole-punching échoue. Toujours bloqué ? Un lien de téléchargement est l'option la plus fiable (asynchrone)." },
      { q: "Quelle taille les fichiers peuvent-ils atteindre ?", a: "Le transfert direct en temps réel diffuse les données en flux, donc il n'y a en pratique aucune limite stricte de taille ; les liens de téléchargement sont soumis à une taille maximale par fichier et à un quota quotidien, que la page vous indiquera." },
      { q: "Le serveur peut-il voir mes fichiers ?", a: "Non. Les transferts en temps réel ne passent jamais par le serveur ; les liens de téléchargement sont chiffrés dans votre navigateur et le serveur ne conserve que du chiffré qu'il ne peut pas déchiffrer — la clé reste uniquement chez celui qui partage le lien et son destinataire." },
      { q: "Faut-il obligatoirement créer un compte ?", a: "Le flux par code d'appairage ne nécessite aucune connexion. Les liens de partage et de téléchargement exigent que l'expéditeur se connecte, afin de créer un lien relayé ou du chiffré stocké." },
      { q: "Est-ce open source ?", a: "Oui. La conception du protocole ainsi que tout le code front-end et back-end sont publics sur GitHub — libres à examiner, auto-héberger ou enrichir." },
    ],
  },
  crossPitch: "Sur le même réseau, le « transfert en réseau local » est le plus simple ; à distance, utilisez l'une des trois façons ci-dessous pour aller en direct à travers les réseaux.",
  homeCross: {
    title: "Pas sur le même réseau ?",
    desc: "Le transfert inter-réseaux prend en charge les codes d'appairage, les liens de partage et les liens de téléchargement chiffrés — chiffré de bout en bout, même à l'autre bout du monde.",
    cta: "Aller au transfert inter-réseaux →",
  },
  legal: { privacy: "Politique de confidentialité", terms: "Conditions d'utilisation" },
};

export const messages: Record<Lang, Messages> = { zh, en, ja, ko, de, fr };

const STORAGE_KEY = "relayium-lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in messages) return saved as Lang;
  } catch { /* storage may be unavailable */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  for (const code of ["zh", "ja", "ko", "de", "fr"] as Lang[]) {
    if (nav.startsWith(code)) return code;
  }
  return "en";
}

let current = $state<Lang>(detect());

/** Reactive read of the current language. */
export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
