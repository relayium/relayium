import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("pairing-code expiry copy", () => {
  it("matches the server's thirty-minute code TTL in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const tag = messages.howItWorks.realtime.ways[1].tag;
      expect(tag, lang).toMatch(/30/);
      // The two values this copy has actually carried before. Matching either
      // means a locale was left behind by a TTL change — which is the whole
      // reason this test exists.
      expect(tag, lang).not.toMatch(/\b15\b/);
      expect(tag, lang).not.toMatch(/(?<!\d)5(?!\d)/);
    }
  });

  // The owner read the minter's countdown as "this transfer expires in N" and
  // asked whether a transfer really only lasts five minutes. It never did: the
  // code is checked once, at /ws join time, and nothing re-checks it afterwards.
  // The copy now has to say both halves of that out loud, in every locale — a
  // longer TTL alone would have left the same wrong impression, just later.
  it("says the countdown is the code, and that a live transfer is not cut off", () => {
    // "the code stops admitting" and "the transfer keeps going" — each locale's
    // own words for the second idea, which is the one that was missing entirely.
    const transferKeepsGoing: Record<string, RegExp> = {
      en: /transfer keeps running to completion/i,
      zh: /传输会一直进行到完成/,
      ja: /転送は最後まで続き/,
      ko: /전송은 끝까지 진행되며/,
      de: /läuft die Übertragung bis zum Ende weiter/i,
      fr: /le transfert va jusqu'au bout/i,
      ar: /يستمر النقل حتى يكتمل/u,
      es: /la transferencia sigue hasta terminar/i,
      pt: /a transferência segue até o fim/i,
    };
    for (const [lang, messages] of Object.entries(locales)) {
      expect(messages.pair.ttlNote, `${lang}: ttlNote present`).toBeTruthy();
      expect(messages.pair.ttlNote, `${lang}: transfer is not cut off`).toMatch(transferKeepsGoing[lang]);
      // The countdown label itself must name the code, so the number is never
      // read as a transfer budget even before the note is read.
      expect(messages.pair.expiresIn("30:00"), `${lang}: countdown names the code`).toContain("30:00");
      expect(messages.pair.expiresIn("30:00").length, `${lang}: countdown is more than a bare timer`)
        .toBeGreaterThan("30:00".length + 4);
    }
  });

  it("teaches the real post-join file-or-text flow in every locale", () => {
    const textTokens: Record<string, RegExp> = {
      en: /text/i,
      zh: /文本/,
      ja: /テキスト/,
      ko: /텍스트/,
      de: /Text/i,
      fr: /texte/i,
      ar: /نص/u,
      es: /texto/i,
      pt: /texto/i,
    };

    for (const [lang, messages] of Object.entries(locales)) {
      const [create, , choose] = messages.howItWorks.realtime.ways;
      expect(create.how, `${lang}: six-character code`).toMatch(/6/);
      expect(choose.how, `${lang}: batch cap`).toMatch(/1(?:[,\s. ]*)000/);
      expect(choose.how, `${lang}: text option`).toMatch(textTokens[lang]);
      expect(choose.how, `${lang}: SAS`).toMatch(/SAS/i);
      expect(choose.how, `${lang}: TURN`).toMatch(/TURN/i);
    }

    expect(en.howItWorks.realtime.ways[0].name).toBe("Create a pairing code");
    expect(en.howItWorks.realtime.ways[2].name).toBe("Choose files or text");
    expect(JSON.stringify(en.howItWorks.realtime.ways)).not.toMatch(
      /Pick files, get a code|Transfer starts on join|starts automatically/i,
    );
  });
});

// ── the copy that lives outside the message catalogue ───────────────────────
//
// The tests above cover `messages`. But the same number is also written out by
// hand in the CLI page's sample output and in the static-page generator's prose,
// in nine languages — and that is exactly where the last TTL change was left
// behind: the server moved to 30 minutes while ja/ar articles and every locale's
// long CLI description still promised 5.
//
// So this reads the ACTUAL server constant and then checks every duration in
// those files against it. It is deliberately a whole-file scan rather than a
// list of known-bad phrases: a new sentence in a new language is caught too,
// because these particular files talk about no other duration.

// Resolved from the vitest working directory (web/), not from import.meta.url:
// Vite rewrites `new URL(..., import.meta.url)` into an asset import, which
// refuses paths outside the project root.
const repoFile = (p: string) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

/** The one authority for the pairing TTL, read from Go rather than restated. */
function serverTtlMinutes(): number {
  const src = repoFile("server/internal/signal/pair.go");
  const m = /CodeTTLSeconds\s+int64\s*=\s*(\d+)/.exec(src);
  expect(m, "CodeTTLSeconds must stay greppable — the copy tests read it").toBeTruthy();
  const seconds = Number(m![1]);
  expect(seconds % 60, "a TTL that is not whole minutes needs new copy, not a new regex").toBe(0);
  return seconds / 60;
}

/** Spelled-out forms, per whole-minute value the copy is allowed to use. */
const SPELLED: Record<number, string[]> = { 30: ["thirty", "ثلاثين"] };

/** Every "<count> <minute-unit>" in a piece of source, across the nine locales. */
const DURATIONS = /(\d+|five|ten|fifteen|thirty|خمس|عشر|ثلاثين)[  ]?(minutes?|min\b|分钟|分間|分|분|Minuten?|minutos?|دقيقة|دقائق)/gu;

// Every file here states the pairing-code TTL and no other duration, so the
// rule can be absolute: each match must be the server's number.
const PAIRING_COPY = [
  "web/src/lib/CliPage.svelte",
  ...["en", "zh", "ja", "ko", "de", "fr", "ar", "es", "pt"].map((l) => `web/src/lib/i18n/${l}.ts`),
  "web/scripts/pages/content/cross-network.mjs",
  "web/scripts/pages/content/spa-pages.mjs",
  "web/scripts/pages/content/articles/cli-send-to-someone.mjs",
  "web/scripts/pages/content/articles/guides-receive-from-cli.mjs",
  "web/scripts/pages/content/articles/howto-transfer-by-qr-code.mjs",
  "web/scripts/pages/content/articles/howto-send-text-between-devices.mjs",
];

describe("hand-written pairing-TTL copy outside the catalogue", () => {
  it("quotes the server's CodeTTLSeconds in every language", () => {
    const minutes = serverTtlMinutes();
    const words = SPELLED[minutes];
    expect(words, `add the spelled-out forms of ${minutes} to SPELLED`).toBeTruthy();
    for (const path of PAIRING_COPY) {
      const source = repoFile(path);
      const found = [...source.matchAll(DURATIONS)];
      expect(found.length, `${path}: expected it to state the TTL at all`).toBeGreaterThan(0);
      for (const [whole, count] of found) {
        const ok = /^\d+$/.test(count) ? Number(count) === minutes : words.includes(count);
        expect(ok, `${path}: "${whole.trim()}" is not the server's ${minutes}-minute TTL`).toBe(true);
      }
    }
  });

  // The manual test plan quotes the TTL twice and also documents an unrelated
  // 10-minute idle timeout, so it gets the narrower rule: no stale pairing
  // number may appear anywhere in it.
  it("leaves no stale number in the manual test plan", () => {
    const minutes = serverTtlMinutes();
    const doc = repoFile("docs/TESTING.md");
    for (const [whole, count] of doc.matchAll(DURATIONS)) {
      const n = /^\d+$/.test(count) ? Number(count) : { five: 5, ten: 10, fifteen: 15, thirty: 30 }[count as string];
      expect(n === minutes || n === 10, `docs/TESTING.md: "${whole.trim()}" is neither the ${minutes}-minute TTL nor the 10-minute idle timeout`).toBe(true);
    }
  });
});
