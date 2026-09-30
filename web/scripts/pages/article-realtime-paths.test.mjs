import { describe, expect, it } from "vitest";
import { LANGS, MAINTAINED_LANGS } from "./shared.mjs";
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

// The archived "the CLI is direct-only" sentence, per frozen locale. It was
// kept byte-stable until 2026-09-30, when the pairing-code sessions began to
// relay; it is now false of every locale, so the seven archived leads carry a
// translated erratum instead (DECISION-LOG 2026-09-30 item 2) and none may
// say it. `relayium up` and `relayium down` were already hosted-storage modes.
const CLI_DIRECT_ONLY = {
  ja: /CLI.*直接接続専用/,
  ko: /CLI.*직접 연결 전용/,
  de: /CLI.*direct-only/i,
  fr: /CLI.*direct-only/i,
  ar: /CLI.*مباشرة فقط/u,
  es: /CLI.*direct-only/i,
  pt: /CLI.*direct-only/i,
};
// What the archived leads say instead: the CLI splits into direct
// server-to-server modes and pairing-code sessions that relay when issued.
const CLI_SPLIT_FROZEN = {
  ja: /CLI は2つに分かれます。サーバー間モード（serve と push または sync）は直結でリレーを使わず、ペアリングコードによるセッション（send \/ receive、text、pair）はサーバーがそのコードに暗号化 TURN リレーを発行した場合はそれを通ります/,
  ko: /CLI는 둘로 나뉩니다\. 서버 간 모드\(serve와 push 또는 sync\)는 직접 연결이며 릴레이를 쓰지 않고, 페어링 코드 세션\(send \/ receive, text, pair\)은 서버가 해당 코드에 암호화된 TURN 릴레이를 발급하면/,
  de: /die CLI teilt sich in zwei: Ihre Server-zu-Server-Modi \(serve mit push oder sync\) sind direkt[^.]*Pairing-Code-Sitzungen \(send \/ receive, text und pair\) laufen über ein verschlüsseltes TURN-Relay/,
  fr: /le CLI se divise en deux\u00a0: ses modes de serveur à serveur \(serve avec push ou sync\) sont directs[^.]*sessions à code d'appairage \(send \/ receive, text et pair\) passent par un relais TURN chiffré/,
  ar: /وينقسم CLI إلى قسمين: أوضاعه بين الخوادم \(serve مع push أو sync\) مباشرة[^.]*جلسات رمز الاقتران فيه \(send \/ receive وtext وpair\) فتمر عبر مُرحِّل TURN مُشفَّر/u,
  es: /el CLI se divide en dos: sus modos de servidor a servidor \(serve con push o sync\) son directos[^.]*sesiones con código de emparejamiento \(send \/ receive, text y pair\) pasan por un retransmisor TURN cifrado/,
  pt: /a CLI se divide em duas: os modos de servidor para servidor \(serve com push ou sync\) são diretos[^.]*sessões com código de pareamento \(send \/ receive, text e pair\) passam por um retransmissor TURN criptografado/,
};
// What the maintained lead must say instead: which modes are direct. Only the
// server-to-server modes are (2026-09-30, help.go linkRelayPolicy): the
// pairing-code sessions relay whenever the server issues a relay.
const CLI_DIRECT_MODES = {
  en: /server-to-server modes — serve with push or sync — are direct and never relayed, while its pairing-code sessions — send \/ receive, text and pair — go through an encrypted TURN relay whenever the server issues one/i,
  zh: /服务器对服务器模式——serve 配合 push 或 sync——是直连，从不走中继；配对码会话——send \/ receive、text 和 pair——只要服务器为这个码签发了加密 TURN 中继，就经它传输/,
};
// …and what it may not say: that the CLI as a whole is direct.
const CLI_WHOLE_IS_DIRECT = {
  en: /\bCLI\b[^.]{0,40}\b(?:is|remains|stays)\b[^.]{0,25}direct[- ]only/i,
  zh: /CLI[^。]{0,20}仅直连/,
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

  it("separates generic TURN fallback from Relayium's deliberate routes and the direct CLI modes", () => {
    const maintained = new Set(MAINTAINED_LANGS);
    for (const lang of LANGS) {
      const copy = text(p2pGuide.langs[lang]);
      if (maintained.has(lang)) {
        expect(copy, `p2p-guide [${lang}] must name which CLI modes are direct`).toMatch(
          CLI_DIRECT_MODES[lang],
        );
        expect(copy, `p2p-guide [${lang}] must not call the whole CLI direct-only`).not.toMatch(
          CLI_WHOLE_IS_DIRECT[lang],
        );
      } else {
        expect(copy, `p2p-guide [${lang}] archived lead still calls the CLI direct-only`).not.toMatch(CLI_DIRECT_ONLY[lang]);
        expect(copy, `p2p-guide [${lang}] archived lead lost the corrected CLI split`).toMatch(CLI_SPLIT_FROZEN[lang]);
      }
    }

    const turnExplanation = p2pGuide.langs.en.sections[2].body[1];
    expect(turnExplanation).toMatch(/general WebRTC\/ICE design/i);
    expect(turnExplanation).toMatch(/cross-network session uses TURN from the start/i);
    expect(turnExplanation).toMatch(/cannot read or decrypt/i);
    expect(p2pGuide.langs.en.cta.text).not.toMatch(/direct connection/i);
  });
});
