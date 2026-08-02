import { describe, it, expect } from "vitest";
import { relayFailNote, relayWarnNote } from "./relay-status";
import type { RelayAvailability } from "./ice";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
const FAULTS: RelayAvailability[] = ["quota", "unverified", "unavailable", "none"];

describe("relay status copy", () => {
  // The point of the whole change: a cross-network failure has to say WHICH
  // problem it was. Three of these four used to produce no message at all, so
  // "connection failed" was the entire explanation for a session that never had
  // a relay to begin with.
  it("gives every relay fault its own distinct message, in every locale", () => {
    for (const [lang, t] of Object.entries(locales)) {
      const notes = FAULTS.map((s) => relayFailNote(t, s));
      for (const [i, note] of notes.entries()) {
        expect(note, `${lang}/${FAULTS[i]} has a fail note`).toBeTruthy();
      }
      expect(new Set(notes).size, `${lang}: fail notes are distinct`).toBe(FAULTS.length);

      const warns = FAULTS.map((s) => relayWarnNote(t, s));
      for (const [i, warn] of warns.entries()) {
        expect(warn, `${lang}/${FAULTS[i]} has a warn note`).toBeTruthy();
      }
      expect(new Set(warns).size, `${lang}: warn notes are distinct`).toBe(FAULTS.length);
    }
  });

  // Equally important: do NOT invent a relay explanation for a failure that had
  // nothing to do with the relay. A transfer that had a working relay and still
  // failed keeps the generic status line, which is the honest one.
  it("says nothing when a relay was available", () => {
    for (const [lang, t] of Object.entries(locales)) {
      expect(relayFailNote(t, "ok"), lang).toBe("");
      expect(relayWarnNote(t, "ok"), lang).toBe("");
    }
  });

  // The two paid/gated causes must keep pointing at the action that fixes them,
  // because those are the ones a user cannot resolve by retrying.
  it("keeps the actionable causes actionable in English", () => {
    expect(relayFailNote(en, "quota")).toMatch(/relay traffic is used up/i);
    expect(relayFailNote(en, "unverified")).toMatch(/verify your email/i);
    expect(relayFailNote(en, "unavailable")).toMatch(/reload/i);
    expect(relayWarnNote(en, "unavailable")).toMatch(/reload/i);
  });
});
