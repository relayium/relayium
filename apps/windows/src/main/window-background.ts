// The colour the WINDOW is, as opposed to the colour the page paints.
//
// ## Two surfaces, and only one of them was ever given a theme
//
// The renderer follows `prefers-color-scheme` and paints `--bg` — #ffffff in
// light, #1c1c1e in dark. The window underneath it had no colour at all, and
// Electron's own documentation says what that means: "Default is `#FFF`
// (white)."
//
// A user in dark mode therefore sees white twice. Once at launch, in the moment
// between the window being shown and the page having painted; and again every
// time they resize it, because Chromium fills newly exposed area with the
// window's background before the renderer catches up. The second one is not a
// flash — it is a white band that follows the mouse.
//
// macOS has no equivalent: a SwiftUI window takes a semantic background and is
// never briefly the wrong colour.
//
// ## Why the values are duplicated here, and what stops them rotting
//
// A window background has to exist before any CSS is parsed — it is what the
// compositor paints while there is no page yet — so it cannot be read from the
// stylesheet at runtime. That makes this a second copy of two colours, which is
// the shape that goes stale silently.
//
// `window-background.test.ts` reads `renderer/tokens.css` and fails if either
// value here stops matching the token it mirrors. The copy is allowed to exist
// because something checks it, not because it is small.

/** Mirrors `--bg` in `renderer/tokens.css`, light and dark. */
export const WINDOW_BACKGROUND = {
  light: "#ffffff",
  dark: "#1c1c1e",
} as const;

export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}
