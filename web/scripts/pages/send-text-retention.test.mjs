import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import article from "./content/articles/howto-send-text-between-devices.mjs";
import { LANGS } from "./shared.mjs";

const NO_SERVER_HISTORY = {
  en: /Relayium servers keep no message bodies or server-side history/i,
  zh: /Relayium 服务器不保存消息正文或服务端历史/,
  ja: /Relayium サーバーは本文やサーバー側履歴を保存しません/,
  ko: /Relayium 서버는 본문이나 서버 측 기록을 저장하지 않/,
  de: /Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf/i,
  fr: /serveurs Relayium ne gardent ni corps de message ni historique côté serveur/i,
  ar: /لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم/,
  es: /servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor/i,
  pt: /servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor/i,
};

const ENDPOINT_RETENTION = {
  en: /either endpoint can (?:copy or )?retain received text/i,
  zh: /任一端都(?:能|可).*留存收到的文本/,
  ja: /各端末は受信テキストを(?:コピーまたは)?保持できます/,
  ko: /각 기기는 받은 텍스트를 (?:복사하거나 )?보관할 수 있습니다/,
  de: /beide Endpunkte können empfangenen Text (?:kopieren oder )?aufbewahren/i,
  fr: /chaque extrémité peut (?:copier ou )?conserver le texte reçu/i,
  ar: /يمكن لأي طرف (?:نسخ النص المستلم أو )?الاحتفاظ بالنص المستلم|يمكن لأي طرف الاحتفاظ بالنص المستلم/,
  es: /cualquiera de los extremos puede (?:copiar o )?conservar el texto recibido/i,
  pt: /qualquer ponta pode (?:copiar ou )?conservar o texto recebido/i,
};

const OLD_ABSOLUTE = {
  en: /\bnever stored\b|Relayium never stores them|never stored by Relayium/i,
  zh: /Relayium 从不存储/,
  ja: /Relayium は保存しません|内容.*保存されません/,
  ko: /Relayium은 저장하지 않습니다|내용.*저장되지 않습니다/,
  de: /nie von Relayium gespeichert|Inhalt.*wird nicht gespeichert/i,
  fr: /jamais stocké|ne sont jamais stockés|n'est jamais stocké/i,
  ar: /ولا يخزنها Relayium|المحتوى.*لا يُخزن/,
  es: /nunca almacenado|Relayium nunca los almacena|contenido.*nunca se almacena/i,
  pt: /nunca armazenado|nunca são armazenadas pelo Relayium|conteúdo.*nunca armazenado/i,
};

describe("text guide scopes storage claims to Relayium servers", () => {
  for (const lang of LANGS) {
    it(`${lang}: states the server boundary and endpoint retention`, () => {
      const doc = article.langs[lang];
      const leadAndFaq = [doc.description, ...doc.lead, ...doc.faq.items.map((item) => item.a)].join(" ");

      expect(leadAndFaq).toMatch(NO_SERVER_HISTORY[lang]);
      expect(leadAndFaq).toMatch(ENDPOINT_RETENTION[lang]);
      expect(leadAndFaq).not.toMatch(OLD_ABSOLUTE[lang]);
    });
  }

  it("README distinguishes browser LAN, browser cross-network, and CLI text paths", () => {
    const readme = readFileSync("../README.md", "utf8");
    expect(readme).toContain("opens an independent end-to-end encrypted connection");
    expect(readme).toContain("On a LAN, browser messages move directly");
    expect(readme).toContain("cross-network browser sessions use TURN that carries only ciphertext");
    expect(readme).toContain("CLI text is direct-only");
    expect(readme).not.toContain("a message session\nopens a peer-to-peer connection of its own");
  });
});
