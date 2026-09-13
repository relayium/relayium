// The renderer preferences, including the ones whose DEFAULT is the problem.
//
// Everything in this object is a decision. Most of them are decisions to refuse
// something Electron would otherwise allow — a sandbox, an isolated context, no
// Node in the page. `spellcheck` is the one where the default is not merely
// permissive but *networked*, which is why it is asserted with the others and
// with its reason attached rather than left to the comment beside it.

import { describe, expect, it } from "vitest";
import { RENDERER_PREFERENCES } from "../../src/main/window.js";

describe("what the renderer is allowed", () => {
  it("keeps every hardening flag this app depends on", () => {
    expect(RENDERER_PREFERENCES).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    });
  });

  // The defect this test was added for. Electron defaults it to true, and its
  // own documentation says that means downloading hunspell dictionaries from
  // the Chromium CDN on every platform except macOS — so on Windows, typing
  // into a text field reaches a Google-operated server. An app that promises
  // nothing of the user's leaves their machine cannot ship that by omission.
  it("does not spellcheck, because on Windows that is a third-party fetch", () => {
    expect(RENDERER_PREFERENCES.spellcheck).toBe(false);
    // Explicit, not absent. `undefined` here would read as "nobody thought
    // about it" and would behave as `true`, which is exactly how it shipped.
    expect(Object.hasOwn(RENDERER_PREFERENCES, "spellcheck")).toBe(true);
  });

  // A window created without these is a window with none of them: the object is
  // spread into `webPreferences`, so an accidental rename silently drops the
  // protection rather than failing to compile.
  it("names every key the window actually passes", () => {
    expect(Object.keys(RENDERER_PREFERENCES).sort()).toEqual([
      "allowRunningInsecureContent",
      "contextIsolation",
      "experimentalFeatures",
      "nodeIntegration",
      "nodeIntegrationInSubFrames",
      "nodeIntegrationInWorker",
      "sandbox",
      "spellcheck",
      "webSecurity",
      "webviewTag",
    ]);
  });
});
