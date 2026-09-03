import { describe, expect, it } from "vitest";
import { LANGS, MAINTAINED_LANGS } from "../../shared.mjs";
import privacy from "./privacy.mjs";
import security from "./security.mjs";
import terms from "./terms.mjs";

const TEXT_WORD = {
  en: /text/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /text/i,
  fr: /texte/i,
  ar: /نص/,
  es: /texto/i,
  pt: /texto/i,
};

const ONLINE_WORD = {
  en: /online/i,
  zh: /在线/,
  ja: /オンライン/,
  ko: /온라인/,
  de: /online/i,
  fr: /ligne/i,
  ar: /متصل|اتصال الطرفين/,
  es: /línea|conectad/i,
  pt: /on-?line/i,
};

// The exact phrase each FROZEN terms translation still uses for the party that
// encrypts a stored file. Held as literals rather than as a "does it mention a
// browser" pattern, because the point is byte-stability of an archived
// translation, not its meaning.
const FROZEN_STORED_ENCRYPTOR = {
  ja: "ブラウザがアップロード前にファイルを暗号化し",
  ko: "브라우저가 업로드 전에 파일을 암호화하고",
  de: "verschlüsselt Ihr Browser die Dateien vor dem Hochladen",
  fr: "votre navigateur chiffre les fichiers avant l'envoi",
  ar: "يُشفِّر متصفحك الملفات قبل الرفع",
  es: "tu navegador cifra los archivos antes de subirlos",
  pt: "seu navegador criptografa os arquivos antes do envio",
};

const blob = (doc, lang) => JSON.stringify(doc.langs[lang]);
const sectionBlob = (doc, lang, index) => JSON.stringify(doc.langs[lang].sections[index]);

describe("legal pages describe temporary text accurately", () => {
  for (const lang of LANGS) {
    it(`privacy.${lang} covers text paths, account roles, and retention`, () => {
      const all = blob(privacy, lang);
      const account = sectionBlob(privacy, lang, 1);
      const relay = sectionBlob(privacy, lang, 4);
      // Section 5 answers the app privacy manifest's Other Usage Data entry:
      // byte counters kept per account for a quota, and not analytics.
      const metering = sectionBlob(privacy, lang, 5);

      // The maintained pair moved again on 2026-09-03, when the native-app
      // section stopped being macOS-only and started describing the iOS binary
      // under App Store review as well — App Review reads this URL, and
      // Guideline 5.1.1 asks the linked policy to describe the app it is linked
      // from. The 2026-08-30 aggregate disclosure and the earlier native-app
      // correction remain in the same maintained copy. The seven frozen
      // translations are archived at the 2026-08-14 language freeze and keep the
      // date their prose was last actually true for.
      expect(privacy.langs[lang].updated).toBe(
        MAINTAINED_LANGS.includes(lang) ? "2026-09-03" : "2026-08-13",
      );
      expect(all).toMatch(TEXT_WORD[lang]);
      expect(all).toMatch(ONLINE_WORD[lang]);
      expect(account).toMatch(/account|账号|アカウント|계정|Konto|compte|حساب|cuenta|conta/i);
      expect(account).toMatch(/code|配对码|コード|코드|Code|código|رمز/i);
      expect(relay).toContain("TURN");
      expect(relay).toContain("CLI");
      expect(relay).toMatch(/byte|字节|バイト|바이트|octet|بايت/i);
      expect(metering).toMatch(/byte|字节|バイト|바이트|octet|بايت/i);
      expect(metering).toMatch(/quota|配额|クォータ|할당량|Kontingent|حصة|cuota|cota/i);
      expect(metering).toMatch(/analytic|analítica|análise|analyse|分析|분석|تحليلات/i);
    });

    it(`terms.${lang} keeps live text separate from stored files`, () => {
      const all = blob(terms, lang);
      const liveText = terms.langs[lang].sections.find((section) =>
        TEXT_WORD[lang].test(section.heading),
      );
      const stored = terms.langs[lang].sections.find((section) =>
        /Stored content|暂存内容|保存コンテンツ|임시 보관 콘텐츠|Zwischengespeicherte Inhalte|Contenu stocké|المحتوى المُخزَّن|Contenido almacenado|Conteúdo armazenado/i.test(
          section.heading,
        ),
      );

      // The maintained pair moved on 2026-09-03, when "Stored content" stopped
      // saying that the BROWSER encrypts — see the note in terms.mjs and the
      // stored-encryption guard below. The frozen seven keep the date their
      // prose was last actually true for.
      expect(terms.langs[lang].updated).toBe(
        MAINTAINED_LANGS.includes(lang) ? "2026-09-03" : "2026-08-13",
      );
      expect(all).toMatch(TEXT_WORD[lang]);
      expect(liveText, `terms.${lang}.liveText`).toBeDefined();
      expect(JSON.stringify(liveText)).toMatch(ONLINE_WORD[lang]);
      expect(JSON.stringify(liveText)).toContain("TURN");
      expect(JSON.stringify(stored), `terms.${lang}.stored`).toMatch(
        /file|文件|ファイル|파일|Datei|fichier|ملف|archivo|arquivo/i,
      );
    });

    // Who encrypts a stored file, and which locales are allowed to answer.
    //
    // The clause said "your browser encrypts files before upload". That was
    // written when a browser was the only client that could create a stored
    // link, and it stopped being the whole truth as the CLI, the macOS app and
    // the iOS app each gained the same flow — every one of them encrypting
    // locally with a key the server never sees. A term that governs all stored
    // transfers while naming one client tells a CLI user that the promise
    // covers software they are not running.
    //
    // Both halves are pinned here, because they pull against each other:
    //
    //   1. Maintained en/zh state WHERE the encryption happens — on the user's
    //      own device — and name no client. Naming one is what went wrong, so
    //      the replacement may not name a different one either: "our apps
    //      encrypt" would be the same defect pointed at iOS, and would imply an
    //      app is available to a reader on a platform where none is.
    //   2. The seven frozen translations keep their original sentence, browser
    //      and all. They are archived under the 2026-08-14 language freeze and
    //      are corrected by retranslation if a locale is ever restored, never by
    //      an editor reaching into a language they do not maintain. Each is
    //      pinned by the exact phrase it still carries, so "fixing" one fails
    //      here rather than passing quietly.
    it(`terms.${lang} attributes stored encryption to the right place`, () => {
      const stored = JSON.stringify(
        terms.langs[lang].sections.find((section) =>
          /Stored content|暂存内容|保存コンテンツ|임시 보관 콘텐츠|Zwischengespeicherte Inhalte|Contenu stocké|المحتوى المُخزَّن|Contenido almacenado|Conteúdo armazenado/i.test(
            section.heading,
          ),
        ),
      );

      if (MAINTAINED_LANGS.includes(lang)) {
        expect(stored, `terms.${lang} still names a client as the encryptor`).not.toMatch(
          /browser|浏览器|app\b|应用|客户端/i,
        );
        expect(stored, `terms.${lang} no longer says where a stored file is encrypted`).toMatch(
          lang === "en" ? /encrypted on your own device/ : /在你自己的设备本机加密/,
        );
      } else {
        expect(stored, `terms.${lang} is frozen and was edited`).toContain(
          FROZEN_STORED_ENCRYPTOR[lang],
        );
      }
    });

    it(`security.${lang} distinguishes browser and CLI text security`, () => {
      const all = blob(security, lang);
      const browserCrypto = sectionBlob(security, lang, 0);
      const sas = sectionBlob(security, lang, 1);
      const plaintext = security.langs[lang].sections[2];
      const relay = sectionBlob(security, lang, 3);
      const textSection = security.langs[lang].sections.find((section) =>
        JSON.stringify(section).includes("UTF-8"),
      );
      const text = JSON.stringify(textSection);
      const limits = sectionBlob(security, lang, 7);

      // Bumped when the SAS section stopped describing the code as something
      // both screens always show: advanced verification is off by default.
      expect(security.langs[lang].updated).toBe("2026-08-02");
      for (const token of ["X25519", "AES-256-GCM", "CLI"]) {
        expect(browserCrypto, `security.${lang}.browserCrypto.${token}`).toContain(token);
      }
      expect(browserCrypto).toMatch(/TLS[ -]1\.3/);
      expect(sas).toContain("SAS");
      expect(sas).toContain("CLI");
      expect(plaintext.bullets).toHaveLength(4);
      expect(JSON.stringify(plaintext)).toMatch(TEXT_WORD[lang]);
      expect(relay).toContain("TURN");
      expect(relay).toContain("CLI");
      expect(relay).toMatch(TEXT_WORD[lang]);
      expect(textSection, `security.${lang}.textSection`).toBeDefined();
      for (const token of ["X25519", "AES-256-GCM", "UTF-8", "TURN", "CLI", "TLS 1.3", "SAS"]) {
        expect(text, `security.${lang}.${token}`).toContain(token);
      }
      expect(text).toMatch(ONLINE_WORD[lang]);
      expect(limits).toMatch(/message|消息|メッセージ|메시지|Nachricht|رسائل|mensajes|mensagens/i);
      expect(all).toMatch(/metadata|元数据|メタデータ|메타데이터|Metadaten|métadonnées|وصفية|metadatos|metadados/i);
    });
  }

  it("does not restore known overbroad English claims", () => {
    const all = [privacy, terms, security].map((doc) => blob(doc, "en")).join("\n");
    expect(all).not.toContain("realtime direct transfers go peer-to-peer and never touch our servers");
    expect(all).not.toContain("The service is designed so that the following never reach our servers, in any mode");
    expect(all).not.toContain("Sending across networks with a pairing code requires the sender to sign in");
  });
});
