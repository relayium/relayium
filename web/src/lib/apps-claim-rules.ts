// Shared negative product-copy rules for both /apps renderers.
//
// Keep ASCII alternatives inside word boundaries so fragments such as "fast"
// do not match unrelated words. CJK alternatives must stay outside `\b`: in
// JavaScript, `\b` is based on ASCII `\w`, so a boundary around Chinese text
// can never match.
export const FORBIDDEN_APP_CLAIMS: { why: string; re: RegExp }[] = [
  {
    why: "a native app is not a faster transfer",
    re: /\b(?:faster|fastest|quicker|speed(?:ier)?|higher throughput)\b|更快|速度更快|更高的?速度/i,
  },
  {
    why: "there is no general native background transfer",
    re: /\b(?:in the background|background transfers?|background sync)\b|后台传输|后台同步|在后台/i,
  },
  {
    why: "iOS does not run in the background or receive push",
    re: /\b(?:push notifications?|remote notifications?)\b|推送通知|推送/i,
  },
  {
    why: "neither app has a store listing",
    re: /\b(?:app\s*store|testflight|play\s*store|google\s*play)\b|应用商店|商店上架/i,
  },
  {
    why: "an in-development app is not promised for a date",
    re: /\b(?:coming soon|launching soon|available soon)\b|即将推出|即将上线|敬请期待/i,
  },
];

/**
 * What the maintained /apps copy must say about the iOS Share Extension, in
 * both renderers.
 *
 * The extension shipped in `apps/ios/RelayiumShare`, and every fact below is
 * one a reader can check there: a `com.apple.share-services` extension point,
 * an activation rule that takes files, images and movies (and deliberately
 * neither text nor a web page), one `application-groups` entitlement and no
 * network client, and no way for a share extension to open its containing app.
 *
 * These are POSITIVE assertions of negative facts on purpose. "The page does
 * not claim an upload" is satisfied by a page that says nothing at all, which
 * is the state this copy is being repaired out of; "the page states that
 * nothing is uploaded" is not.
 */
export const IOS_SHARE_EXTENSION_FACTS: { fact: string; en: RegExp; zh: RegExp }[] = [
  {
    fact: "the system share sheet is the entry point",
    en: /share[\s-]?sheet/i,
    zh: /系统分享面板|分享面板/,
  },
  {
    fact: "it takes files, folders, photos or videos",
    en: /files, folders, photos or videos/i,
    zh: /文件、文件夹、照片或视频/,
  },
  {
    fact: "the copy lands in local app-private storage and stops there",
    en: /copied onto the device|copies them into storage only the app can read/i,
    zh: /复制到本机|复制进只有这个应用能读的存储/,
  },
  {
    fact: "nothing is encrypted, uploaded or turned into a link there",
    en: /nothing is encrypted, uploaded or turned into a link/i,
    zh: /不加密、不上传，也不会生成链接/,
  },
  {
    fact: "iOS does not let the extension open the app",
    en: /does not let a share extension open its own app/i,
    zh: /不允许分享扩展打开自己的应用/,
  },
  {
    fact: "the person opens Relayium and sends the waiting draft by hand",
    en: /you open the app and send them|until you choose them and press Send/i,
    zh: /你打开应用把它们发出去|你选中并按下发送|等你在「发送」里发出/,
  },
];

/**
 * The opposite of each boundary above, as a claim the page may never make.
 *
 * Every rule carries the probe that proves it can fail — the same discipline
 * `FORBIDDEN_APP_CLAIMS` is held to. A banned phrasing nobody has watched match
 * is a rule that protects nothing.
 */
export const FORBIDDEN_IOS_SHARE_CLAIMS: { why: string; re: RegExp; probes: string[] }[] = [
  {
    why: "the extension stages plaintext copies; the app is the only uploader",
    re: /\bupload(?:s|ed|ing)? (?:them|it|your files?|the files?) (?:automatically|for you|right away|immediately)\b|(?:自动|立即|马上)上传/i,
    probes: ["shares upload them automatically", "分享后自动上传"],
  },
  {
    why: "a share extension may not open its containing app",
    re: /\b(?:opens?|launch(?:es)?) (?:Relayium|the app) (?:for you|automatically|by itself)\b|(?:自动|替你)(?:打开|启动)\s*(?:Relayium|应用)/i,
    probes: ["it opens Relayium for you", "会自动打开 Relayium"],
  },
  {
    why: "the waiting draft is only ever sent by an explicit Send",
    re: /\b(?:without|no need to) (?:opening|open) (?:the app|Relayium)\b|\bsends? (?:them|it) (?:automatically|for you)\b|无需打开|自动发送|替你发送/i,
    probes: ["sent without opening the app", "无需打开应用"],
  },
  {
    why: "no key is minted and no link is made outside the app",
    re: /\b(?:encrypts?|seals?) (?:them|it|your files?) (?:in|from) the share sheet\b|\bcreates? (?:a|the) link (?:in|from) the share sheet\b|在分享面板(?:里|中)(?:加密|生成链接)/i,
    probes: ["it encrypts them in the share sheet", "在分享面板里加密"],
  },
];
