// The image files the main process loads, and the silence when one is absent.
//
// `nativeImage.createFromPath` does not throw on a path that is not there. It
// returns an EMPTY image, and Electron is content to give a tray or a window an
// empty icon: the tray appears as a blank gap with a working menu, the window
// gets the default Electron icon, and nothing is logged by anyone. A rename in
// `assets/`, a `files` pattern in `electron-builder.yml` that stops matching, or
// a path that is right in development and wrong in the packaged layout all look
// identical at runtime — which is to say, they look like nothing at all.
//
// So the paths are read out of the source rather than repeated here. A test
// holding its own copy of the filename would keep passing through exactly the
// rename it exists to catch.

import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const read = (relative: string): string => readFileSync(root(relative), "utf8");

const SOURCES = ["src/main/main.ts", "src/main/handlers.ts"];

/** Every `new URL("../../assets/…", import.meta.url)` the main process builds. */
function referencedAssets(): { source: string; asset: string }[] {
  const found: { source: string; asset: string }[] = [];
  for (const source of SOURCES) {
    for (const match of read(source).matchAll(/new URL\("\.\.\/\.\.\/(assets\/[^"]+)"/g)) {
      found.push({ source, asset: match[1]! });
    }
  }
  return found;
}

describe("the images the main process loads", () => {
  it("references some at all, so this test cannot pass by finding nothing", () => {
    const refs = referencedAssets();
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // Named, so removing the tray icon's load does not quietly shrink the set
    // this file checks.
    expect(new Set(refs.map((r) => r.asset))).toEqual(new Set(["assets/app-icon.png", "assets/tray.png"]));
  });

  it("are present, and are real images rather than empty placeholders", () => {
    for (const { source, asset } of referencedAssets()) {
      const stats = statSync(root(asset), { throwIfNoEntry: false });
      expect(stats, `${source} loads ${asset}, which is not in the repository`).toBeTruthy();
      expect(stats!.size, asset).toBeGreaterThan(0);
      // A PNG signature. An empty or truncated file passes a size check and
      // still gives Electron nothing to draw.
      const head = readFileSync(root(asset)).subarray(0, 8);
      expect([...head], asset).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });

  // The second half of the same question: being in the repository is not being
  // in the package. `files` decides what ships, and a pattern that stops
  // matching is as silent as a missing file.
  it("are matched by a files pattern that actually ships them", () => {
    const config = read("electron-builder.yml");
    const files = config.slice(config.indexOf("\nfiles:"));
    expect(files).toMatch(/^\s+- assets\/\*\*$/m);
    // The one exclusion under `assets/**` is the installer script, and it must
    // stay an exclusion of THAT file only: `!assets/**` or a broader negation
    // would take the icons with it.
    for (const line of files.split(/\r?\n/)) {
      const negation = line.match(/^\s+- "?!(assets\/[^"]*)"?\s*$/);
      if (negation === null) continue;
      expect(negation[1], "a negation under assets/ that is not the installer script").toBe("assets/installer.nsh");
    }
  });
});
