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
  peersTitle: string;
  emptyPeers: string;
  pickHint: (max: number) => string;
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
  };
  nav: { lanTab: string; crossTab: string };
  crossnet: {
    sendAcross: string;
    loginFirst: string;
    loginRequired: string;
    shareHint: string;
    copy: string;
    copied: string;
    connecting: string;
    linkDead: string;
  };
  pair: {
    sendCode: string;
    enterCode: string;
    enterHint: string;
    joinBtn: string;
    yourCode: string;
    waiting: string;
    expiresIn: (s: string) => string;
    expired: string;
    copy: string;
    copied: string;
    loginEnhance: string;
    errExpired: string;
  };
  stored: {
    title: string;
    desc: string;
    pick: string;
    uploading: string;
    burnLabel: string;
    ttlLabel: string;
    ttl1d: string;
    ttl3d: string;
    ttl7d: string;
    linkReady: string;
    copy: string;
    copied: string;
    errTooLarge: string;
    errQuota: string;
    errUpload: string;
  };
  download: {
    loading: string;
    files: string;
    downloadBtn: string;
    downloading: string;
    done: string;
    notFound: string;
    noKey: string;
    decryptFail: string;
    unsupported: string;
  };
  features: { items: { title: string; desc: string }[] };
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
  peersTitle: "附近的设备",
  emptyPeers: "还没有其它设备。请在同一网络下的另一台设备 / 另一个浏览器窗口打开本页面。",
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
  },
  nav: { lanTab: "局域网传输", crossTab: "跨网络传输" },
  crossnet: {
    sendAcross: "发送到其他网络的人",
    loginFirst: "请先登录后再发起跨网络传输",
    loginRequired: "跨网络传输需要登录后才能发起。请登录后再继续。",
    shareHint: "把下面的链接发给对方；对方打开后，在下方核对 6 位校验码即可传输",
    copy: "复制链接",
    copied: "已复制",
    connecting: "正在通过跨网络链接连接…",
    linkDead: "链接已失效或正在被使用，请向发送方索要新链接",
  },
  pair: {
    sendCode: "生成配对码",
    enterCode: "输入配对码",
    enterHint: "向对方索取 6 位配对码",
    joinBtn: "连接",
    yourCode: "你的配对码 —— 念给对方",
    waiting: "等待对方加入…",
    expiresIn: (s) => `${s} 后失效`,
    expired: "配对码已失效，请重新生成",
    copy: "复制",
    copied: "已复制",
    loginEnhance: "登录后可生成带中继的分享链接，提升连通性",
    errExpired: "配对码无效或已过期",
  },
  stored: {
    title: "生成下载链接（暂存传输）",
    desc: "浏览器先加密再上传，服务器只存密文；把链接发给对方，对方无需登录即可下载。",
    pick: "选择文件上传",
    uploading: "正在加密并上传…",
    burnLabel: "阅后即焚（首次下载后删除）",
    ttlLabel: "有效期",
    ttl1d: "1 天",
    ttl3d: "3 天",
    ttl7d: "7 天",
    linkReady: "链接已生成，发给对方即可下载：",
    copy: "复制链接",
    copied: "已复制",
    errTooLarge: "文件超过单文件大小上限。",
    errQuota: "已超过今日上传额度，请稍后再试。",
    errUpload: "上传失败，请重试。",
  },
  download: {
    loading: "正在读取链接…",
    files: "待下载文件",
    downloadBtn: "下载并解密",
    downloading: "正在下载并解密…",
    done: "下载完成 ✓",
    notFound: "链接无效、已过期或已被下载删除。",
    noKey: "链接不完整：缺少解密密钥（#k=）。",
    decryptFail: "解密失败：密钥错误或文件已损坏。",
    unsupported: "需要 HTTPS（或 localhost）才能解密下载。",
  },
  features: {
    items: [
      { title: "端到端加密", desc: "X25519 + AES-256-GCM,密钥只在两台设备间,服务器无法解密。" },
      { title: "文件不经服务器", desc: "实时直传通过 WebRTC 在设备间直接流动，绝不经过服务器；可选的下载链接为零知识加密暂存。" },
      { title: "防中间人", desc: "两边屏幕显示同一段校验码(SAS),核对一致即可排除中间人。" },
      { title: "跨平台", desc: "Windows、macOS、Linux、Android、iOS,任意现代浏览器都能用。" },
    ],
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
  peersTitle: "Nearby devices",
  emptyPeers: "No other devices yet. Open this page on another device or browser window on the same network.",
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
  },
  nav: { lanTab: "LAN transfer", crossTab: "Cross-network" },
  crossnet: {
    sendAcross: "Send to someone on another network",
    loginFirst: "Please sign in before starting a cross-network transfer",
    loginRequired: "Starting a cross-network transfer requires signing in. Please sign in to continue.",
    shareHint: "Send this link to the other person; once they open it, verify the 6-digit code below to transfer",
    copy: "Copy link",
    copied: "Copied",
    connecting: "Connecting over the cross-network link…",
    linkDead: "This link is invalid or already in use — ask the sender for a new one",
  },
  pair: {
    sendCode: "Create a pairing code",
    enterCode: "Enter a pairing code",
    enterHint: "Ask the sender for their 6-digit code",
    joinBtn: "Connect",
    yourCode: "Your pairing code — read it to the other person",
    waiting: "Waiting for the other device to join…",
    expiresIn: (s) => `expires in ${s}`,
    expired: "Pairing code expired — generate a new one",
    copy: "Copy",
    copied: "Copied",
    loginEnhance: "Sign in to also get a relayed share link for better connectivity",
    errExpired: "Pairing code is invalid or expired",
  },
  stored: {
    title: "Create a download link (stored transfer)",
    desc: "Your browser encrypts files before upload; the server stores only ciphertext. Share the link — the recipient downloads without signing in.",
    pick: "Choose files to upload",
    uploading: "Encrypting and uploading…",
    burnLabel: "Burn after reading (delete on first download)",
    ttlLabel: "Expires in",
    ttl1d: "1 day",
    ttl3d: "3 days",
    ttl7d: "7 days",
    linkReady: "Link ready — send it to the recipient to download:",
    copy: "Copy link",
    copied: "Copied",
    errTooLarge: "The file exceeds the single-file size limit.",
    errQuota: "You've exceeded today's upload quota — please try again later.",
    errUpload: "Upload failed, please try again.",
  },
  download: {
    loading: "Reading the link…",
    files: "Files to download",
    downloadBtn: "Download & decrypt",
    downloading: "Downloading and decrypting…",
    done: "Download complete ✓",
    notFound: "This link is invalid, expired, or already downloaded and deleted.",
    noKey: "Incomplete link: the decryption key (#k=) is missing.",
    decryptFail: "Decryption failed: wrong key or corrupted file.",
    unsupported: "Decryption requires HTTPS (or localhost).",
  },
  features: {
    items: [
      { title: "End-to-end encrypted", desc: "X25519 + AES-256-GCM; keys stay on the two devices and the server can't decrypt." },
      { title: "Files never touch the server", desc: "In realtime mode, bytes flow device-to-device over WebRTC and never touch the server; the optional download-link mode stores only zero-knowledge ciphertext." },
      { title: "Man-in-the-middle check", desc: "Both screens show the same code (SAS); match it to rule out a MITM." },
      { title: "Cross-platform", desc: "Windows, macOS, Linux, Android, iOS — any modern browser." },
    ],
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
  peersTitle: "近くのデバイス",
  emptyPeers: "他のデバイスはまだありません。同じネットワーク上の別のデバイスやブラウザウィンドウでこのページを開いてください。",
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
  },
  nav: { lanTab: "LAN 転送", crossTab: "ネットワーク間転送" },
  crossnet: {
    sendAcross: "別のネットワークの相手に送る",
    loginFirst: "ネットワーク間転送を始める前にサインインしてください",
    loginRequired: "ネットワーク間転送を開始するにはログインが必要です。ログインして続行してください。",
    shareHint: "このリンクを相手に送ってください。相手が開いたら、下の6桁コードを確認して転送します",
    copy: "リンクをコピー",
    copied: "コピーしました",
    connecting: "ネットワーク間リンクで接続中…",
    linkDead: "リンクが無効か使用中です。送信者に新しいリンクを依頼してください",
  },
  pair: {
    sendCode: "ペアリングコードを生成",
    enterCode: "ペアリングコードを入力",
    enterHint: "送信者に 6 桁のコードを尋ねてください",
    joinBtn: "接続",
    yourCode: "あなたのペアリングコード — 相手に伝えてください",
    waiting: "相手の参加を待っています…",
    expiresIn: (s) => `${s} で失効`,
    expired: "ペアリングコードが失効しました。再生成してください",
    copy: "コピー",
    copied: "コピーしました",
    loginEnhance: "ログインすると中継付き共有リンクも作成でき、接続性が向上します",
    errExpired: "ペアリングコードが無効か期限切れです",
  },
  stored: {
    title: "ダウンロードリンクを作成（一時保存転送）",
    desc: "ブラウザが暗号化してからアップロードし、サーバーは暗号文のみを保存します。リンクを送れば、相手はログインせずにダウンロードできます。",
    pick: "アップロードするファイルを選択",
    uploading: "暗号化してアップロード中…",
    burnLabel: "閲覧後に削除（最初のダウンロードで削除）",
    ttlLabel: "有効期限",
    ttl1d: "1 日",
    ttl3d: "3 日",
    ttl7d: "7 日",
    linkReady: "リンクを作成しました。相手に送ってダウンロードしてもらえます：",
    copy: "リンクをコピー",
    copied: "コピーしました",
    errTooLarge: "ファイルが単一ファイルの上限を超えています。",
    errQuota: "本日のアップロード上限を超えました。後でもう一度お試しください。",
    errUpload: "アップロードに失敗しました。もう一度お試しください。",
  },
  download: {
    loading: "リンクを読み込み中…",
    files: "ダウンロードするファイル",
    downloadBtn: "ダウンロードして復号",
    downloading: "ダウンロードして復号中…",
    done: "ダウンロード完了 ✓",
    notFound: "このリンクは無効、期限切れ、またはダウンロード済みで削除されています。",
    noKey: "リンクが不完全です：復号キー（#k=）がありません。",
    decryptFail: "復号に失敗しました：キーが違うかファイルが破損しています。",
    unsupported: "復号ダウンロードには HTTPS（または localhost）が必要です。",
  },
  features: {
    items: [
      { title: "エンドツーエンド暗号化", desc: "X25519 + AES-256-GCM。鍵は2台の端末だけに留まり、サーバーは復号できません。" },
      { title: "ファイルはサーバーを経由しない", desc: "リアルタイムモードではデータが WebRTC で端末間を直接流れサーバーを経由しません。オプションのダウンロードリンクモードはゼロ知識暗号文のみを保存します。" },
      { title: "中間者攻撃の検知", desc: "両方の画面に同じコード(SAS)が表示されます。一致を確認して中間者を排除。" },
      { title: "クロスプラットフォーム", desc: "Windows、macOS、Linux、Android、iOS — 最新のブラウザならどれでも。" },
    ],
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
  peersTitle: "주변 기기",
  emptyPeers: "아직 다른 기기가 없습니다. 같은 네트워크의 다른 기기나 브라우저 창에서 이 페이지를 여세요.",
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
  },
  nav: { lanTab: "LAN 전송", crossTab: "네트워크 간 전송" },
  crossnet: {
    sendAcross: "다른 네트워크의 상대에게 보내기",
    loginFirst: "네트워크 간 전송을 시작하려면 먼저 로그인하세요",
    loginRequired: "네트워크 간 전송을 시작하려면 로그인이 필요합니다. 로그인 후 계속하세요.",
    shareHint: "이 링크를 상대에게 보내세요. 상대가 열면 아래 6자리 코드를 확인하여 전송합니다",
    copy: "링크 복사",
    copied: "복사됨",
    connecting: "네트워크 간 링크로 연결 중…",
    linkDead: "링크가 유효하지 않거나 사용 중입니다. 보낸 사람에게 새 링크를 요청하세요",
  },
  pair: {
    sendCode: "페어링 코드 생성",
    enterCode: "페어링 코드 입력",
    enterHint: "보내는 사람에게 6자리 코드를 요청하세요",
    joinBtn: "연결",
    yourCode: "내 페어링 코드 — 상대에게 알려주세요",
    waiting: "상대 기기의 참여를 기다리는 중…",
    expiresIn: (s) => `${s} 후 만료`,
    expired: "페어링 코드가 만료되었습니다. 다시 생성하세요",
    copy: "복사",
    copied: "복사됨",
    loginEnhance: "로그인하면 릴레이 공유 링크도 만들어 연결성을 높일 수 있습니다",
    errExpired: "페어링 코드가 잘못되었거나 만료되었습니다",
  },
  stored: {
    title: "다운로드 링크 생성 (임시 보관 전송)",
    desc: "브라우저가 먼저 암호화한 뒤 업로드하며 서버는 암호문만 저장합니다. 링크를 보내면 상대는 로그인 없이 다운로드할 수 있습니다.",
    pick: "업로드할 파일 선택",
    uploading: "암호화 후 업로드 중…",
    burnLabel: "열람 후 삭제 (첫 다운로드 시 삭제)",
    ttlLabel: "유효 기간",
    ttl1d: "1일",
    ttl3d: "3일",
    ttl7d: "7일",
    linkReady: "링크가 생성되었습니다. 상대에게 보내 다운로드하세요:",
    copy: "링크 복사",
    copied: "복사됨",
    errTooLarge: "파일이 단일 파일 크기 한도를 초과했습니다.",
    errQuota: "오늘 업로드 한도를 초과했습니다. 나중에 다시 시도하세요.",
    errUpload: "업로드에 실패했습니다. 다시 시도하세요.",
  },
  download: {
    loading: "링크를 읽는 중…",
    files: "다운로드할 파일",
    downloadBtn: "다운로드 및 복호화",
    downloading: "다운로드 및 복호화 중…",
    done: "다운로드 완료 ✓",
    notFound: "유효하지 않거나 만료되었거나 이미 다운로드되어 삭제된 링크입니다.",
    noKey: "불완전한 링크: 복호화 키(#k=)가 없습니다.",
    decryptFail: "복호화 실패: 키가 틀리거나 파일이 손상되었습니다.",
    unsupported: "복호화 다운로드에는 HTTPS(또는 localhost)가 필요합니다.",
  },
  features: {
    items: [
      { title: "종단 간 암호화", desc: "X25519 + AES-256-GCM. 키는 두 기기에만 있고 서버는 복호화할 수 없습니다." },
      { title: "파일은 서버를 거치지 않음", desc: "실시간 모드에서는 데이터가 WebRTC로 기기 간 직접 전송되며 서버를 거치지 않습니다. 선택적 다운로드 링크 모드는 제로 지식 암호문만 저장합니다." },
      { title: "중간자 공격 확인", desc: "양쪽 화면에 같은 코드(SAS)가 표시됩니다. 일치를 확인해 중간자를 배제하세요." },
      { title: "크로스 플랫폼", desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저면 모두 가능." },
    ],
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
  peersTitle: "Geräte in der Nähe",
  emptyPeers: "Noch keine anderen Geräte. Öffnen Sie diese Seite auf einem anderen Gerät oder Browserfenster im selben Netzwerk.",
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
  },
  nav: { lanTab: "LAN-Übertragung", crossTab: "Netzübergreifend" },
  crossnet: {
    sendAcross: "An jemanden in einem anderen Netzwerk senden",
    loginFirst: "Bitte melde dich an, bevor du eine netzwerkübergreifende Übertragung startest",
    loginRequired: "Für eine netzübergreifende Übertragung ist eine Anmeldung erforderlich. Bitte melde dich an, um fortzufahren.",
    shareHint: "Sende diesen Link an die andere Person; sobald sie ihn öffnet, bestätige den 6-stelligen Code unten zur Übertragung",
    copy: "Link kopieren",
    copied: "Kopiert",
    connecting: "Verbindung über den netzwerkübergreifenden Link…",
    linkDead: "Dieser Link ist ungültig oder bereits in Gebrauch — bitte den Absender um einen neuen",
  },
  pair: {
    sendCode: "Kopplungscode erstellen",
    enterCode: "Kopplungscode eingeben",
    enterHint: "Frag den Absender nach seinem 6-stelligen Code",
    joinBtn: "Verbinden",
    yourCode: "Dein Kopplungscode — sag ihn der anderen Person",
    waiting: "Warte darauf, dass das andere Gerät beitritt…",
    expiresIn: (s) => `läuft in ${s} ab`,
    expired: "Kopplungscode abgelaufen — bitte neu erzeugen",
    copy: "Kopieren",
    copied: "Kopiert",
    loginEnhance: "Melde dich an, um zusätzlich einen weitergeleiteten Link für bessere Verbindung zu erhalten",
    errExpired: "Kopplungscode ist ungültig oder abgelaufen",
  },
  stored: {
    title: "Download-Link erstellen (zwischengespeicherte Übertragung)",
    desc: "Ihr Browser verschlüsselt die Dateien vor dem Upload; der Server speichert nur Chiffretext. Teilen Sie den Link — der Empfänger lädt ohne Anmeldung herunter.",
    pick: "Dateien zum Hochladen wählen",
    uploading: "Verschlüsseln und hochladen…",
    burnLabel: "Nach dem Lesen löschen (beim ersten Download)",
    ttlLabel: "Gültig für",
    ttl1d: "1 Tag",
    ttl3d: "3 Tage",
    ttl7d: "7 Tage",
    linkReady: "Link bereit — senden Sie ihn dem Empfänger zum Herunterladen:",
    copy: "Link kopieren",
    copied: "Kopiert",
    errTooLarge: "Die Datei überschreitet das Einzeldatei-Limit.",
    errQuota: "Das heutige Upload-Kontingent ist erschöpft — bitte später erneut versuchen.",
    errUpload: "Upload fehlgeschlagen, bitte erneut versuchen.",
  },
  download: {
    loading: "Link wird gelesen…",
    files: "Herunterzuladende Dateien",
    downloadBtn: "Herunterladen & entschlüsseln",
    downloading: "Herunterladen und entschlüsseln…",
    done: "Download abgeschlossen ✓",
    notFound: "Dieser Link ist ungültig, abgelaufen oder bereits heruntergeladen und gelöscht.",
    noKey: "Unvollständiger Link: Der Entschlüsselungsschlüssel (#k=) fehlt.",
    decryptFail: "Entschlüsselung fehlgeschlagen: falscher Schlüssel oder beschädigte Datei.",
    unsupported: "Für den entschlüsselten Download ist HTTPS (oder localhost) erforderlich.",
  },
  features: {
    items: [
      { title: "Ende-zu-Ende-verschlüsselt", desc: "X25519 + AES-256-GCM; Schlüssel bleiben auf den beiden Geräten, der Server kann nicht entschlüsseln." },
      { title: "Dateien berühren den Server nie", desc: "Im Echtzeitmodus fließen Bytes per WebRTC direkt zwischen den Geräten und berühren nie den Server; der optionale Download-Link-Modus speichert nur Zero-Knowledge-Chiffretext." },
      { title: "Schutz vor Man-in-the-Middle", desc: "Beide Bildschirme zeigen denselben Code (SAS); stimmt er überein, ist ein MITM ausgeschlossen." },
      { title: "Plattformübergreifend", desc: "Windows, macOS, Linux, Android, iOS — jeder moderne Browser." },
    ],
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
  peersTitle: "Appareils à proximité",
  emptyPeers: "Aucun autre appareil pour l’instant. Ouvrez cette page sur un autre appareil ou une autre fenêtre du même réseau.",
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
  },
  nav: { lanTab: "Transfert LAN", crossTab: "Inter-réseaux" },
  crossnet: {
    sendAcross: "Envoyer à quelqu'un sur un autre réseau",
    loginFirst: "Veuillez vous connecter avant de lancer un transfert inter-réseaux",
    loginRequired: "Lancer un transfert inter-réseaux nécessite une connexion. Veuillez vous connecter pour continuer.",
    shareHint: "Envoyez ce lien à l'autre personne ; une fois ouvert, vérifiez le code à 6 chiffres ci-dessous pour transférer",
    copy: "Copier le lien",
    copied: "Copié",
    connecting: "Connexion via le lien inter-réseaux…",
    linkDead: "Ce lien est invalide ou déjà utilisé — demandez-en un nouveau à l'expéditeur",
  },
  pair: {
    sendCode: "Créer un code d'appairage",
    enterCode: "Saisir un code d'appairage",
    enterHint: "Demandez à l'expéditeur son code à 6 chiffres",
    joinBtn: "Connecter",
    yourCode: "Votre code d'appairage — communiquez-le à l'autre personne",
    waiting: "En attente de l'autre appareil…",
    expiresIn: (s) => `expire dans ${s}`,
    expired: "Code d'appairage expiré — générez-en un nouveau",
    copy: "Copier",
    copied: "Copié",
    loginEnhance: "Connectez-vous pour obtenir aussi un lien relayé, plus fiable",
    errExpired: "Code d'appairage invalide ou expiré",
  },
  stored: {
    title: "Créer un lien de téléchargement (transfert stocké)",
    desc: "Votre navigateur chiffre les fichiers avant l'envoi ; le serveur ne stocke que du chiffré. Partagez le lien — le destinataire télécharge sans se connecter.",
    pick: "Choisir des fichiers à envoyer",
    uploading: "Chiffrement et envoi…",
    burnLabel: "Détruire après lecture (supprimé au premier téléchargement)",
    ttlLabel: "Expire dans",
    ttl1d: "1 jour",
    ttl3d: "3 jours",
    ttl7d: "7 jours",
    linkReady: "Lien prêt — envoyez-le au destinataire pour télécharger :",
    copy: "Copier le lien",
    copied: "Copié",
    errTooLarge: "Le fichier dépasse la taille maximale par fichier.",
    errQuota: "Quota d'envoi du jour dépassé — réessayez plus tard.",
    errUpload: "Échec de l'envoi, veuillez réessayer.",
  },
  download: {
    loading: "Lecture du lien…",
    files: "Fichiers à télécharger",
    downloadBtn: "Télécharger et déchiffrer",
    downloading: "Téléchargement et déchiffrement…",
    done: "Téléchargement terminé ✓",
    notFound: "Ce lien est invalide, expiré, ou déjà téléchargé puis supprimé.",
    noKey: "Lien incomplet : la clé de déchiffrement (#k=) est absente.",
    decryptFail: "Échec du déchiffrement : mauvaise clé ou fichier corrompu.",
    unsupported: "Le téléchargement déchiffré nécessite HTTPS (ou localhost).",
  },
  features: {
    items: [
      { title: "Chiffrement de bout en bout", desc: "X25519 + AES-256-GCM ; les clés restent sur les deux appareils, le serveur ne peut pas déchiffrer." },
      { title: "Les fichiers ne touchent jamais le serveur", desc: "En mode temps réel, les octets circulent d'appareil à appareil via WebRTC sans jamais toucher le serveur ; le mode lien de téléchargement optionnel ne stocke que du chiffré zéro-connaissance." },
      { title: "Détection de l'homme du milieu", desc: "Les deux écrans affichent le même code (SAS) ; vérifiez-le pour écarter un MITM." },
      { title: "Multiplateforme", desc: "Windows, macOS, Linux, Android, iOS — tout navigateur moderne." },
    ],
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
