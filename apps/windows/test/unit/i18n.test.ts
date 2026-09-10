// The two maintained languages, and the gate that keeps them equal.
//
// The supported-language policy makes English and Simplified Chinese a complete
// pair for new user-facing copy. The type system already enforces the key set;
// this asserts the part a type cannot — that no Chinese value was left as its
// English source, and that every placeholder survives translation.

import { describe, expect, it } from "vitest";
import { en, zh, type MessageKey } from "../../src/renderer/i18n/messages.js";
import { isValidCode } from "../../../../web/src/lib/pair-code";
import { isWellFormedPairCode } from "../../src/renderer/pair-code.js";

const keys = Object.keys(en) as MessageKey[];

/** Strings that are correctly identical in both languages. */
const SHARED = new Set<MessageKey>(["appName"]);

describe("EN and zh-Hans are a complete pair", () => {
  it("covers exactly the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual([...keys].sort());
  });

  it("has no empty translation", () => {
    for (const key of keys) expect([key, zh[key].length > 0]).toEqual([key, true]);
  });

  it("has no Chinese value left as its English source", () => {
    // The failure this catches is a key added to `en` and copy-pasted into `zh`
    // to make the compiler stop complaining — which ships English text inside a
    // Chinese UI and passes every other check.
    for (const key of keys) {
      if (SHARED.has(key)) continue;
      expect([key, zh[key]]).not.toEqual([key, en[key]]);
    }
  });

  it("carries the same placeholders in both languages", () => {
    // A dropped `{minutes}` renders a sentence with a hole in it; an invented
    // one renders the literal braces.
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of keys) {
      expect([key, placeholders(zh[key])]).toEqual([key, placeholders(en[key])]);
    }
  });

  it("says 'this PC' rather than a hostname or a peer id", () => {
    // Product vocabulary, checked because it is the one string a peer sees.
    expect(en.thisPc).toBe("This PC");
    expect(zh.thisPc).toBe("这台电脑");
  });

  it("does not leak engineering vocabulary into ordinary copy", () => {
    // No build/origin/server blocks in the product UI.
    for (const key of keys) {
      for (const value of [en[key], zh[key]]) {
        expect([key, /localhost|127\.0\.0\.1|engineering|npm_package/i.test(value)]).toEqual([
          key,
          false,
        ]);
      }
    }
  });
});

describe("the renderer's pair-code check agrees with the web client", () => {
  it("agrees across the alphabet and its neighbours", () => {
    const candidates = [
      "424242", "000000", "999999", "42424", "4242422", "",
      " 424242", "424242 ", "4242a2", "42424٢", "4２4242", "-42424", "42.242",
    ];
    for (const candidate of candidates) {
      expect([candidate, isWellFormedPairCode(candidate)]).toEqual([candidate, isValidCode(candidate)]);
    }
  });
});
