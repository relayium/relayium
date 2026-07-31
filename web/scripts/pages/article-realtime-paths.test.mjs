import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import expiringLink from "./content/articles/howto-share-file-expiring-link.mjs";
import folder from "./content/articles/howto-send-a-folder.mjs";
import largeFiles from "./content/articles/howto-large-files-without-cloud.mjs";
import p2pGuide from "./content/articles/guides-what-is-p2p-file-transfer.mjs";
import safetyGuide from "./content/articles/guides-is-it-safe.mjs";

const ARTICLES = {
  "expiring-link": expiringLink,
  folder,
  "large-files": largeFiles,
  "p2p-guide": p2pGuide,
  safety: safetyGuide,
};

function shape(value) {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
  return typeof value;
}

function text(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(text).join(" ");
  return "";
}

const CIPHERTEXT = {
  en: /ciphertext/i,
  zh: /密文/,
  ja: /暗号文/,
  ko: /암호문/,
  de: /Chiffretext/i,
  fr: /texte chiffré/i,
  ar: /نص(?:ًا)? مشف/u,
  es: /texto cifrado/i,
  pt: /texto cifrado/i,
};

const LAN_SCOPE = {
  en: /LAN/i,
  zh: /局域网/,
  ja: /LAN/i,
  ko: /LAN/i,
  de: /LAN/i,
  fr: /LAN/i,
  ar: /LAN/i,
  es: /LAN/i,
  pt: /LAN/i,
};

const CANNOT_READ_OR_DECRYPT = {
  en: /cannot (?:read or decrypt|read, decrypt)/i,
  zh: /无法读取或解密/,
  ja: /読み取りも復号もでき/,
  ko: /읽거나 복호화할 수 없/,
  de: /weder lesen noch entschlüsseln/i,
  fr: /ni lire ni déchiffrer/i,
  ar: /لا يستطيع .*قراءته.*فك تشفيره/u,
  es: /no puede leer ni descifrar/i,
  pt: /não consegue ler nem descriptografar/i,
};

const NO_REALTIME_RETENTION = {
  en: /(?:no server-side (?:realtime )?copy|no .*realtime history|stores? no realtime content)/i,
  zh: /(?:不保留服务器端(?:实时)?副本|不存储实时内容|服务器端内容副本)/,
  ja: /(?:サーバー側の(?:リアルタイム)?コピー|リアルタイム内容).*(?:保持しません|残りません|残しません)/,
  ko: /(?:서버 측 (?:실시간 )?복사본|실시간 내용).*(?:보관하지|남지|저장하지)/,
  de: /(?:keine serverseitige (?:Echtzeit)?kopie|keine Echtzeitinhalte|keine .*Echtzeithistorie)/i,
  fr: /(?:aucune copie côté serveur|aucun contenu ni historique temps réel|aucune copie de contenu)/i,
  ar: /(?:لا يحتفظ .*بنسخة .*على الخادم|لا يخزن .*محتوى فوري|لا تبقى نسخة محتوى)/u,
  es: /(?:no conserva copia (?:del lado del servidor|de contenido)|no almacena contenido ni historial|no queda copia de contenido)/i,
  pt: /(?:não mantém cópia (?:no servidor|de conteúdo)|não armazena conteúdo nem histórico|não fica cópia de conteúdo)/i,
};

const CLI_DIRECT_ONLY = {
  en: /CLI (?:remains|is).*direct-only/i,
  zh: /CLI.*仅直连/,
  ja: /CLI.*直接接続専用/,
  ko: /CLI.*직접 연결 전용/,
  de: /CLI.*direct-only/i,
  fr: /CLI.*direct-only/i,
  ar: /CLI.*مباشرة فقط/u,
  es: /CLI.*direct-only/i,
  pt: /CLI.*direct-only/i,
};

describe("article realtime path claims", () => {
  it("keeps all nine locales structurally aligned with English", () => {
    for (const [name, article] of Object.entries(ARTICLES))
      for (const lang of LANGS)
        expect(shape(article.langs[lang]), `${name} [${lang}]`).toEqual(shape(article.langs.en));
  });

  it("states the LAN, TURN, ciphertext, decryptability, and retention boundaries in every locale", () => {
    for (const [name, article] of Object.entries(ARTICLES))
      for (const lang of LANGS) {
        const copy = text(article.langs[lang]);
        expect(copy, `${name} [${lang}] must scope direct WebRTC to LAN`).toMatch(LAN_SCOPE[lang]);
        expect(copy, `${name} [${lang}] must name TURN for cross-network browser sessions`).toMatch(/TURN/i);
        expect(copy, `${name} [${lang}] must say the relay carries ciphertext`).toMatch(CIPHERTEXT[lang]);
        expect(copy, `${name} [${lang}] must say the relay cannot read or decrypt`).toMatch(
          CANNOT_READ_OR_DECRYPT[lang],
        );
        expect(copy, `${name} [${lang}] must deny server-side realtime retention`).toMatch(
          NO_REALTIME_RETENTION[lang],
        );
      }
  });

  it("does not reintroduce the shipped English direct-only browser wording", () => {
    const copy = Object.values(ARTICLES)
      .map((article) => text(article.langs.en))
      .join(" ");

    expect(copy).not.toMatch(/streams? (?:a file )?directly between (?:the )?two (?:open )?browser/i);
    expect(copy).not.toMatch(/never lands on a server in between/i);
    expect(copy).not.toMatch(/realtime direct transfer/i);
    expect(copy).not.toMatch(/multi-gigabyte file the direct way/i);
  });

  it("separates generic TURN fallback from Relayium's deliberate routes and direct-only CLI", () => {
    for (const lang of LANGS) {
      const copy = text(p2pGuide.langs[lang]);
      expect(copy, `p2p-guide [${lang}] must describe the CLI as direct-only`).toMatch(
        CLI_DIRECT_ONLY[lang],
      );
    }

    const turnExplanation = p2pGuide.langs.en.sections[2].body[1];
    expect(turnExplanation).toMatch(/general WebRTC\/ICE design/i);
    expect(turnExplanation).toMatch(/cross-network session uses TURN from the start/i);
    expect(turnExplanation).toMatch(/cannot read or decrypt/i);
    expect(p2pGuide.langs.en.cta.text).not.toMatch(/direct connection/i);
  });
});
