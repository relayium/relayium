// Shared negative product-copy rules for both /apps renderers.
//
// Keep ASCII alternatives inside word boundaries so fragments such as "fast"
// do not match unrelated words. CJK alternatives must stay outside `\b`: in
// JavaScript, `\b` is based on ASCII `\w`, so a boundary around Chinese text
// can never match.
//
// Every rule carries its own probes. They used to be a separate positional
// list in the SPA test, paired by index — which meant inserting or removing a
// rule silently re-paired the remaining ones with somebody else's probe. A rule
// and the evidence that it can fail belong in the same object.
export type ClaimRule = {
  why: string;
  re: RegExp;
  /** Phrasings the page IS allowed to use, removed before `re` is applied.
   *
   *  This exists for exactly one shape of rule: a ban on a category that has
   *  one true member. Relayium has a public Mac App Store listing, so the page
   *  must be able to name it, while TestFlight, the Play Store and a bare
   *  "App Store" remain claims it cannot support. Subtracting the true phrase
   *  is how the ban keeps its teeth without a second, narrower rule that the
   *  next editor has to keep in sync with this one. */
  allow?: RegExp;
  /** Strings this rule must match, in both maintained languages. A negative
   *  nobody has watched fire is a rule that protects nothing. */
  probes: string[];
  /** Strings this rule must NOT match — the true phrasings `allow` rescues,
   *  and the accurate DENIALS of the banned claim. Asserted wherever `probes`
   *  is. */
  permitted?: string[];
};

// ── denials are not claims ──────────────────────────────────────────────────
// Every rule here bans an assertion, and until 2026-08-28 each one fired on the
// banned words wherever they appeared — including in the sentence that told the
// truth. "No shipped client receives push notifications" was a violation of
// "no shipped client receives push"; "Relayium publishes no Windows app" was a
// violation of "ships no Windows app". That is backwards: the page is not only
// allowed to say those things, they are the correction, and a guard that
// punishes the fix pushes its editor into silence instead of accuracy.
//
// So a match inside a denial is not a violation. "Inside a denial" is judged
// per clause, and only from the negator FORWARD: a negator after the phrase
// ("we ship an iOS app, no really") does not unsay it, and one in a previous
// clause is a different statement.
const CLAUSE_SPLIT = /[.,;:!?—]|[。，；：！？]/g;
// Two halves, and they must stay two: the ASCII negators need `\b`, or "not"
// matches inside "notifications" and every push-notification sentence reads as
// its own denial. Per the note at the top of this file, `\b` around CJK can
// never match, so the Chinese negators are a separate, boundary-free
// alternation. Bare 无 and 不 are deliberately absent from it — they sit inside
// ordinary words (无需, 不再) — so only the compounds this copy uses are listed.
// `不在` joined them on 2026-09-08: "不在 Google Play 上架" is the Chinese for
// "Not on Google Play", and without it the page could not state that absence in
// Chinese at all — the store rule would fire on the very sentence that denies
// the claim, which is the exact failure this whole negator mechanism exists to
// prevent.
const NEGATOR_EN =
  /\b(?:no|not|never|neither|nor|without|none|cannot|can't|doesn't|don't|isn't|aren't|won't|lacks?|lacking)\b/i;
const NEGATOR_ZH =
  /没有|没|无法|不提供|不发布|不推出|不存在|不在|并非|并没|未发布|未上架|未推出|从不|绝不|尚无|均无/;

/** Is the match at `at` inside a clause whose negator precedes it? */
function insideDenial(text: string, at: number): boolean {
  let start = 0;
  for (const m of text.matchAll(CLAUSE_SPLIT)) {
    if (m.index >= at) break;
    start = m.index + m[0].length;
  }
  const before = text.slice(start, at);
  return NEGATOR_EN.test(before) || NEGATOR_ZH.test(before);
}

/** A claim string with the rule's permitted phrasings subtracted. */
export function claimSubject(text: string, rule: ClaimRule): string {
  return rule.allow ? text.replace(rule.allow, " ") : text;
}

/** Does this rule fire on this text? The one place `allow` is honoured, so no
 *  caller can check a rule and forget the exception. */
export function violatesClaim(text: string, rule: ClaimRule): boolean {
  const subject = claimSubject(text, rule);
  // `re` may carry /g from an earlier call site; exec from a known state.
  const re = new RegExp(rule.re.source, rule.re.flags.replace("g", "") + "g");
  for (let m = re.exec(subject); m; m = re.exec(subject))
    if (!insideDenial(subject, m.index)) return true;
  return false;
}

export const FORBIDDEN_APP_CLAIMS: ClaimRule[] = [
  {
    why: "a native app is not a faster transfer",
    re: /\b(?:faster|fastest|quicker|speed(?:ier)?|higher throughput)\b|更快|速度更快|更高的?速度/i,
    probes: ["faster transfers", "传输更快"],
    permitted: ["The app is not faster than the browser.", "原生应用并非更快。"],
  },
  {
    why: "there is no general native background transfer",
    re: /\b(?:in the background|background transfers?|background sync)\b|后台传输|后台同步|在后台/i,
    probes: ["background transfer", "支持后台传输"],
    permitted: ["There are no background transfers.", "没有后台传输。"],
  },
  {
    why: "no shipped client receives push",
    re: /\b(?:push notifications?|remote notifications?)\b|推送通知|推送/i,
    probes: ["push notifications", "支持推送通知"],
    permitted: ["No shipped client receives push notifications.", "任何已发布的客户端都没有推送通知。"],
  },
  {
    // Revised 2026-08-28. This used to read "neither app has a store listing",
    // which stopped being true on 2026-08-26 when Mac App Store 1.3.8 went
    // public — and the rule then forbade the page from stating a fact the
    // repository's own `web/mac-app-store-release.json` records. The boundary
    // that is still real is narrower: one listing exists, and it is that one.
    // TestFlight is internal distribution, not a store; Google Play has no
    // Relayium listing at all and no Android app to list.
    why: "the Mac App Store listing is the only store distribution Relayium has",
    re: /\b(?:app\s*store|testflight|play\s*store|google\s*play)\b|应用商店|商店上架|谷歌商店/i,
    allow: /\bMac App Store\b/gi,
    probes: ["coming to the App Store", "即将上架应用商店", "join the TestFlight", "on Google Play"],
    permitted: [
      "Also on the Mac App Store.",
      "同时上架 Mac App Store。",
      // The accurate denials, in both maintained languages. The Android APK is
      // distributed from GitHub, so the page has to be able to say this.
      "Not on Google Play. It contains no Play Services.",
      "不在 Google Play 上架，不含 Play 服务。",
    ],
  },
  {
    why: "an in-development app is not promised for a date",
    re: /\b(?:coming soon|launching soon|available soon)\b|即将推出|即将上线|敬请期待/i,
    probes: ["coming soon", "即将推出"],
  },
  {
    // Added 2026-08-28, narrowed 2026-09-08.
    //
    // The rule was written when `apps/` held no Android or Windows target at
    // all and /apps carried a card for each anyway. Android came OUT of it on
    // 2026-09-08 because the premise stopped being true: `apps/android/` builds
    // a signed APK, it is published from `web/android-release.json`, and a rule
    // forbidding the page to name it would now forbid the truth rather than a
    // promise. iOS and Windows stay banned — nothing in this repository
    // publishes either, and iOS development is paused with no public listing.
    //
    // Note what did NOT change. Google Play is still forbidden, by the store
    // rule above: shipping an APK from GitHub is not a listing, and that rule
    // is now the one carrying the whole "no Play" claim. "Background transfer"
    // is still forbidden too, and it applies to Android exactly as written —
    // the client has no resident session.
    //
    // The word order is deliberately wide: it only saw "<platform> app" at
    // first, so "an app for iOS", "our client on iPhone" and "the Windows
    // version of the app" all walked past a rule written to stop exactly that
    // promise.
    //
    // `allow` carries the truthful half. Relayium genuinely runs in a browser
    // on an iPhone, and saying so is a Web-platform statement rather than a
    // native-app promise — so "web app", "browser" and their Chinese
    // equivalents are subtracted before the ban is applied, and "the web app on
    // iPhone" stays sayable.
    why: "this repository ships no iOS or Windows app to promise",
    re: /\b(?:iOS|iPhone|iPad|Windows)\s+(?:native\s+|desktop\s+|companion\s+|mobile\s+)*(?:app|application|client)\b|\b(?:native\s+|desktop\s+|companion\s+|mobile\s+)*(?:app|application|client)\s+(?:for|on)\s+(?:iOS|iPhone|iPad|Windows)\b|\b(?:iOS|iPhone|iPad|Windows)\s+version of the (?:app|client)\b|(?:iOS|iPhone|iPad|Windows)\s*(?:桌面|移动)?(?:原生)?(?:应用|客户端)|(?:原生)?(?:应用|客户端)[^。，；]{0,4}(?:适用于|支持|登陆)\s*(?:iOS|iPhone|iPad|Windows)/i,
    allow: /\b(?:web|browser|progressive\s+web|mobile\s+web)\s+(?:app|application|client)\b|\bin (?:the )?(?:browser|Safari|Chrome)\b|网页(?:应用|版)|浏览器(?:里|中|内)?/gi,
    probes: [
      "the iOS app is in development",
      "A native Windows desktop app is being built",
      "our client on iPhone",
      "the Windows version of the app",
      "iOS 应用仍在开发中",
      "客户端支持 Windows",
    ],
    permitted: [
      // True today, and the page has to be able to keep saying it.
      "Open the web app on iPhone — nothing to install.",
      "在 iPhone 的浏览器里打开网页版即可。",
      // The accurate denial, which the old rule flagged as a promise.
      "Relayium publishes no iPhone or iPad app.",
      // Android is a published product now; naming it is a fact, not a promise.
      "Download the Android app.",
      "下载 Android 应用。",
    ],
  },
  {
    // Added 2026-09-08 alongside the Android card. The previous rule stopped
    // banning the WORDS "Android app" because there is one — which means the
    // page can now say true things about it, and could just as easily say
    // untrue ones. This rule bans the specific overclaims the client cannot
    // support: it joins transfers rather than starting them, it has no account
    // features, no Device Inbox, no nearby discovery and no share-sheet entry.
    //
    // These are not hypothetical. Every one of them is a capability the macOS
    // app genuinely has, so the nearest available copy to reuse describes a
    // product this APK is not.
    // Lookaround rather than a spanning match, deliberately. `insideDenial`
    // judges whether a negator precedes the MATCH POSITION, so a pattern that
    // started at "Android" and ran forward to "Device Inbox" would put the
    // match before the "no" in "the Android app has no Device Inbox" — and the
    // rule would reject the very sentence that tells the truth. Anchoring on
    // the claim word keeps the denial sayable.
    why: "the Android preview joins transfers and has no account, inbox, nearby or share-sheet features",
    re: /(?<=\bAndroid\b[^.。]{0,40})(?:Device Inbox|share[- ]sheet|nearby devices?|account features?)\b|(?:Device Inbox|share[- ]sheet|nearby devices?)\b(?=[^.。]{0,40}\bAndroid\b)|(?<=Android[^。，；]{0,20})(?:设备收件箱|分享菜单|附近设备)|(?:设备收件箱|分享菜单|附近设备)(?=[^。，；]{0,20}Android)/i,
    probes: [
      "Android supports Device Inbox",
      "Send from the share sheet on Android",
      "Android finds nearby devices",
      "Android 支持设备收件箱",
      "在 Android 上从分享菜单发送",
    ],
    permitted: [
      // The accurate denials, which the page must be able to state plainly.
      "The Android app has no Device Inbox, no account features and no nearby discovery.",
      "Android 应用没有设备收件箱、账户功能，也没有附近设备发现。",
      "Relayium publishes no Android receiver for Device Inbox.",
    ],
  },
];
