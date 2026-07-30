import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import landing from "./content/landing.mjs";
import { buildLandingPages } from "./build-pages.mjs";
import { renderLandingPage } from "./landing-template.mjs";

describe("buildLandingPages", () => {
  const pages = buildLandingPages(landing);
  const landingSource = readFileSync(
    resolve(process.cwd(), "scripts/pages/content/landing.mjs"),
    "utf8",
  );

  it("produces 8 pages at <lang>/index.html", () => {
    expect(pages.map((p) => p.path).sort()).toEqual(
      ["ar/index.html", "de/index.html", "es/index.html", "fr/index.html", "ja/index.html", "ko/index.html", "pt/index.html", "zh/index.html"]
    );
  });

  it("zh page has localized h1, canonical, and full hreflang cluster", () => {
    const zh = pages.find((p) => p.path === "zh/index.html").html;
    expect(zh).toContain('<html lang="zh-Hans">');
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/" />');
    expect(zh).toContain('hreflang="en" href="https://relayium.com/"');
    expect(zh).toContain('hreflang="ja" href="https://relayium.com/ja/"');
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/"');
    expect(zh).toContain("<h1>");
  });

  it("CTA opens the SPA with the language preset", () => {
    const ja = pages.find((p) => p.path === "ja/index.html").html;
    expect(ja).toContain('href="/?lang=ja"');
  });

  it("embeds WebApplication + FAQPage JSON-LD in the page language", () => {
    const de = pages.find((p) => p.path === "de/index.html").html;
    expect(de).toContain('"@type":"FAQPage"');
    expect(de).toContain('"inLanguage":"de"');
  });

  it("renders article links when provided", () => {
    const html = renderLandingPage({
      lang: "zh",
      doc: landing.langs.zh,
      articleLinks: [{ slug: "compare/snapdrop", title: "对比 Snapdrop" }],
    });
    expect(html).toContain('href="/zh/compare/snapdrop/"');
  });

  it("links the Guides hub in the footer", () => {
    const zh = pages.find((p) => p.path === "zh/index.html").html;
    expect(zh).toContain('href="/zh/guides/">使用指南<');
  });

  it("footer order: Relayium link, then Guides, then Privacy", () => {
    const zh = pages.find((p) => p.path === "zh/index.html").html;
    const relayiumIdx = zh.indexOf(">← Relayium<");
    const guidesIdx = zh.indexOf('href="/zh/guides/">使用指南<');
    const privacyIdx = zh.indexOf('href="/zh/privacy/">隐私政策<');
    expect(relayiumIdx).toBeGreaterThan(-1);
    expect(guidesIdx).toBeGreaterThan(-1);
    expect(privacyIdx).toBeGreaterThan(-1);
    expect(relayiumIdx).toBeLessThan(guidesIdx);
    expect(guidesIdx).toBeLessThan(privacyIdx);
  });

  it("keeps ephemeral-text storage and endpoint boundaries in all 8 languages", () => {
    const facts = {
      zh: [/不保存消息正文或服务端历史/, /浏览器或接收端可以复制或留存/],
      ja: [/本文やサーバー側履歴を保存しません/, /コピー・保持できます/],
      ko: [/메시지 본문이나 서버 측 기록을 저장하지 않지만/, /복사·보관할 수 있습니다/],
      de: [/weder Nachrichtentexte noch serverseitigen Verlauf/, /kopieren oder behalten/],
      fr: [/ni corps de message ni historique serveur/, /copier ou garder le texte/],
      ar: [/أجسام الرسائل أو سجلًا على الخادم/, /نسخ النص أو الاحتفاظ به/],
      es: [/no guardan cuerpos ni historial/, /copiar o conservar el texto/],
      pt: [/não guardam corpo nem histórico/, /copiar ou reter o texto/],
    };
    const forbidden = [
      /不存储在任何服务器上|会话结束即消失|任何地方保留记录/,
      /どのサーバーにも保存されず|セッション終了とともに消え|履歴もどこにも/,
      /어떤 서버에도 저장되지 않고|세션이 끝나면 사라|기록도 어디에도/,
      /auf keinem Server gespeichert|Ende der Sitzung weg/,
      /stockés sur aucun serveur|disparaissent à la fin de la session/,
      /لا تُخزَّن على أي خادم|تزول بانتهاء الجلسة/,
      /no se guardan en ningún servidor|desaparecen al terminar la sesión/,
      /não ficam em nenhum servidor|desaparecem quando a sessão termina/,
    ];
    const accountBoundary = {
      zh: /创建跨网络配对码需登录，持码加入无需账号/,
      ja: /コードの作成にはサインインが必要.*コードでの参加には不要/,
      ko: /코드 생성에는 로그인이 필요하지만 코드로 참여할 때는 필요 없/,
      de: /Erstellen.*Codes erfordert eine Anmeldung, der Beitritt.*nicht/,
      fr: /créer un code.*exige une connexion, le rejoindre.*non/,
      ar: /إنشاء رمز اقتران.*تسجيل الدخول.*الانضمام بالرمز.*لا يتطلب حسابًا/,
      es: /crear un código.*exige iniciar sesión, unirse con él no/,
      pt: /criar um código.*exige login, entrar com ele não/,
    };

    for (const [lang, patterns] of Object.entries(facts)) {
      const html = pages.find((page) => page.path === `${lang}/index.html`).html;
      expect(html, lang).toContain("TURN");
      expect(html, lang).toMatch(/65(?:,|\.| )536/);
      expect(html, `${lang}: open-source positioning`).toMatch(
        /开源|オープンソース|오픈 소스|quelloffen|open source|مفتوحة المصدر|código abierto|código aberto/i,
      );
      expect(html, `${lang}: install-free positioning`).toMatch(
        /无需安装|インストール不要|설치가 필요 없는|installationsfrei|sans installation|لا تتطلب تثبيتًا|sin instalación|sem instalação/i,
      );
      expect(html, `${lang}: pairing-code account boundary`).toMatch(accountBoundary[lang]);
      for (const pattern of patterns) expect(html, lang).toMatch(pattern);
      for (const pattern of forbidden) expect(html, lang).not.toMatch(pattern);
    }
    for (const pattern of forbidden) expect(landingSource).not.toMatch(pattern);
  });
});
