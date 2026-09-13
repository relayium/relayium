// The two colours that exist in two places, pinned to the one that is the
// source.
//
// A window background must exist before any CSS is parsed — it is what the
// compositor paints while there is no page yet — so it cannot be read from the
// stylesheet at runtime. That leaves a copy, and a copy of a colour is the
// quietest thing in a codebase to let rot: the app keeps working, it is simply
// the wrong shade of dark for a while, and nobody files that.
//
// So the copy is checked against `renderer/tokens.css` here. The stylesheet is
// the source; this file is the mirror.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WINDOW_BACKGROUND, windowBackground } from "../../src/main/window-background.js";

const tokens = readFileSync(
  fileURLToPath(new URL("../../src/renderer/tokens.css", import.meta.url)),
  "utf8",
);

/**
 * `--bg` as the stylesheet declares it, light and dark.
 *
 * The dark one is the LAST declaration inside the `prefers-color-scheme: dark`
 * block and the light one is the first outside it, which is how the cascade
 * itself resolves them.
 */
function declaredBackgrounds(): { light: string; dark: string } {
  const darkBlock = tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)"));
  const light = tokens.slice(0, tokens.indexOf("@media (prefers-color-scheme: dark)")).match(/--bg:\s*([^;]+);/);
  const dark = darkBlock.match(/--bg:\s*([^;]+);/);
  expect(light?.[1], "tokens.css declares no light --bg").toBeTruthy();
  expect(dark?.[1], "tokens.css declares no dark --bg").toBeTruthy();
  return { light: light![1]!.trim().toLowerCase(), dark: dark![1]!.trim().toLowerCase() };
}

describe("the window's own background", () => {
  it("is the same colour the page paints, in both appearances", () => {
    const declared = declaredBackgrounds();
    expect(WINDOW_BACKGROUND.light).toBe(declared.light);
    expect(WINDOW_BACKGROUND.dark).toBe(declared.dark);
  });

  it("is chosen by the appearance, not by a default", () => {
    expect(windowBackground(false)).toBe(WINDOW_BACKGROUND.light);
    expect(windowBackground(true)).toBe(WINDOW_BACKGROUND.dark);
    // The defect this replaces: Electron's own documentation says the default
    // is `#FFF`. A dark window that fell back to it would be white behind a
    // dark page — at launch, and in every area a resize exposes.
    expect(windowBackground(true)).not.toBe("#ffffff");
    expect(windowBackground(true)).not.toBe("#fff");
  });

  it("gives both appearances a real colour", () => {
    for (const [name, value] of Object.entries(WINDOW_BACKGROUND)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(WINDOW_BACKGROUND.light).not.toBe(WINDOW_BACKGROUND.dark);
  });
});
