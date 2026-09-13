// How large the window opens, and how small the user may make it.
//
// ## The failure this exists to prevent
//
// Windows display scaling does not make things bigger; it makes the LOGICAL
// screen smaller. A 1366x768 laptop at 150% reports 910x512 of usable space,
// and a 1920x1080 screen at 200% reports 960x540 — minus the taskbar. A window
// whose minimum height is 560 cannot be resized to fit either of them: the
// bottom of the app, including whatever control the user was reaching for, sits
// below the edge of the screen with no way to bring it up.
//
// The sizes here were a straight port of the Mac's, where the same numbers are
// safe: a Retina display reports half its physical pixels, so a MacBook's
// logical space is large whatever the user has chosen. The numbers were right
// and the assumption underneath them was not.
//
// ## Why the minimum moves rather than the layout
//
// The app needs 880x560 to lay out the way it was designed, so that is what it
// ASKS for. When the screen cannot give it, the honest answer is a window the
// size of the screen rather than a window the user cannot see all of — the
// content scrolls, which is a compromise somebody can work with, where a
// control below the bottom edge is not.

/** What the app wants, and the smallest it lays out correctly in. */
export const PREFERRED = { width: 1040, height: 700 } as const;
export const DESIRED_MINIMUM = { width: 880, height: 560 } as const;

export interface WorkArea {
  readonly width: number;
  readonly height: number;
}

export interface WindowSizing {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/**
 * A reading that cannot be used.
 *
 * `workAreaSize` comes from the OS through Electron, and a zero, a negative or
 * a NaN would otherwise become a window with no size at all — a worse outcome
 * than the one this function exists to fix. An unusable reading is ignored and
 * the preferred size is used, which is exactly the behaviour that shipped
 * before this file existed.
 */
const unusable = (value: number): boolean => !Number.isFinite(value) || value < 1;

export function fitToWorkArea(workArea: WorkArea): WindowSizing {
  const width = unusable(workArea.width) ? PREFERRED.width : Math.min(PREFERRED.width, Math.floor(workArea.width));
  const height = unusable(workArea.height) ? PREFERRED.height : Math.min(PREFERRED.height, Math.floor(workArea.height));
  return {
    width,
    height,
    // Never larger than the window itself: a minimum above the opening size
    // would be a window that opens already clamped, which on a small screen is
    // how it opened taller than the desktop in the first place.
    minWidth: Math.min(DESIRED_MINIMUM.width, width),
    minHeight: Math.min(DESIRED_MINIMUM.height, height),
  };
}
