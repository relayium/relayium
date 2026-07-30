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

const facts = {
  en: {
    online: /both devices online|both stay online|both sides stay online/i,
    noServerHistory: /server(?:s|-side).*(?:no message bodies|no server-side history|keep no message bodies)|no server-side (?:message )?history/i,
    endpointRetention: /endpoint|terminal|browser|recipient/i,
    turnByDesign: /through TURN by design/i,
    cannotDecrypt: /cannot decrypt|read or decrypt/i,
    bad: /never stored|gone when (?:the|this) session ends|nothing stored|nothing is ever written/i,
  },
  zh: {
    online: /双方.*在线|两端需同时在线/,
    noServerHistory: /服务器不保存消息正文或记录|不保留服务端消息记录|无服务端记录/,
    endpointRetention: /任一端|终端|接收端|浏览器/,
    turnByDesign: /按设计经 TURN/,
    cannotDecrypt: /无法解密|读取或解密/,
    bad: /绝不存储|从不存到任何服务器|会话结束即消失|任何内容都不会写入服务器|消息不会被存储|不留存/,
  },
  ja: {
    online: /双方.*オンライン|両方がオンライン/,
    noServerHistory: /サーバー側履歴を(?:保存|保持)しません|サーバー側履歴はなく/,
    endpointRetention: /端末|ブラウザ|受信側/,
    turnByDesign: /設計上TURN/,
    cannotDecrypt: /復号できません|読んだり復号したり/,
    bad: /どのサーバーにも保存されず|セッション.*消えます|保存はされません|メッセージは保存されません|送ったら消える、保存なし/,
  },
  ko: {
    online: /양쪽.*온라인|두 기기는 함께 온라인/,
    noServerHistory: /서버.*(?:본문이나 기록|서버 측 메시지 기록)|서버 측 기록이 없/,
    endpointRetention: /기기|터미널|브라우저|수신/,
    turnByDesign: /설계상 TURN/,
    cannotDecrypt: /복호화할 수 없습니다|읽거나 복호화/,
    bad: /어떤 서버에도 저장되지 않고|세션이 끝나면 사라|메시지는 저장되지 않습니다|보내면 끝, 저장되지 않음/,
  },
  de: {
    online: /beide Geräte online|beide bleiben online|beide Seiten bleiben online/i,
    noServerHistory: /serverseitigen (?:Nachrichten)?verlauf/i,
    endpointRetention: /Endgerät|Terminal|Browser|Empfänger/i,
    turnByDesign: /planmäßig über TURN/i,
    cannotDecrypt: /nicht entschlüsseln|lesen oder entschlüsseln/i,
    bad: /wird nie gespeichert|auf keinem Server gespeichert|Ende der Sitzung weg|nichts wird gespeichert|Nachrichten werden nicht gespeichert|Senden und weg, nichts gespeichert|nichts wird je auf einem Server geschrieben/i,
  },
  fr: {
    online: /deux appareils (?:en ligne|restent connectés)/i,
    noServerHistory: /serveurs? Relayium ne conserve(?:nt)? ni corps de message ni historique|aucun historique serveur/i,
    endpointRetention: /appareil|terminal|navigateur|destinataire/i,
    turnByDesign: /TURN par conception/i,
    cannotDecrypt: /lire.*déchiffrer/i,
    bad: /jamais stocké|disparaît à la fin de la session|rien n'est stocké|aucun stockage nulle part/i,
  },
  ar: {
    online: /اتصال الجهازين|كلا الجهازين متصل|الطرفان متصلان/,
    noServerHistory: /لا يحفظ Relayium أجسام الرسائل أو سجلها|لا يحفظ Relayium سجلًا على الخادم/,
    endpointRetention: /الطرفين|المتصفح|المستلم|الجهاز/,
    turnByDesign: /TURN بحكم التصميم/,
    cannotDecrypt: /قراءة.*فك تشفير|لا يستطيع.*فك تشفير|قراءتها أو فك تشفيرها/,
    bad: /لا تُخزَّن أبدًا|تختفي عند انتهاء الجلسة|لا يُحفظ أي شيء في أي مكان/,
  },
  es: {
    online: /ambos dispositivos (?:en línea|conectados)/i,
    noServerHistory: /Relayium no guarda cuerpos ni historial de mensajes|Relayium no guarda historial/i,
    endpointRetention: /extremo|terminal|navegador|destinatario/i,
    turnByDesign: /TURN por diseño/i,
    cannotDecrypt: /leer.*descifrar/i,
    bad: /nunca se almacena|desaparece al terminar la sesión|no se guarda nada en ningún sitio/i,
  },
  pt: {
    online: /dois dispositivos (?:online|conectados)/i,
    noServerHistory: /Relayium não guarda corpo nem histórico|Relayium não guarda histórico/i,
    endpointRetention: /ponta|terminal|navegador|destinatário/i,
    turnByDesign: /TURN por projeto/i,
    cannotDecrypt: /não consegue (?:ler nem )?descriptografar|ler ou descriptografar/i,
    bad: /nunca (?:é )?armazenad|desaparece quando a sessão termina|nada é guardado em lugar nenhum/i,
  },
};

function retentionCopy(m: typeof en): string {
  return [
    m.descDefault,
    m.pricingPage.free3,
    m.pricingPage.a1,
    m.cliPage.textIntro,
    m.features.items[1].desc,
    m.compare.rows[3].realtime,
    m.useCases.items[4].desc,
    m.faq.items[6].a,
    m.homeText.points[2],
    m.text.availabilityHint,
    m.text.ephemeralNote,
  ].join("\n");
}

describe("localized ephemeral-text retention boundaries", () => {
  for (const [code, messages] of Object.entries(locales)) {
    it(`${code} separates Relayium server retention from endpoint retention`, () => {
      const copy = retentionCopy(messages);
      const expected = facts[code as keyof typeof facts];

      expect(copy, `${code}: both devices online`).toMatch(expected.online);
      expect(copy, `${code}: no server-side message history`).toMatch(expected.noServerHistory);
      expect(copy, `${code}: endpoint may retain`).toMatch(expected.endpointRetention);
      expect(copy, `${code}: known-bad absolute claim`).not.toMatch(expected.bad);
    });

    it(`${code} describes browser TURN and plaintext visibility precisely`, () => {
      const expected = facts[code as keyof typeof facts];
      expect(messages.me.nodesTrafficHint).toMatch(expected.turnByDesign);
      expect(messages.features.items[1].title).toMatch(expected.cannotDecrypt);
      expect(messages.faq.items[3].q).toMatch(expected.cannotDecrypt);
    });
  }
});
