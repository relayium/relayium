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
