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
