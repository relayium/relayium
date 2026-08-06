import { describe, expect, it } from "vitest";
import article from "./content/articles/guides-self-host.mjs";
import { LANGS } from "./shared.mjs";

const NO_LOGIN = {
  en: /no login/i,
  zh: /无需登录/,
  ja: /ログイン不要/,
  ko: /로그인이 필요 없/,
  de: /keine Anmeldung/i,
  fr: /aucune connexion/i,
  ar: /لا تحتاج إلى تسجيل دخول/,
  es: /no (?:necesitan|requieren) iniciar sesión/i,
  pt: /não (?:precisam de|exigem) login/i,
};

const NO_SERVER_HISTORY = {
  en: /Neither Relayium nor your self-hosted server stores message bodies or server-side history/i,
  zh: /不保存消息正文或服务端历史/,
  ja: /メッセージ本文やサーバー側の履歴を保存しません/,
  ko: /메시지 본문이나 서버 측 기록을 저장하지 않/,
  de: /Weder Relayium noch dein selbst gehosteter Server speichern Nachrichteninhalte oder einen serverseitigen Verlauf/i,
  fr: /Ni Relayium ni votre serveur auto-hébergé ne stockent le corps des messages ou un historique côté serveur/i,
  ar: /لا تخزّن Relayium ولا خادمك المستضاف ذاتيًا متون الرسائل أو سجلًا على الخادم/,
  es: /Ni Relayium ni tu servidor autoalojado guardan el cuerpo de los mensajes ni un historial del servidor/i,
  pt: /Nem o Relayium nem o servidor auto-hospedado armazenam o corpo das mensagens ou um histórico no servidor/i,
};

const ENDPOINT_CAN_RETAIN = {
  en: /terminal or recipient can copy or retain/i,
  zh: /终端或接收方都可以.*复制或留存/,
  ja: /端末または受信者も.*コピーまたは保持/,
  ko: /터미널이나 수신자든.*복사하거나 보관/,
  de: /Terminals beziehungsweise der Empfänger können.*kopieren oder aufbewahren/i,
  fr: /terminal ou destinataire peut copier ou conserver/i,
  ar: /طرفية أو مستلم نسخ النص أو الاحتفاظ به/,
  es: /terminales o el destinatario puede copiar o conservar/i,
  pt: /terminal ou destinatário pode copiar ou guardar/i,
};

const OLD_ABSOLUTE = {
  en: /messages?.*never stored/i,
  zh: /消息.*绝不存储/,
  ja: /メッセージ.*保存されません/,
  ko: /메시지.*저장되지 않습니다/,
  de: /Nachrichten.*nie gespeichert/i,
  fr: /messages.*jamais stockés/i,
  ar: /الرسائل.*لا تُخزَّن أبدًا/,
  es: /mensajes.*nunca se almacenan/i,
  pt: /mensagens.*nunca são armazenadas/i,
};

const ONLINE = {
  en: /stay online/i,
  zh: /同时在线/,
  ja: /同時にオンライン/,
  ko: /동시에 온라인/,
  de: /gleichzeitig online/i,
  fr: /rester en ligne/i,
  ar: /متصلين/,
  es: /permanecer en línea/i,
  pt: /permanecer online/i,
};

const NO_TURN = {
  en: /does not use/i,
  zh: /不使用/,
  ja: /使いません/,
  ko: /사용하지 않습니다/,
  de: /nutzt nicht/i,
  fr: /n'utilise pas/i,
  ar: /لا يستخدم/,
  es: /no usa/i,
  pt: /não usa/i,
};

const TEXT_WORD = {
  en: /\btext\b/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /Text/,
  fr: /texte/i,
  ar: /(?<!م)نص/,
  es: /texto/i,
  pt: /texto/i,
};

const SELF_HOST_PRIVACY = {
  en: /ciphertext bytes.*signaling metadata.*neither can read or decrypt file plaintext.*server-side copy or history/i,
  zh: /密文字节.*信令元数据.*无法读取或解密文件明文.*服务端副本或历史/,
  ja: /暗号文のバイト.*シグナリングのメタデータ.*平文を読んだり復号.*サーバー側コピーや履歴/,
  ko: /암호문 바이트.*시그널링 메타데이터.*파일 평문을 읽거나 복호화.*서버 측 사본이나 기록/,
  de: /verschlüsselte Bytes.*Signalisierungsmetadaten.*Dateiklartext weder lesen noch entschlüsseln.*serverseitige Kopie oder Historie/i,
  fr: /octets chiffrés.*métadonnées de signalisation.*lire ni déchiffrer.*copie ou d'historique côté serveur/i,
  ar: /بايتات مشفَّرة.*بيانات الإشارة الوصفية.*قراءة النص الصريح للملف أو فك تشفيره.*نسخة أو سجلًا على الخادم/,
  es: /bytes cifrados.*metadatos de señalización.*leer ni descifrar el texto en claro.*copia o historial.*en el servidor/i,
  pt: /bytes cifrados.*metadados de sinalização.*ler ou descriptografar o texto simples.*cópia ou histórico.*no servidor/i,
};

/**
 * Every command a section renders, wherever it is attached.
 *
 * The two text commands used to sit in the section's own `code` array. They now
 * hang off the numbered steps that run them, which is the point of the tutorial
 * structure — a command belongs to its step, not to the section at large. What
 * this file pins is that both commands are on the page and copy-ready, and that
 * is unchanged; only where they live moved, so the locator follows them rather
 * than the assertion being dropped.
 */
const sectionCode = (s) => [
  ...(s.code || []),
  ...(s.steps || []).flatMap((step) => step.code || []),
  ...(s.success?.code || []),
  ...(s.troubleshooting?.items || []).flatMap((i) => i.code || []),
];

describe("self-hosting guide documents CLI text against a custom server", () => {
  for (const lang of LANGS) {
    it(`${lang}: gives both copy-ready text commands and preserves the protocol facts`, () => {
      const doc = article.langs[lang];
      expect(doc.title).toMatch(TEXT_WORD[lang]);
      expect(doc.description).toMatch(TEXT_WORD[lang]);
      const section = doc.sections.find((candidate) =>
        sectionCode(candidate).includes("relayium text --server https://your-domain"),
      );
      expect(section, `${lang} has no self-hosted text section`).toBeTruthy();
      expect(sectionCode(section)).toContain("relayium text 483920 --server https://your-domain");

      const prose = [...section.body, ...section.bullets].join(" ");
      expect(prose).toContain("relayium login --server https://your-domain");
      expect(prose).toMatch(/P2P|peer-to-peer/i);
      expect(prose).toContain("TURN");
      expect(prose).toMatch(NO_LOGIN[lang]);
      expect(prose).toMatch(NO_SERVER_HISTORY[lang]);
      expect(prose).toMatch(ENDPOINT_CAN_RETAIN[lang]);
      expect(prose).not.toMatch(OLD_ABSOLUTE[lang]);
      expect(prose).toMatch(ONLINE[lang]);
      expect(prose).toMatch(NO_TURN[lang]);

      const faq = doc.faq.items.map((item) => item.a).join(" ");
      expect(faq).toContain("text");
      expect(faq).toMatch(NO_LOGIN[lang]);

      const storageFaq = doc.faq.items.find((item) => item.a.includes("RELAYIUM_BLOB_DIR"));
      expect(storageFaq, `${lang} has no self-hosted data-storage FAQ`).toBeTruthy();
      expect(storageFaq.a).toMatch(
        /endpoint|接收端|受信端末|수신 기기|Empfangsgeräte|appareils destinataires|طرف المستلم|dispositivos receptores|destinatários/i,
      );
      expect(storageFaq.a).not.toMatch(
        /anywhere|任何地方|どこにも|어디에도|nirgendwo|nulle part|في أي مكان|ningún sitio|lugar nenhum/i,
      );

      const whySelfHost = doc.sections[0].body.join(" ");
      expect(whySelfHost).toContain("TURN");
      expect(whySelfHost).toMatch(SELF_HOST_PRIVACY[lang]);
      expect(whySelfHost).not.toMatch(
        /never sees your file bytes|根本看不到你的文件字节|ファイルのバイトを目にすることはありません|파일 데이터를 전혀 보지 못합니다|nie deine Dateibytes sieht|ne voit jamais les octets|لا يرى الخادم بايتات ملفك|nunca ve los bytes|nunca vê os bytes/i,
      );
    });
  }

  it("carries the current article update date", () => {
    // Moved by the guides tutorial batch, which rewrote the Docker, TURN and CLI
    // sections into prerequisites, numbered steps, expected output and
    // troubleshooting. A structural rewrite of that size is exactly what this
    // date is for, so it does not stay at the previous content revision.
    expect(article.updated).toBe("2026-08-06");
  });
});
