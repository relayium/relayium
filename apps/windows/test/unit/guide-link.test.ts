// The page's half of the one journey out of the help.
//
// The property worth pinning is what crosses: a screen name and a language, and
// nothing else. A page that could hand main an address would be script-
// triggered navigation carrying the user's real browser session, and the whole
// shape of this channel exists to make that impossible to express.
//
// The second property is that a guide which did not open never looks like one
// that did — a missing bridge, a thrown call and a refusal all have to reach
// the reader as the same honest failure rather than as silence.

import { describe, expect, it, vi } from "vitest";
import { openGuide, type HelpBridge } from "../../src/renderer/shell/guide-link.js";

describe("asking main to open a guide", () => {
  it("sends the screen and the language, and nothing else", async () => {
    const openGuideSpy = vi.fn().mockResolvedValue({ ok: true });
    const bridge: HelpBridge = { openGuide: openGuideSpy };

    await expect(openGuide("pair", "zh", bridge)).resolves.toBe(true);

    expect(openGuideSpy).toHaveBeenCalledTimes(1);
    const payload = openGuideSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({ surface: "pair", language: "zh" });
    // Spelled out as well as compared, so a field added later has to be
    // justified here rather than slipping in with a passing deep-equal.
    expect(Object.keys(payload).sort()).toEqual(["language", "surface"]);
    for (const value of Object.values(payload)) {
      expect(String(value)).not.toMatch(/https?:|\/\//);
    }
  });

  it("reports a refusal as a failure to open", async () => {
    const bridge: HelpBridge = { openGuide: async () => ({ ok: false }) };
    await expect(openGuide("account", "en", bridge)).resolves.toBe(false);
  });

  // The bridge is absent in any context that is not the app's own window. An
  // unhandled rejection there would be a page that looks broken rather than a
  // link that could not be followed.
  it("fails honestly when there is no bridge at all", async () => {
    await expect(openGuide("lan", "en", null)).resolves.toBe(false);
  });

  it("fails honestly when the call itself throws", async () => {
    const bridge: HelpBridge = {
      openGuide: async () => {
        throw new Error("refused");
      },
    };
    await expect(openGuide("lan", "en", bridge)).resolves.toBe(false);
  });

  // `ok` is the answer, not the presence of an answer. A main process that
  // returned something else must not be read as success.
  it("treats anything that is not a true ok as a failure", async () => {
    for (const answer of [{}, { ok: "true" }, { ok: 1 }, { ok: null }]) {
      const bridge = { openGuide: async () => answer } as unknown as HelpBridge;
      await expect(openGuide("lan", "en", bridge), JSON.stringify(answer)).resolves.toBe(false);
    }
  });
});
