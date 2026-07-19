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

export function detectPlatform(ua: string): Platform {
  const s = ua || "";
  if (/iPhone|iPad|iPod/.test(s)) return "ios";
  if (/Android/.test(s)) return "android";
  if (/Macintosh|Mac OS X/.test(s)) return "mac";
  if (/Windows/.test(s)) return "windows";
  if (/Linux/.test(s)) return "linux";
  return "unknown";
}
