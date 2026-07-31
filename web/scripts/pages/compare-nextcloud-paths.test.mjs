import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import article from "./content/articles/compare-nextcloud.mjs";

const TASHKEEL = /[ً-ْٰـ]/g;
const norm = (value) => value.replace(TASHKEEL, "");

const claims = {
  en: {
    server: /server-side (?:(?:realtime )?content copy|content history)/i,
    unreadable: /cannot read or decrypt/i,
    realtime: /realtime/i,
    directCta: /^send (?:a )?file directly/i,
    account: [/same network, no/i, /sender to sign in/i, /recipient never needs an account/i],
  },
  zh: {
    server: /服务端(?:内容)?(?:副本|历史)/,
    unreadable: /无法读取或解密/,
    lan: /局域网|\bLAN\b/,
    realtime: /实时/,
    directCta: /^直接发送/,
    account: [/同一网络下不需要/, /发送方登录/, /接收方始终无需账号/],
  },
  ja: {
    server: /サーバー側(?:のリアルタイム)?(?:内容コピー|履歴)/,
    unreadable: /読取り・復号(?:できない|不能)/,
    realtime: /リアルタイム/,
    directCta: /^ファイルを直接送/,
    account: [/同一ネットワークなら不要/, /送信側のサインイン/, /受信側.*アカウント不要/],
  },
  ko: {
    server: /서버 측 (?:실시간 )?(?:내용 사본|기록)/,
    unreadable: /읽거나 복호화할 수 없/,
    realtime: /실시간/,
    directCta: /^파일을 직접/,
    account: [/같은 네트워크에서는 필요 없/, /보내는 쪽의 로그인/, /받는 쪽.*계정이 필요 없/],
  },
  de: {
    server: /serverseitige (?:Inhaltskopie|Historie)/i,
    unreadable: /weder lesen noch entschlüsseln/i,
    realtime: /Echtzeit/i,
    directCta: /^Sende (?:eine )?Datei direkt/i,
    account: [/Im selben Netzwerk nicht/i, /Absender anmelden/i, /Empfänger braucht nie ein Konto/i],
  },
  fr: {
    server: /(?:copie du contenu|historique).*côté serveur/i,
    unreadable: /ni (?:le )?lire ni (?:le )?déchiffrer/i,
    realtime: /temps réel/i,
    directCta: /^Envoyez (?:un )?fichier directement/i,
    account: [/Sur le même réseau, non/i, /expéditeur se connecte/i, /destinataire n'a jamais besoin de compte/i],
  },
  ar: {
    server: /(?:نسخة محتوى|سجل).*على الخادم/,
    unreadable: /(?:لا يستطيع|فلا يستطيع) (?:قراءة .*? أو فك(?:ه|ّه)|قراءته أو فك(?:ه|ّه))/,
    realtime: /(?:آني|الفوري)/,
    directCta: /^أرسل ملفا مباشرة/,
    account: [/على نفس الشبكة، لا/, /المرسل تسجيل الدخول/, /لا يحتاج المستقبل حسابا أبدا/],
  },
  es: {
    server: /(?:copia de contenido|historial) en el servidor/i,
    unreadable: /no puede (?:leer(?:lo)? ni descifrar(?:lo)?|leer ni descifrar)/i,
    realtime: /tiempo real/i,
    directCta: /^Envía (?:un )?archivo directamente/i,
    account: [/En la misma red, no/i, /remitente inicie sesión/i, /destinatario nunca necesita cuenta/i],
  },
  pt: {
    server: /(?:cópia de conteúdo|histórico) no servidor/i,
    unreadable: /não consegue (?:lê-lo nem descriptografá-lo|ler nem descriptografar)/i,
    realtime: /tempo real/i,
    directCta: /^Envie (?:um )?arquivo diretamente/i,
    account: [/Na mesma rede, não/i, /remetente faça login/i, /destinatário nunca precisa de conta/i],
  },
};

function fields(content) {
  return {
    scoped: [
      content.description,
      content.lead[1],
      content.sections[1].body[1],
      content.sections[2].heading,
      content.sections[2].body[0],
      content.sections[4].bullets[0],
      content.sections[4].bullets[1],
      content.faq.items[1].a,
    ],
    paths: [
      content.description,
      content.lead[1],
      content.sections[1].body[1],
      content.sections[2].body[0],
      content.sections[4].bullets[1],
      content.sections[4].bullets[4],
      content.faq.items[1].a,
    ].join(" "),
  };
}

describe("Nextcloud comparison describes Relayium's actual transfer paths", () => {
  it("covers every shipped locale", () => {
    expect(Object.keys(article.langs)).toEqual(LANGS);
  });

  for (const lang of LANGS) {
    it(`${lang}: scopes realtime storage, LAN, TURN, accounts, links, and CTA`, () => {
      const content = article.langs[lang];
      const rule = claims[lang];
      const { scoped, paths } = fields(content);
      const normalizedPaths = norm(paths);

      for (const field of scoped) expect(norm(field)).toMatch(rule.server);
      expect(normalizedPaths).toMatch(rule.lan || /\bLAN\b/);
      expect(normalizedPaths).toMatch(/\bTURN\b/);
      expect(normalizedPaths).toMatch(rule.unreadable);

      const storedLinkCopy = norm(
        `${content.sections[1].body[1]} ${content.sections[3].body.join(" ")} ${content.faq.items[1].a}`,
      );
      expect(storedLinkCopy).toMatch(/zero-knowledge|零知识|ゼロ知識|영지식|Zero-Knowledge|divulgation nulle|معرفة صفرية|conocimiento cero|conhecimento zero/i);
      expect(storedLinkCopy).toMatch(/expir|到期|期限|만료|Ablauf|ينته|تنتهي/i);

      const account = norm(content.faq.items[2].a);
      for (const pattern of rule.account) expect(account).toMatch(pattern);

      expect(norm(content.cta.text)).toMatch(rule.realtime);
      expect(norm(content.cta.text)).not.toMatch(rule.directCta);
    });
  }
});
