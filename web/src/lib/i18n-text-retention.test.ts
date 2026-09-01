import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const locales = { en, zh };

const facts = {
  en: {
    online: /both devices online|both stay online|both sides stay online/i,
    noServerHistory: /server(?:s|-side).*(?:no message bodies|no server-side history|keep no message bodies)|no server-side (?:message )?history/i,
    endpointRetention: /endpoint|terminal|browser|recipient/i,
    turnByDesign: /through TURN by design/i,
    cannotDecrypt: /cannot decrypt|read or decrypt/i,
    visibilityBad: /server never sees|never sees your files|never sees either/i,
    directNameBad: /\bdirect\b/i,
    quotaScope: /Same-network sessions and direct CLI transfers are unaffected/i,
    quotaBad: /direct peer-to-peer connection still works|relay fallback|fall back on/i,
    codeCreator: /code creator|creator.*code|creating.*code/i,
    joiner: /join(?:er|ing)|person joining/i,
    joinerNoAccount: /no account/i,
    bad: /never stored|gone when (?:the|this) session ends|nothing stored|nothing is ever written/i,
  },
  zh: {
    online: /双方.*在线|两端需同时在线/,
    noServerHistory: /服务器不保存消息正文或记录|不保留服务端消息记录|无服务端记录/,
    endpointRetention: /任一端|终端|接收端|浏览器/,
    turnByDesign: /按设计经 TURN/,
    cannotDecrypt: /无法解密|读取或解密/,
    visibilityBad: /服务器.*看不到|服务器两者都看不到/,
    directNameBad: /直传/,
    quotaScope: /同一网络会话与 CLI 直连不受影响/,
    quotaBad: /直连仍可用|中继兜底|无中继可兜底/,
    codeCreator: /码创建者|创建.*码|创建者/,
    joiner: /加入/,
    joinerNoAccount: /无需账号|免账号/,
    bad: /绝不存储|从不存到任何服务器|会话结束即消失|任何内容都不会写入服务器|消息不会被存储|不留存/,
  },
  ja: {
    online: /双方.*オンライン|両方がオンライン/,
    noServerHistory: /サーバー側履歴を(?:保存|保持)しません|サーバー側履歴はなく/,
    endpointRetention: /端末|ブラウザ|受信側/,
    turnByDesign: /設計上TURN/,
    cannotDecrypt: /復号(?:も)?でき(?:ません|ない)|復号不能|読んだり復号したり/,
    visibilityBad: /サーバー.*見られ|見えません/,
    directNameBad: /直接/,
    quotaScope: /同一ネットワークとCLI直結は影響を受けません/,
    quotaBad: /P2P直結は引き続き|中継フォールバック|フォールバックする中継/,
    codeCreator: /コード作成者|コードの作成/,
    joiner: /参加/,
    joinerNoAccount: /アカウント不要|参加側は不要/,
    bad: /どのサーバーにも保存されず|セッション.*消えます|保存はされません|メッセージは保存されません|送ったら消える、保存なし/,
  },
  ko: {
    online: /양쪽.*온라인|두 기기는 함께 온라인/,
    noServerHistory: /서버.*(?:본문이나 기록|서버 측 메시지 기록)|서버 측 기록이 없/,
    endpointRetention: /기기|터미널|브라우저|수신/,
    turnByDesign: /설계상 TURN/,
    cannotDecrypt: /복호화할 수 없|읽거나 복호화/,
    visibilityBad: /서버.*볼 수 없|보지 못/,
    directNameBad: /직접/,
    quotaScope: /동일 네트워크 세션과 CLI 직접 연결은 영향을 받지 않습니다/,
    quotaBad: /P2P 직접 연결은 계속 가능|릴레이 대체 경로|대체할 릴레이/,
    codeCreator: /코드 생성자|코드를 만드는|페어링 코드 생성/,
    joiner: /참여/,
    joinerNoAccount: /계정.*(?:불필요|필요 없)/,
    bad: /어떤 서버에도 저장되지 않고|세션이 끝나면 사라|메시지는 저장되지 않습니다|보내면 끝, 저장되지 않음/,
  },
  de: {
    online: /beide Geräte online|beide bleiben online|beide Seiten bleiben online/i,
    noServerHistory: /serverseitigen (?:Nachrichten)?verlauf/i,
    endpointRetention: /Endgerät|Terminal|Browser|Empfänger/i,
    turnByDesign: /planmäßig über TURN/i,
    cannotDecrypt: /nicht entschlüsseln|lesen oder entschlüsseln|weder lesen noch entschlüsseln/i,
    visibilityBad: /Server.*sieht.*nie|sieht deine Dateien nie/i,
    directNameBad: /Direkt/i,
    quotaScope: /Sitzungen im selben Netz und direkte CLI-Wege bleiben unberührt/i,
    quotaBad: /direkte Peer-to-Peer-Verbindung funktioniert weiterhin|Relay-Rückfall|kein Relay als Rückfall/i,
    codeCreator: /Code-Ersteller|Ersteller.*Code|Erzeugen.*Code|Code erstellt/i,
    joiner: /Beitritt|beitritt/i,
    joinerNoAccount: /ohne Konto|kein Konto/i,
    bad: /wird nie gespeichert|auf keinem Server gespeichert|Ende der Sitzung weg|nichts wird gespeichert|Nachrichten werden nicht gespeichert|Senden und weg, nichts gespeichert|nichts wird je auf einem Server geschrieben/i,
  },
  fr: {
    online: /deux appareils (?:en ligne|restent connectés)/i,
    noServerHistory: /serveurs? Relayium ne conserve(?:nt)? ni corps de message ni historique|aucun historique serveur/i,
    endpointRetention: /appareil|terminal|navigateur|destinataire/i,
    turnByDesign: /TURN par conception/i,
    cannotDecrypt: /lire.*déchiffrer/i,
    visibilityBad: /serveur.*(?:ne voit jamais|ne voit ni)|ne voit jamais (?:tes|vos) fichiers/i,
    directNameBad: /\bdirect(?:e|ement)?\b/i,
    quotaScope: /(?:sessions sur le même réseau et les transferts directs CLI (?:restent disponibles|ne sont pas affectés))/i,
    quotaBad: /connexion directe pair-à-pair fonctionne toujours|relais de secours|aucun relais de secours/i,
    codeCreator: /créateur.*code|crée.*code|création.*code/i,
    joiner: /rejoint/i,
    joinerNoAccount: /pas besoin de compte|n'en a pas besoin/i,
    bad: /jamais stocké|disparaît à la fin de la session|rien n'est stocké|aucun stockage nulle part/i,
  },
  ar: {
    online: /اتصال الجهازين|كلا الجهازين متصل|الطرفان متصلان/,
    noServerHistory: /لا يحفظ Relayium أجسام الرسائل أو سجلها|لا يحفظ Relayium سجلًا على الخادم/,
    endpointRetention: /الطرفين|المتصفح|المستلم|الجهاز/,
    turnByDesign: /TURN بحكم التصميم/,
    cannotDecrypt: /قراءة.*فكّ? (?:ال)?تشفير|لا يستطيع.*فكّ? (?:ال)?تشفير|قراءتها أو فك تشفيرها/,
    visibilityBad: /الخادم.*(?:لا يرى|لن يرى)|لا يرى.*أبدًا/,
    directNameBad: /مباشر/,
    quotaScope: /(?:تبقى جلسات الشبكة نفسها وعمليات CLI المباشرة متاحة|لا تتأثر جلسات الشبكة نفسها وعمليات CLI المباشرة)/,
    quotaBad: /اتصال.*مباشر.*يعمل|ترحيل احتياطي|مُرحِّل احتياطي/,
    codeCreator: /ينشئ.*رمز|إنشاء.*رمز|منشئ الرمز/,
    joiner: /ينضم/,
    joinerNoAccount: /لا يحتاج.*حساب/,
    bad: /لا تُخزَّن أبدًا|تختفي عند انتهاء الجلسة|لا يُحفظ أي شيء في أي مكان/,
  },
  es: {
    online: /ambos dispositivos (?:en línea|conectados)/i,
    noServerHistory: /Relayium no guarda cuerpos ni historial de mensajes|Relayium no guarda historial/i,
    endpointRetention: /extremo|terminal|navegador|destinatario/i,
    turnByDesign: /TURN por diseño/i,
    cannotDecrypt: /leer.*descifrar/i,
    visibilityBad: /servidor.*(?:nunca ve|no ve)|nunca ve (?:tus|sus) archivos/i,
    directNameBad: /\bdirect(?:a|amente|o)?\b/i,
    quotaScope: /(?:sesiones en la misma red y las transferencias directas por CLI (?:siguen disponibles|no se ven afectadas))/i,
    quotaBad: /conexión directa entre pares sigue funcionando|retransmisor de respaldo|respaldo por retransmisión/i,
    codeCreator: /crea.*código|crear.*código/i,
    joiner: /se une/i,
    joinerNoAccount: /no necesita (?:una )?cuenta|no la necesita/i,
    bad: /nunca se almacena|desaparece al terminar la sesión|no se guarda nada en ningún sitio/i,
  },
  pt: {
    online: /dois dispositivos (?:online|conectados)/i,
    noServerHistory: /Relayium não guarda corpo nem histórico|Relayium não guarda histórico/i,
    endpointRetention: /ponta|terminal|navegador|destinatário/i,
    turnByDesign: /TURN por projeto/i,
    cannotDecrypt: /não consegue(?:m)? (?:ler nem )?descriptografar|sem conseguir ler nem descriptografar|ler ou descriptografar/i,
    visibilityBad: /servidor.*(?:nunca vê|não vê)|nunca vê (?:seus|os) arquivos/i,
    directNameBad: /\bdiret(?:a|amente|o)?\b/i,
    quotaScope: /(?:sessões na mesma rede e transferências diretas pela CLI (?:continuam disponíveis|não são afetadas))/i,
    quotaBad: /conexão direta entre pares ainda funciona|retransmissor de alternativa|alternativa de retransmissão/i,
    codeCreator: /cria.*código|criar.*código/i,
    joiner: /participa/i,
    joinerNoAccount: /não precisa(?: de conta)?/i,
    bad: /nunca (?:é )?armazenad|desaparece quando a sessão termina|nada é guardado em lugar nenhum/i,
  },
};

function retentionCopy(m: typeof en): string {
  return [
    m.descDefault,
    m.pricingPage.free3,
    m.pricingPage.a1,
    // /cli's `text` mode. It used to be one paragraph (cliPage.textIntro); the
    // same facts now live in the mode's lead plus its boundary notes, so both
    // go into the aggregate rather than only the opening sentence.
    m.cliPage.modes.text.lead,
    ...m.cliPage.modes.text.notes,
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

    it(`${code} avoids visibility overclaims in product-level realtime copy`, () => {
      const expected = facts[code as keyof typeof facts];
      const fields = [
        messages.tagline,
        messages.footer,
        messages.crossnet.realtimeSub,
        messages.crossSell.realtime.lead,
        messages.howItWorks.realtime.ways[2].tag,
      ];
      for (const field of fields) {
        expect(field, `${code}: read/decrypt boundary`).toMatch(expected.cannotDecrypt);
        expect(field, `${code}: legacy never-sees claim`).not.toMatch(expected.visibilityBad);
      }
    });

    it(`${code} names cross-network browser transfer without calling it direct`, () => {
      const expected = facts[code as keyof typeof facts];
      for (const field of [
        messages.nav.crossTab,
        messages.crossTitle,
        messages.compare.sub,
        messages.compare.colRealtime,
        messages.faq.items[2].a,
        messages.faq.cross[0].a,
        messages.faq.cross[1].a,
        messages.crossPitch,
        messages.crossnet.realtimeTitle,
        messages.crossSell.realtime.cta,
        messages.methods.realtime.name,
        messages.howItWorks.realtime.title,
        // The three DESCRIPTIONS of that destination, added after fr/ar/es/pt
        // were found still offering "direct on the local network, or TURN
        // between networks" — a same-network path presented as one of this
        // destination's own options. Cross-network Transfer is LAN Transfer's
        // sibling, not a mode that contains it: the only path it has is TURN.
        // The list above covered the NAMES, which is why the rename left the
        // bodies untouched and the claim survived in four languages.
        messages.crossnet.realtimeSub,
        messages.crossSell.realtime.lead,
        messages.homeCross.desc,
      ]) {
        expect(field, `${code}: cross-network mode name`).not.toMatch(expected.directNameBad);
      }
    });

    it(`${code} explains exhausted relay quota without fallback claims`, () => {
      const expected = facts[code as keyof typeof facts];
      for (const field of [messages.crossnet.relayQuotaWarn, messages.crossnet.relayQuotaFail]) {
        expect(field, `${code}: unaffected paths`).toMatch(expected.quotaScope);
        expect(field, `${code}: legacy fallback claim`).not.toMatch(expected.quotaBad);
      }
    });

    it(`${code} describes relay visibility consistently in comparison and FAQ copy`, () => {
      const expected = facts[code as keyof typeof facts];
      for (const field of [
        messages.compare.rows[2].realtime,
        messages.faq.items[3].a,
        messages.faq.cross[3].a,
      ]) {
        expect(field, `${code}: relay cannot read or decrypt`).toMatch(expected.cannotDecrypt);
        expect(field, `${code}: relay visibility overclaim`).not.toMatch(expected.visibilityBad);
      }
    });

    it(`${code} describes cross-network browser speed as TURN-by-design`, () => {
      const expected = facts[code as keyof typeof facts];
      const speed = messages.faq.cross[5].a;
      expect(speed, `${code}: TURN path`).toMatch(/TURN/);
      expect(speed, `${code}: no direct browser path`).not.toMatch(expected.directNameBad);
    });

    it(`${code} identifies pairing codes and share links as TURN browser sessions`, () => {
      for (const field of [messages.faq.cross[0].a, messages.faq.cross[1].a]) {
        expect(field, `${code}: TURN browser session`).toMatch(/TURN/);
      }
    });

    it(`${code} describes realtime account rules by code creator and joiner`, () => {
      const expected = facts[code as keyof typeof facts];
      for (const field of [
        messages.compare.rows[0].realtime,
        messages.faq.items[4].a,
        messages.faq.cross[4].a,
      ]) {
        expect(field, `${code}: code creator`).toMatch(expected.codeCreator);
        expect(field, `${code}: joiner`).toMatch(expected.joiner);
        expect(field, `${code}: joiner needs no account`).toMatch(expected.joinerNoAccount);
      }
    });
  }
});
