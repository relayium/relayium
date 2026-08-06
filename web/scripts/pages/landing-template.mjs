// web/scripts/pages/landing-template.mjs — renders one static localized landing page.
// Self-contained: no JS, no external CSS. Styles are inlined so the page is
// independent of the Vite asset graph and fully crawlable with JS disabled.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LANGS, LANG_LABELS, GUIDES_LABELS, APPS_LABELS, pricingLabel, PRICING_URL, RELEASES_LABELS, BCP47, OG_LOCALE, OG_IMAGE_META, SITE, landingUrl, ctaHref, urlPath, absUrl, esc, dirAttr, rtlHead } from "./shared.mjs";

// Exported so mode-template.mjs (and any other landing-style page) can reuse the
// exact same inline stylesheet + page-shell classes instead of forking them.
export const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;--accent-fg:#7e22ce;--accent-action:#6d28d9;--accent-action-deep:#4338ca;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc;--accent-fg:#c084fc;--accent-action:#7c3aed;--accent-action-deep:#4f46e5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:0 20px 64px}
header{display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border)}
header .logo{width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;color:#fff;background:linear-gradient(135deg,var(--accent),#6d28d9)}
header a{color:var(--text-h);text-decoration:none;font-weight:600}
h1{color:var(--text-h);font-size:38px;letter-spacing:-.5px;margin:40px 0 12px}
h2{color:var(--text-h);font-size:24px;margin:44px 0 12px}
h3{color:var(--text-h);font-size:18px;margin:22px 0 4px}
.pitch{font-size:20px;margin:0 0 24px;max-width:42em}
p{margin:12px 0}ul{margin:12px 0;padding-inline-start:22px}li{margin:8px 0}
ol.shots{display:grid;gap:18px;margin:22px 0 4px}
.shots figure{margin:0}
.shots img{display:block;width:100%;height:auto;border:1px solid var(--border);border-radius:10px;background:#fff}
.shots figcaption{margin-top:8px;font-size:14.5px;color:var(--muted);line-height:1.5}
@media(min-width:820px){.shots{grid-template-columns:repeat(3,1fr);align-items:start}}
.steps{margin:12px 0;padding-inline-start:22px}ol.steps li{margin:10px 0}
.cta{display:inline-block;margin:8px 0 4px;padding:14px 28px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;text-decoration:none;background:linear-gradient(135deg,var(--accent-action),var(--accent-action-deep))}
.langbar{display:flex;flex-wrap:wrap;gap:6px 12px;margin:16px 0 8px;font-size:13.5px}
.langbar a{color:var(--accent-fg);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.why li b,.compare h3{color:var(--text-h)}
.learn-groups{display:grid;gap:22px;margin-top:14px}
@media(min-width:820px){.learn-groups{grid-template-columns:repeat(3,1fr)}}
.learn-groups h3{margin:0 0 6px;font-size:16px}
.learn-all{margin:16px 0 0}
.close-cta{margin:26px 0 0}
.learn{list-style:none;padding:0}.learn a{color:var(--accent-fg);text-decoration:none}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
header .logo{transition:transform .25s cubic-bezier(.22,1,.36,1)}header a:hover .logo{transform:rotate(-8deg) scale(1.08)}
.cta{transition:transform .18s ease,filter .18s ease}.cta:hover{transform:translateY(-1px);filter:brightness(1.06)}
/* Pure-CSS staggered entrance — keeps these pages JS-free and crawlable while
   still giving the content a little life on load. animation fill-mode:both ends
   fully visible, so nothing is ever stuck hidden (no-JS, old browsers, or IO
   quirks all resolve to visible). */
.reveal{animation:sec-in .55s cubic-bezier(.22,1,.36,1) both}
section.reveal:nth-of-type(1){animation-delay:.04s}
section.reveal:nth-of-type(2){animation-delay:.11s}
section.reveal:nth-of-type(3){animation-delay:.18s}
section.reveal:nth-of-type(4){animation-delay:.25s}
section.reveal:nth-of-type(5){animation-delay:.32s}
@keyframes sec-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.reveal{animation:none}header .logo,.cta{transition:none}header a:hover .logo,.cta:hover{transform:none}}
`;

function langBar(lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${landingUrl(l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates() {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(landingUrl(l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(landingUrl("en"))}" />`);
  return links.join("\n    ");
}

/**
 * 三张演示图，插在「如何传输」的步骤后面。
 *
 * 只有本地化落地页有这一块，英文首页没有——`/` 上读者已经身处真实应用，在真界面上方
 * 放同一界面的截图既冗余又白付 LCP 成本。落地页是唯一一处读者还没见过产品的地方。
 *
 * 图是按语言各出一套的（`e2e/landing-shots.mjs --lang`）。英文截图配中文页，和英文
 * /pricing 配中文页脚是同一类缺陷。
 *
 * 只出浅色一套：为了给深色模式再出一套要把资产翻倍到 48 张、生成时间翻倍，而收益只是
 * 少一点亮度落差。改为给图加中性边框和留白，让它在深色页面上也站得住。
 */
const SHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "shots");

/** PNG 的宽高就在 IHDR 里（16..24 字节）。读它是为了写死 width/height 属性——
 *  各语言的文字长度不同，图的尺寸也就不同，缺了尺寸首屏会抖。 */
function pngSize(file) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const SHOT_FILES = ["01-devices.png", "02-confirm.png", "03-done.png"];

function shotsHtml(lang, captions) {
  if (!captions?.length) return "";
  const figures = SHOT_FILES.map((file, i) => {
    const { w, h } = pngSize(join(SHOTS_DIR, lang, file));
    const cap = captions[i] ?? "";
    return (
      `<figure><img src="/shots/${lang}/${file}" width="${w}" height="${h}" loading="lazy" decoding="async"` +
      ` alt="${esc(cap)}" /><figcaption>${esc(cap)}</figcaption></figure>`
    );
  }).join("");
  return `\n      <div class="shots">${figures}</div>`;
}

export function renderLandingPage({ lang, doc, articleLinks = [], categories = null, guidesHeading = null }) {
  const canonical = absUrl(landingUrl(lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebApplication", "SoftwareApplication"],
        name: SITE.name,
        url: canonical,
        description: doc.description,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        inLanguage: BCP47[lang],
      },
      {
        "@type": "FAQPage",
        inLanguage: BCP47[lang],
        mainEntity: doc.faq.items.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  const steps = doc.how.steps.map((s) => `<li>${esc(s)}</li>`).join("\n        ");
  const why = doc.why.items
    .map((it) => `<li><b>${esc(it.title)}</b> — ${esc(it.desc)}</li>`)
    .join("\n        ");
  const compare = doc.compare.items
    .map((it) => `<h3>${esc(it.title)}</h3>\n      <p>${esc(it.body)}</p>`)
    .join("\n      ");
  const faq = doc.faq.items
    .map((it) => `<h3>${esc(it.q)}</h3>\n      <p>${esc(it.a)}</p>`)
    .join("\n      ");
  /**
   * 深入了解：分组精选，而不是 37 条平铺。
   *
   * 原来这里把全部文章一条挨一条列出来。37 条无层级的链接对读者约等于 0 条——没有任何
   * 信号告诉他该点哪一个，而这一节又正好是落地页的最后一屏。现在按 slug 前缀分成教程 /
   * 操作指南 / 对比三组，每组只出前几条，后面接一个通往指南索引的「查看全部」。
   *
   * 分类标题复用 guides-index 里已经翻译好的那三个词，不在落地页再造一份译文。
   * 拿不到分类标题时（调用方没传）退回原来的平铺列表，而不是渲染出一个没有标题的分组。
   */
  const PER_GROUP = 5;
  const GROUP_OF = { "guides/": "guides", "how-to/": "howTo", "compare/": "compare" };
  const grouped = categories
    ? ["guides", "howTo", "compare"].map((key) => ({
        key,
        heading: categories[key],
        items: articleLinks
          .filter((a) => GROUP_OF[Object.keys(GROUP_OF).find((p) => a.slug.startsWith(p)) ?? ""] === key)
          .slice(0, PER_GROUP),
      })).filter((g) => g.heading && g.items.length)
    : [];
  const learn = !articleLinks.length
    ? ""
    : grouped.length
      ? `<h2>${esc(doc.learnHeading)}</h2>\n      <div class="learn-groups">${grouped
          .map((g) =>
            `<div><h3>${esc(g.heading)}</h3><ul class="learn">${g.items
              .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
              .join("")}</ul></div>`,
          )
          .join("")}</div>` +
        `\n      <p class="learn-all"><a href="${urlPath("guides", lang)}">${esc(guidesHeading ?? GUIDES_LABELS[lang])}</a></p>` +
        `\n      <p class="close-cta"><a class="cta" href="${ctaHref(lang)}">${esc(doc.hero.cta)}</a></p>`
      : `<h2>${esc(doc.learnHeading)}</h2>\n      <ul class="learn">${articleLinks
          .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
          .join("")}</ul>`;

  // Bidi-isolated for RTL locales: the head is read by browser chrome and search
  // engines, which resolve direction from the first strong character rather than
  // from the page's dir="rtl". See rtlHead() in shared.mjs.
  const headTitle = esc(rtlHead(lang, doc.title));
  const headDesc = esc(rtlHead(lang, doc.description));

  return `<!doctype html>
<html lang="${BCP47[lang]}"${dirAttr(lang)}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${headTitle}</title>
    <meta name="description" content="${headDesc}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates()}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${headTitle}" />
    <meta property="og:description" content="${headDesc}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    ${OG_IMAGE_META}
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${headTitle}" />
    <meta name="twitter:description" content="${headDesc}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo" aria-hidden="true">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      ${langBar(lang)}
      <!-- The language bar and the footer are navigation, so the main landmark
           starts after them: a screen-reader user jumping to the main content
           should land on this page's own words, not on a row of language links. -->
      <main>
      <h1>${esc(doc.hero.h1)}</h1>
      <p class="pitch">${esc(doc.hero.pitch)}</p>
      <a class="cta" href="${ctaHref(lang)}">${esc(doc.hero.cta)}</a>

      <section class="reveal">
      <h2>${esc(doc.how.heading)}</h2>
      <ol class="steps">
        ${steps}
      </ol>${shotsHtml(lang, doc.how.shots)}
      </section>

      <section class="reveal">
      <h2>${esc(doc.why.heading)}</h2>
      <ul class="why">
        ${why}
      </ul>
      </section>

      <section class="reveal">
      <h2>${esc(doc.compare.heading)}</h2>
      <div class="compare">
      ${compare}
      </div>
      </section>

      <section class="reveal">
      <h2>${esc(doc.faq.heading)}</h2>
      ${faq}
      </section>

      ${learn ? `<section class="reveal">${learn}</section>` : ""}
      </main>
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(doc.footer.privacy)}</a>
        <a href="${urlPath("terms", lang)}">${esc(doc.footer.terms)}</a>
        <a href="${urlPath("security", lang)}">${esc(doc.footer.security)}</a>
        <a href="${PRICING_URL}">${esc(pricingLabel(lang))}</a>
        <a href="${urlPath("releases", lang)}">${esc(RELEASES_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
