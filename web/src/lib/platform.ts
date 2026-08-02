// Platform sniffs shared across components. Kept out of App so feature cards
// (e.g. the pairing card's folder button) can gate on them too.

/** iOS/iPadOS Safari has no folder picker (webkitdirectory is inert), so any
 *  "send folder" affordance just misbehaves there. iPadOS 13+ reports a Mac UA,
 *  so a touch-capable "Mac" is treated as iOS-like as well. */
export function isIOS(): boolean {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export const folderUploadSupported = !isIOS();

// A coarse OS class from the User-Agent, used only to highlight the matching card
// on the /apps hub. Best-effort and never throws — an unknown UA reads as "unknown".
// This is intentionally separate from App.svelte's deviceLabel() (which names the
// device for the peer roster): here we want an OS bucket, not a display name.
export type Platform = "mac" | "ios" | "windows" | "linux" | "android" | "unknown";

/**
 * 手机/平板浏览器（含 Android 平板，以及桌面模式下的 iPadOS）。
 *
 * 只有一个用途，而且是一道**硬闸**：手机上一律不开 File System Access 选择器
 * （filesink.ts 的 pickersAllowed）。真机上那条路有两种坏法，而且同一台设备上
 * 会遇到哪一种并不可预测 —— 自带浏览器给不出可用的选择界面直接卡死；Chrome
 * 给得出，但那是个系统页面，误触返回键就把整次接收取消掉。属性存在与否说明
 * 不了任何事情，所以判 true 的设备整条走浏览器下载。
 *
 * 因此这个判断宁可多认（桌面被误判成手机 = 少一次原生选择器，文件照样到手），
 * 不可漏认（手机被误判成桌面 = 事故原样复现）。
 *
 * 判定用纯函数 mobileFromUA，navigator 只在这一层读；测试直接测纯函数
 * （与 detectPlatform 同一路子）。
 */
export function isMobileBrowser(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return mobileFromUA(nav.userAgent || "", nav.userAgentData?.mobile, nav.maxTouchPoints ?? 0);
}

/**
 * UA（+ 可选的 UA-CH `mobile` 位、触摸点数）→ 是不是手机/平板浏览器。
 *
 * `uaDataMobile` 只在为 true 时采信：Chrome 在 Android **平板**上报的是 false，
 * 而平板同样是这条判断想覆盖的设备，所以 false 要继续走 UA 匹配而不是直接返回。
 */
export function mobileFromUA(ua: string, uaDataMobile?: boolean, maxTouchPoints = 0): boolean {
  if (uaDataMobile === true) return true;
  const s = ua || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/.test(s)) return true;
  // iPadOS 13+ 桌面模式：Macintosh UA + 多触摸点（与 isIOS 同一个把戏）。
  return /Macintosh|Mac OS X/.test(s) && maxTouchPoints > 1;
}

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  const s = ua || "";
  if (/iPhone|iPad|iPod/.test(s)) return "ios";
  if (/Android/.test(s)) return "android";
  // iPadOS 13+ in desktop mode reports a Macintosh UA; a touch-capable "Mac" is
  // really an iPad, so pass navigator.maxTouchPoints to disambiguate (same trick
  // as isIOS above). Without it (0), a genuine Mac stays "mac".
  if (/Macintosh|Mac OS X/.test(s)) return maxTouchPoints > 1 ? "ios" : "mac";
  if (/Windows/.test(s)) return "windows";
  if (/Linux/.test(s)) return "linux";
  return "unknown";
}
