import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const locales = { en, zh };

describe("pairing-code expiry copy", () => {
  it("matches the server's five-minute code TTL in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const tag = messages.howItWorks.realtime.ways[1].tag;
      expect(tag, lang).toMatch(/(?<!\d)5(?!\d)/);
      // The two values this copy has actually carried before. Matching either
      // means a locale was left behind by a TTL change — which is the whole
      // reason this test exists.
      expect(tag, lang).not.toMatch(/\b15\b/);
      expect(tag, lang).not.toMatch(/\b30\b/);
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
      expect(messages.pair.expiresIn("4:59"), `${lang}: countdown names the code`).toContain("4:59");
      expect(messages.pair.expiresIn("4:59").length, `${lang}: countdown is more than a bare timer`)
        .toBeGreaterThan("4:59".length + 4);
    }
  });

  // Pre-upload makes the deadline MOVE: every byte the server commits pushes
  // the room's join window — and with it the code's own expiry — out again, and
  // this client is told where it landed only when an upload finishes. So while
  // one is running there is no number to show, and the line that stands in for
  // the countdown must not invent one.
  it("holds the code open while an upload runs, without inventing a time", () => {
    const staysOpen: Record<string, RegExp> = {
      en: /stays valid while these files upload/i,
      zh: /上传期间保持有效/,
      ja: /アップロード中.*有効なまま/,
      ko: /업로드하는 동안.*계속 유효/,
      de: /bleibt gültig, solange diese Dateien hochgeladen werden/i,
      fr: /reste valide pendant l'envoi de ces fichiers/i,
      ar: /يظل رمز الاقتران صالحًا أثناء رفع هذه الملفات/u,
      es: /sigue válido mientras se suben estos archivos/i,
      pt: /continua válido enquanto estes arquivos são enviados/i,
    };
    for (const [lang, messages] of Object.entries(locales)) {
      const line = messages.pair.ttlUploading;
      expect(line, `${lang}: ttlUploading present`).toBeTruthy();
      expect(line, `${lang}: says the code is held open by the upload`).toMatch(staysOpen[lang]);
      // The whole point: a digit here is a duration this client cannot know.
      expect(line, `${lang}: states no time it cannot know`).not.toMatch(/\d/);
      // And it may not be the countdown's own sentence — that one promises an
      // instant the code stops admitting, which is exactly what is not true
      // while the upload keeps pushing it out.
      expect(line, `${lang}: is not the countdown`).not.toBe(messages.pair.expiresIn(""));
    }
  });

  // And the state neither the countdown nor the "expired" line may stand in for:
  // bytes went up, and no answer about the room came back. The window may have
  // moved and may not have; this client was not told. Saying "expired" there
  // offers to burn a rendezvous the server is still admitting joins on, and
  // saying "valid" invents an assurance nobody gave.
  it("says it cannot confirm the window, without deciding it either way", () => {
    const cannotConfirm: Record<string, RegExp> = {
      en: /could not be confirmed/i,
      zh: /无法确认/,
      ja: /確認できません/,
      ko: /확인할 수 없습니다/,
      de: /konnte nicht bestätigt werden/i,
      fr: /impossible de confirmer/i,
      ar: /تعذّر تأكيد/u,
      es: /no se pudo confirmar/i,
      pt: /não foi possível confirmar/i,
    };
    // What to DO about it, and it has to be a real choice: try the code on the
    // other device, or make a new one. A line that only reports the doubt leaves
    // the user staring at six digits with nothing to try.
    const tryIt: Record<string, RegExp> = {
      en: /try/i, zh: /试/, ja: /試/, ko: /시도/,
      de: /ausprobieren|versuchen/i, fr: /essaye/i, ar: /جرّب/u, es: /prueb/i, pt: /tentar/i,
    };
    const makeNew: Record<string, RegExp> = {
      en: /new (pairing )?code/i, zh: /新的?配对码|重新生成/, ja: /新しいペアリングコード|新しいコード/, ko: /새 (페어링 )?코드/,
      de: /neuen (Pairing-)?Code/i, fr: /nouveau code/i, ar: /رمزًا جديدًا/u, es: /(código )?nuevo|uno nuevo/i, pt: /novo código/i,
    };
    for (const [lang, messages] of Object.entries(locales)) {
      const line = messages.pair.ttlUnknown;
      expect(line, `${lang}: ttlUnknown present`).toBeTruthy();
      expect(line, `${lang}: says the window could not be confirmed`).toMatch(cannotConfirm[lang]);
      // The whole point: there is no number, because there is none to know.
      expect(line, `${lang}: states no time it cannot know`).not.toMatch(/\d/);
      // And it is neither of the two claims it stands between.
      expect(line, `${lang}: is not the countdown`).not.toBe(messages.pair.expiresIn(""));
      expect(line, `${lang}: does not declare the code dead`).not.toBe(messages.pair.expired);
      expect(line, `${lang}: does not promise it stays valid`).not.toBe(messages.pair.ttlUploading);

      const note = messages.pair.ttlUnknownNote;
      expect(note, `${lang}: ttlUnknownNote present`).toBeTruthy();
      expect(note, `${lang}: offers trying the code that is on screen`).toMatch(tryIt[lang]);
      expect(note, `${lang}: offers making a new one`).toMatch(makeNew[lang]);
      expect(note, `${lang}: states no time it cannot know`).not.toMatch(/\d/);
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
      // Deliberately NOT "mentions the SAS": this step used to instruct the
      // reader to compare it, which is no longer what happens by default.
      expect(choose.how, `${lang}: no mandatory SAS instruction`)
        .not.toMatch(/Compare the SAS|核对 SAS|SAS を照合|SAS를 확인|Vergleicht den SAS|Comparez le SAS|قارن رمز SAS|Compara el SAS|Compare o SAS/);
      expect(choose.how, `${lang}: TURN`).toMatch(/TURN/i);
    }

    expect(en.howItWorks.realtime.ways[0].name).toBe("Create a pairing code");
    expect(en.howItWorks.realtime.ways[2].name).toBe("Choose files or text");
    expect(JSON.stringify(en.howItWorks.realtime.ways)).not.toMatch(
      /Pick files, get a code|Transfer starts on join|starts automatically/i,
    );
  });

  // The other side of this file's subject: where the code's deadline may NOT be
  // claimed. A receiver only reaches `storedRecv.errGone` after a handoff, which
  // means it JOINED — and §2 leaves a joined room no deadline, so the code
  // running out is the one thing that cannot have caused this. The server says
  // 404/410 and no more; a completion posted by another receiver, an operational
  // cleanup, a deleted account and a join race all arrive identically. Every
  // locale said "the pairing code expired" anyway, which reads as a fact and
  // sends the user to look at a countdown that was never involved.
  it("blames no deadline for stored files that are gone, and still offers the remedy", () => {
    // What the line may say: the files are not there, and were deleted before
    // they could be saved.
    const deleted: Record<string, RegExp> = {
      en: /no longer available|deleted/i,
      zh: /不存在|删除/,
      ja: /利用できません|削除/,
      ko: /더 이상 없습니다|삭제/,
      de: /nicht mehr verfügbar|gelöscht/i,
      fr: /ne sont plus disponibles|supprim/i,
      ar: /لم تعد|حُذفت/u,
      es: /ya no están disponibles|elimin/i,
      pt: /não estão mais disponíveis|exclu/i,
    };
    // What it must still say: this one is not retryable, so the copy is the only
    // thing standing between the user and a card with no way forward on it.
    const askForNew: Record<string, RegExp> = {
      en: /new code/i,
      zh: /新的配对码/,
      ja: /新しいペアリングコード/,
      ko: /새 코드/,
      de: /neuen Code/i,
      fr: /nouveau code/i,
      ar: /جديد/u,
      es: /código nuevo/i,
      pt: /código novo/i,
    };
    // And what it may not say, in each locale's own words for expiry.
    const blamesExpiry: Record<string, RegExp> = {
      en: /expir|ran out|timed out/i,
      zh: /过期|失效|到期|超时/,
      ja: /期限|失効|切れ/,
      ko: /만료|기한/,
      de: /abgelaufen|lief ab|Ablauf/i,
      fr: /expir/i,
      ar: /انتهت|صلاحية/u,
      es: /caduc|expir/i,
      pt: /expir|caduc/i,
    };
    for (const [lang, messages] of Object.entries(locales)) {
      const line = messages.storedRecv.errGone;
      expect(line, `${lang}: errGone present`).toBeTruthy();
      expect(line, `${lang}: says the content is gone`).toMatch(deleted[lang]);
      expect(line, `${lang}: sends the user to a new code`).toMatch(askForNew[lang]);
      expect(line, `${lang}: blames no expiry`).not.toMatch(blamesExpiry[lang]);
      // A duration here would be the same claim wearing a number.
      expect(line, `${lang}: states no time it cannot know`).not.toMatch(/\d/);
    }
  });
});

// ── the copy that lives outside the message catalogue ───────────────────────
//
// The tests above cover `messages`. But the same number is also written out by
// hand in the CLI page's sample output and in the static-page generator's prose,
// in every language at once — and that is exactly where the last TTL change was left
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
const SPELLED: Record<number, string[]> = { 5: ["five", "cinco", "cinq", "fünf", "خمس"], 30: ["thirty", "ثلاثين"] };

/** Every "<count> <minute-unit>" in a piece of source, across the nine locales. */
const DURATIONS = /(\d+|five|ten|fifteen|thirty|خمس|عشر|ثلاثين)[  ]?(minutes?|min\b|分钟|分間|分|분|Minuten?|minutos?|دقيقة|دقائق)/gu;

// Every file here states the pairing-code TTL and no other duration, so the
// rule can be absolute: each match must be the server's number.
const PAIRING_COPY = [
  // The /cli page's literal commands, including the `send` example that prints
  // "(valid 5 minutes)". They used to sit inline in CliPage.svelte; they moved
  // to cli-page-data.ts when the page was split into components, and this list
  // follows the copy rather than the file that used to hold it.
  "web/src/lib/cli-page-data.ts",
  // The shipped message tables. Two since the 2026-08-14 language freeze: the
  // seven archived tables under src/lib/i18n/archive/ are not bundled, not
  // loaded and not readable by any user, so a TTL change must not turn them red.
  // The generated page corpus below is still every language, because those
  // pages are public.
  ...["en", "zh"].map((l) => `web/src/lib/i18n/${l}.ts`),
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

// ── the format break, and the claims that must not survive it ───────────────
//
// The pairing code went from six characters over a 24-glyph alphabet to six
// decimal digits, and the SAS comparison went from a step everyone was walked
// through to an opt-in preference that is OFF by default. Both changes make
// previously-true sentences false, in every language at once, across a message
// catalogue, a static-page generator, hand-written articles and llms.txt.
//
// The TTL tests above exist because exactly that kind of change was left
// half-applied once already. These are the same guard for the other two values.

/** Every first-party English-or-mixed source that describes the pairing code. */
const CLAIM_SOURCES = [
  ...["en", "zh"].map((l) => `web/src/lib/i18n/${l}.ts`),
  "web/src/lib/CliPage.svelte",
  // Where /cli's literal commands live since the page was split; the `send`
  // example prints a pairing code, so it is a format-claim surface too.
  "web/src/lib/cli-page-data.ts",
  "web/public/llms.txt",
  "web/scripts/pages/content/cross-network.mjs",
  "web/scripts/pages/content/spa-pages.mjs",
  "web/scripts/pages/content/articles/cli-send-to-someone.mjs",
  "web/scripts/pages/content/articles/guides-receive-from-cli.mjs",
  "web/scripts/pages/content/articles/howto-transfer-by-qr-code.mjs",
  "web/scripts/pages/content/articles/howto-send-text-between-devices.mjs",
  "web/scripts/pages/content/articles/howto-send-files-between-computers.mjs",
  "README.md",
];

/** The alphabet the codes are actually drawn from, read from Go. */
function serverAlphabet(): string {
  const src = repoFile("server/internal/signal/pair.go");
  const m = /const CodeAlphabet = "([^"]+)"/.exec(src);
  expect(m, "CodeAlphabet must stay greppable — the copy tests read it").toBeTruthy();
  return m![1];
}

describe("pairing-code format claims", () => {
  it("is decimal digits on the server, so no locale may still describe an alphabet", () => {
    expect(serverAlphabet()).toBe("0123456789");
    // The exact literal, plus every phrasing the nine locales used for "we
    // removed the confusable glyphs". Each of these was true and is now false.
    const stale: [RegExp, string][] = [
      [/ACDEFHJKMNPRTWXY/, "names the retired alphabet"],
      [/6[- ]character|six[- ]character|6 characters|six characters/i, "counts characters, not digits"],
      [/6 字符|六个字符/, "counts characters, not digits (zh)"],
      [/6\s?文字/, "counts characters, not digits (ja)"],
      [/6자 (?:코드|페어링)|여섯 글자/, "counts characters, not digits (ko)"],
      [/6 Zeichen|sechs Zeichen/, "counts characters, not digits (de)"],
      [/6 caractères|six caractères/, "counts characters, not digits (fr)"],
      [/6 محارف|ستة محارف/, "counts characters, not digits (ar)"],
      [/6 caracteres|seis caracteres/, "counts characters, not digits (es/pt)"],
      [/no 0 (?:or|nor) 1|without 0 and 1|sans 0 ni 1|ohne 0 und 1|sin 0 ni 1|sem 0 nem 1|没有 0 和 1|0 と 1 を含まない|0과 1이 없/, "still promises 0 and 1 are excluded"],
    ];
    for (const path of CLAIM_SOURCES) {
      const source = repoFile(path);
      for (const [re, why] of stale) {
        expect(re.test(source), `${path}: ${why} — "${re.exec(source)?.[0]}"`).toBe(false);
      }
    }
  });

  it("never presents the SAS comparison as something that always happens", () => {
    // The instruction form specifically. Describing what the SAS detects is
    // fine and necessary; telling the reader they will be walked through
    // comparing it is not, because by default they will not be.
    const mandatory =
      /Compare the SAS, then|once both verification codes match|Both sides compare the same 6-digit SAS out of band\.|核对两边校验码一致|核对 SAS 后|SAS を照合後|SAS를 확인한 뒤|Vergleicht den SAS;|Comparez le SAS, puis|قارن رمز SAS، ثم|Compara el SAS y|Compare o SAS e/;
    for (const path of CLAIM_SOURCES) {
      const source = repoFile(path);
      const hit = mandatory.exec(source);
      expect(hit === null, `${path}: presents SAS comparison as a mandatory step — "${hit?.[0]}"`).toBe(true);
    }
  });

  it("keeps the default-off preference discoverable in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      expect(messages.verify.title, `${lang}: verify.title`).toBeTruthy();
      expect(messages.verify.toggle, `${lang}: verify.toggle`).toBeTruthy();
      // The two halves the copy has to carry: what it detects, and what it does
      // NOT change. Without the second, "verification: off" reads as
      // "encryption: off" — which is the misreading this whole change risks.
      expect(messages.verify.note, `${lang}: verify.note mentions SAS`).toMatch(/SAS/);
      expect(messages.verify.unaffected.length, `${lang}: verify.unaffected is substantive`)
        .toBeGreaterThan(60);
    }
  });

  // The workspace note is the one sentence rendered on a DEFAULT session, where
  // no code was ever shown. It used to call the link "verified" and tell the
  // reader they had compared a code — true only with the preference on.
  it("does not tell a default session it compared anything", () => {
    const claimsComparison =
      /this one verified connection|已验证的连接|検証済みの接続|검증된 이 연결|diese eine geprüfte Verbindung|cette seule connexion vérifiée|الاتصال المُوثَّق|esta única conexión verificada|esta única conexão verificada/;
    for (const [lang, messages] of Object.entries(locales)) {
      const note = messages.workspace.lanesNote;
      expect(note, `${lang}: lanesNote present`).toBeTruthy();
      expect(claimsComparison.test(note), `${lang}: lanesNote calls the link verified`).toBe(false);
      // "compare the code once" as an assertion of what happened, in the nine
      // locales' own words. Offering the comparison as optional is fine and is
      // deliberately NOT matched here.
      expect(
        /Compare the code once|校验码只需核对一次|確認コードの照合は一度だけ|확인 코드는 한 번만 대조|Der Code wird nur einmal verglichen|Le code ne se compare qu'une fois|يكفي مقارنة الرمز مرة واحدة|El código se compara una sola vez|O código é comparado uma só vez/.test(note),
        `${lang}: lanesNote states a comparison happened`,
      ).toBe(false);
    }
  });
});

// ── the wider surface: security prose, guides and the protocol docs ─────────
//
// The catalogue is only part of what a reader trusts. The security page, the
// encryption guide, the landing copy and the protocol specs make the same
// claims in longer form, and they are the ones an auditor quotes. Nothing below
// forbids describing the SAS, or recommending it — only asserting that it
// always happens, or that bytes wait for it.

const SECURITY_CLAIM_SOURCES = [
  ...CLAIM_SOURCES,
  "web/scripts/pages/content/legal/security.mjs",
  "web/scripts/pages/content/landing.mjs",
  "web/scripts/pages/content/articles/guides-how-encryption-works.mjs",
  "web/scripts/pages/content/articles/guides-is-it-safe.mjs",
  "web/scripts/pages/content/articles/cli-getting-started.mjs",
  "docs/protocol/relayium-text-v1.md",
  "docs/protocol/relayium-handshake-v1.md",
  "docs/protocol/relayium-realtime-wire-v1.md",
];

describe("SAS is described as optional, everywhere it is described", () => {
  it("never says bytes wait for a comparison", () => {
    // Narrow on purpose: each of these asserts a gate that does not exist by
    // default. "Comparing it detects X" and "add --verify to stop for it" are
    // truthful and must keep passing.
    const gated: [RegExp, string][] = [
      [/before any bytes move/gi, "makes the SAS a precondition for transfer"],
      [/only (?:once|after) (?:the |both )?(?:codes?|SAS|verification codes?) (?:match|are compared)/gi, "gates the transfer on a comparison"],
      [/传输.{0,6}(?:要|需)(?:先|等).{0,10}核对.{0,6}(?:校验码|SAS)/g, "gates the transfer on a comparison (zh)"],
      [/照合(?:して|した)(?:から|後に).{0,8}(?:転送|送信)が(?:始|開始)/g, "gates the transfer on a comparison (ja)"],
    ];
    // The same words are TRUE when they describe what --verify does, because
    // --verify really does stop before any bytes move. So a hit is only a
    // failure when its own sentence never opts in.
    const optsIn = /--verify|advanced verification|高级验证|高度な検証|고급 검증|erweiterte[nr]? Verifizierung|vérification avancée|التحقّق المتقدّم|verificación avanzada|verificação avançada/i;
    for (const path of SECURITY_CLAIM_SOURCES) {
      const source = repoFile(path);
      for (const [re, why] of gated) {
        for (const hit of source.matchAll(re)) {
          const around = source.slice(Math.max(0, hit.index! - 220), hit.index! + hit[0].length + 60);
          expect(optsIn.test(around), `${path}: ${why} — "${hit[0]}"`).toBe(true);
        }
      }
    }
  });

  // The security page is the document that has to be exactly right, so it gets
  // a positive check as well: it must still say the preference exists and that
  // turning it off changes nothing about the encryption.
  it("keeps the security page honest in both directions", () => {
    const src = repoFile("web/scripts/pages/content/legal/security.mjs");
    expect(src, "names the preference").toMatch(/advanced verification/i);
    expect(src, "says it is off by default").toMatch(/off by default/i);
    expect(src, "keeps commit-then-reveal unconditional").toMatch(/commit-then-reveal handshake below still runs on every connection/i);
    expect(src, "keeps the file-receive prompt").toMatch(/receiving files still asks you before anything is saved/i);
    // And it must not have drifted back to asserting the code is always shown.
    expect(/derives a 6-digit Short Authentication String \(SAS\) from both sides' public keys and shows it on both screens/.test(src),
      "claims the SAS is always shown").toBe(false);
  });
});

// ── CLI text verification is opt-in, and --yes is compatibility ─────────────
//
// `relayium text` used to prompt by default and refuse a pipe without --yes.
// Both halves of that are gone; the docs that still described them were the
// bug this guards. --yes must keep being documented (scripts pass it), just
// never as something a plain run needs.

const CLI_TEXT_DOCS = [
  "web/src/lib/CliPage.svelte",
  ...["en", "zh"].map((l) => `web/src/lib/i18n/${l}.ts`),
  "web/scripts/pages/content/articles/howto-send-text-between-devices.mjs",
  "README.md",
  "docs/TESTING.md",
  "docs/protocol/relayium-text-v1.md",
];

describe("`relayium text` verification is opt-in in the docs", () => {
  it("never presents --yes as required for a plain run", () => {
    const required: [RegExp, string][] = [
      [/pass --yes because/i, "tells the reader a pipe needs --yes"],
      [/(?:requires?|needs?|must pass|have to pass) --yes/i, "calls --yes required"],
      [/--yes is required/i, "calls --yes required"],
      [/必须.{0,8}--yes/, "calls --yes required (zh)"],
      [/--yes を(?:付けます|渡します|指定します)/, "calls --yes required (ja)"],
      [/--yes를 붙입니다/, "calls --yes required (ko)"],
      [/braucht --yes/, "calls --yes required (de)"],
      [/avec --yes, car/, "calls --yes required (fr)"],
      [/مع --yes لأن/u, "calls --yes required (ar)"],
      [/con --yes, porque/, "calls --yes required (es)"],
      [/com --yes, pois/, "calls --yes required (pt)"],
      // The old default, stated the other way round.
      [/prompts by default and --yes opts out/i, "describes the retired default"],
    ];
    for (const path of CLI_TEXT_DOCS) {
      const source = repoFile(path);
      for (const [re, why] of required) {
        expect(re.test(source), `${path}: ${why} — "${re.exec(source)?.[0]}"`).toBe(false);
      }
    }
  });

  it("still documents --verify as the way in, and --yes as compatibility", () => {
    // en.ts carries the prose; the literal flag names live in cli-page-data.ts,
    // which is what the CLI page renders next to it.
    expect(repoFile("web/src/lib/i18n/en.ts"), "en prose names --verify").toMatch(/--verify/);
    expect(repoFile("web/src/lib/cli-page-data.ts"), "the flag table keeps --yes").toMatch(/--yes/);
    for (const path of ["README.md", "docs/protocol/relayium-text-v1.md", "docs/TESTING.md"]) {
      const source = repoFile(path);
      expect(source, `${path}: names --verify`).toMatch(/--verify/);
      expect(source, `${path}: still names --yes`).toMatch(/--yes/);
    }
  });
});

// ── the text protocol's ACCEPT frame ────────────────────────────────────────
//
// ACCEPT is now an activation signal a default client sends automatically. The
// wire invariant around it is unchanged and is the part that must not be
// "simplified" away when someone rewrites the prose again.

describe("text protocol docs describe activation, not consent", () => {
  it("says ACCEPT may be automatic and is not proof a human approved", () => {
    const doc = repoFile("docs/protocol/relayium-text-v1.md");
    expect(doc, "calls it activation").toMatch(/activation handshake/i);
    expect(doc, "says a default client sends it automatically").toMatch(/automatically/i);
    // Whitespace-tolerant: the doc is hard-wrapped prose, so an edit that only
    // moves a line break must not read as the invariant being deleted.
    expect(doc, "warns against reading it as approval").toMatch(/MUST NOT read a received\s+ACCEPT/i);
    expect(/sent once when the user accepts/.test(doc), "still describes ACCEPT as a human accept").toBe(false);
  });

  it("keeps the handler-before-ACCEPT ordering invariant in both docs", () => {
    const text = repoFile("docs/protocol/relayium-text-v1.md");
    expect(text, "attach before ACCEPT").toMatch(/MUST attach it \*\*before\*\* sending ACCEPT/);
    expect(text, "no content before ACCEPT").toMatch(/may not send a message frame before receiving it/);
    const wire = repoFile("docs/protocol/relayium-realtime-wire-v1.md");
    expect(wire, "wire doc restates the ordering").toMatch(/attach the receive handler BEFORE sending ACCEPT/);
    expect(wire, "wire doc keeps the no-content rule").toMatch(/send no content before it/);
  });
});
