// Every screen owes the same six answers, and none of them may be empty.
//
// The table exists so a screen cannot quietly answer five of them. These are
// the assertions that make that true at runtime as well as in the type, and
// they are cheap enough to be worth having for copy that a person reads when
// they are already confused.

import { describe, expect, it } from "vitest";
import { HELP } from "../../src/renderer/shell/help-content.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

const PAGES = ["lan", "pair", "stored", "inbox", "account"] as const;

describe("the help every screen ends with", () => {
  it("covers every browseable screen", () => {
    expect(Object.keys(HELP).sort()).toEqual([...PAGES].sort());
  });

  it("answers all six questions on each of them", () => {
    for (const page of PAGES) {
      const content = HELP[page];
      expect(content.steps, page).toHaveLength(3);
      for (const key of [content.purpose, content.boundary, content.where, content.failure, content.recovery, ...content.steps]) {
        // Present in BOTH maintained languages. A key that resolves in English
        // and not in Chinese is a screen that explains itself to half its users.
        expect(en[key], `${page}/${key}/en`).toBeTruthy();
        expect(zh[key], `${page}/${key}/zh`).toBeTruthy();
        expect(en[key]!.trim().length, `${page}/${key}/en`).toBeGreaterThan(0);
        expect(zh[key]!.trim().length, `${page}/${key}/zh`).toBeGreaterThan(0);
      }
    }
  });

  it("gives each screen its OWN answers", () => {
    // Shared copy across screens would mean one of them is describing another,
    // which is the failure mode of writing help by duplication.
    const seen = new Set<string>();
    for (const page of PAGES) {
      const c = HELP[page];
      for (const key of [c.purpose, c.boundary, c.where, c.failure, c.recovery, ...c.steps]) {
        expect(seen.has(key), `${page}/${key} reused`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(PAGES.length * 8);
  });

  it("says what Relayium can see on every screen, in both languages", () => {
    // The boundary answer is the one this product cannot afford to get wrong or
    // to omit: it is the promise the whole design is built on.
    for (const page of PAGES) {
      for (const catalogue of [en, zh]) {
        const said = catalogue[HELP[page].boundary]!;
        expect(said.length, page).toBeGreaterThan(40);
      }
    }
  });

  it("does not tell a Windows reader a macOS fact", () => {
    // The Mac help says received files go to Downloads, which is true there and
    // false here: this client asks for a destination at every receive. Ported
    // copy is how a sentence like that survives into the wrong product.
    for (const page of PAGES) {
      const c = HELP[page];
      for (const key of [c.purpose, c.boundary, c.where, c.failure, c.recovery, ...c.steps]) {
        expect(en[key], `${page}/${key}`).not.toMatch(/\bMac\b/);
        expect(en[key], `${page}/${key}`).not.toMatch(/Downloads folder/);
      }
    }
  });
});
