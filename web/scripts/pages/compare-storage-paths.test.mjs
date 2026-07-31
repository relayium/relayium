import { describe, expect, it } from "vitest";
import googleDrive from "./content/articles/compare-google-drive.mjs";
import { LANGS } from "./shared.mjs";

const SERVER_SCOPE = {
  en: /server-side (?:content copy|copy.*content|content storage)/i,
  zh: /服务端内容副本|内容的服务端副本|服务端内容存储/,
  ja: /サーバー側の?内容コピー|内容のサーバー側コピー|サーバー側の内容保存/,
  ko: /서버 측 내용 사본|내용의 서버 측 사본|서버 측 내용 저장/,
  de: /serverseitige (?:Inhaltskopie|Kopie.*Inhalt|Inhaltsspeicherung)/i,
  fr: /copie (?:de contenu|du contenu) côté serveur|copie côté serveur du contenu|stockage de contenu côté serveur/i,
  ar: /نسخة (?:محتوى|من المحتوى) على الخادم|نسخة على الخادم من المحتوى|تخزين المحتوى على الخادم/,
  es: /copia (?:del contenido|de contenido).*en el servidor|almacenar contenido en el servidor/i,
  pt: /cópia (?:do conteúdo|de conteúdo).*no servidor|armazenar conteúdo no servidor/i,
};

const LAN_DIRECT = {
  en: /LAN.*(?:move directly|files move directly)/i,
  zh: /局域网.*直连/,
  ja: /LAN.*直接/,
  ko: /LAN.*직접/,
  de: /LAN.*direkt/i,
  fr: /LAN.*directement/i,
  ar: /LAN.*مباشرة/,
  es: /LAN.*direct/i,
  pt: /LAN.*diret/i,
};

const TURN_BOUNDARY = {
  en: /across networks.*TURN.*ciphertext.*cannot read or decrypt/i,
  zh: /跨网络.*TURN.*密文.*无法读取或解密/,
  ja: /ネットワーク.*TURN.*(?:暗号文.*読み取りも復号もできない|読み取りも復号もできない.*暗号文)/,
  ko: /네트워크.*TURN.*암호문.*읽거나 복호화할 수 없는/,
  de: /netzübergreifend.*TURN.*Text.*weder lesen noch entschlüsseln/i,
  fr: /entre réseaux.*TURN.*texte chiffré.*ni lire ni déchiffrer/i,
  ar: /عبر الشبكات.*TURN.*نص مشفّر.*قراءته أو فك تشفيره/,
  es: /entre redes.*TURN.*texto cifrado.*leer ni descifrar/i,
  pt: /entre redes.*TURN.*texto cifrado.*ler nem descriptografar/i,
};

const REALTIME_CTA = {
  en: /realtime transfer/i,
  zh: /实时传输/,
  ja: /リアルタイム転送/,
  ko: /실시간 전송/,
  de: /Echtzeitübertragung/i,
  fr: /temps réel/i,
  ar: /النقل الفوري/,
  es: /tiempo real/i,
  pt: /tempo real/i,
};

const OLD_DIRECT_CTA = {
  en: /Send a file directly/i,
  zh: /直接发送文件/,
  ja: /ファイルを直接送/,
  ko: /파일을 직접 보내/,
  de: /Sende eine Datei direkt/i,
  fr: /Envoyez un fichier directement/i,
  ar: /أرسل ملفًا مباشرة/,
  es: /Envía un archivo directamente/i,
  pt: /Envie um arquivo diretamente/i,
};

describe("Google Drive comparison states realtime browser paths precisely", () => {
  for (const lang of LANGS) {
    it(`${lang}: keeps all high-risk path claims consistent`, () => {
      const doc = googleDrive.langs[lang];
      const pathFields = [
        doc.description,
        doc.lead[1],
        doc.sections[1].body[1],
        doc.sections[2].body[0],
        doc.faq.items[0].a,
      ];
      const combined = pathFields.join(" ");

      for (const field of pathFields) {
        expect(field).toMatch(SERVER_SCOPE[lang]);
      }
      expect(combined).toMatch(LAN_DIRECT[lang]);
      expect(combined).toMatch(TURN_BOUNDARY[lang]);
      expect(doc.sections[2].heading).toMatch(SERVER_SCOPE[lang]);
      expect(doc.cta.text).toMatch(REALTIME_CTA[lang]);
      expect(doc.cta.text).not.toMatch(OLD_DIRECT_CTA[lang]);
    });
  }
});
