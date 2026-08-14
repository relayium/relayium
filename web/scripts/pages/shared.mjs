// web/scripts/pages/shared.mjs — constants + pure path/url/escape helpers.

/**
 * Every language a page is GENERATED in. Nine, unchanged.
 *
 * This is not the same question as "which languages does the product offer".
 * Since 2026-08-14 the answer to that is `MAINTAINED_LANGS` — English and
 * Simplified Chinese — and the other seven are `FROZEN_LANGS`: complete,
 * already-published translations that stay public, stay directly reachable and
 * stay in the sitemap as ARCHIVED translations. Deleting them would 404 pages
 * that are indexed, linked and still largely correct; pretending they are
 * current would tell a German reader the app speaks German. Neither is honest,
 * so they are generated, labelled and kept out of the selectors.
 */
export const LANGS = ["en", "zh", "ja", "ko", "de", "fr", "ar", "es", "pt"];
export const DEFAULT_LANG = "en";

/**
 * The languages the product maintains: complete, current, validated copy, and
 * where all new copy ships. English is the source and the fallback.
 *
 * This is the set every language selector and every hreflang cluster is built
 * from. Keep it in step with `LANGS` in src/lib/i18n/types.ts — the app and the
 * generated pages must not disagree about which languages exist, and
 * `maintained-frozen-split.test.mjs` fails when they do.
 */
export const MAINTAINED_LANGS = ["en", "zh"];

/** The seven archived locales. Generated and indexable; never selectable. */
export const FROZEN_LANGS = ["ja", "ko", "de", "fr", "ar", "es", "pt"];

/** Whether this language's copy is currently maintained. */
export function isMaintained(lang) {
  return MAINTAINED_LANGS.includes(lang);
}

/** Whether this language's pages are archived translations. */
export function isFrozen(lang) {
  return FROZEN_LANGS.includes(lang);
}

export const LANG_LABELS = {
  en: "English", zh: "中文", ja: "日本語", ko: "한국어", de: "Deutsch", fr: "Français", ar: "العربية", es: "Español", pt: "Português",
};

// Footer link label for the Guides hub, per language.
export const GUIDES_LABELS = {
  en: "Guides", zh: "使用指南", ja: "ガイド", ko: "가이드", de: "Anleitungen", fr: "Guides", ar: "الأدلة", es: "Guías", pt: "Guias",
};
// Footer link label for the Apps hub, per language.
export const APPS_LABELS = {
  en: "Apps", zh: "应用", ja: "アプリ", ko: "앱", de: "Apps", fr: "Applis", ar: "التطبيقات", es: "Apps", pt: "Apps",
};
// Footer link label for /pricing. The page itself is English-only (the plan
// tiers come from the billing API), but the label is localized like every other
// footer link — and the link has to exist somewhere in the static graph at all:
// /pricing was in the sitemap while literally no page linked to it, which is the
// definition of an orphan and a strong "Discovered - currently not indexed"
// candidate.
export const PRICING_LABELS = {
  en: "Pricing", zh: "定价", ja: "料金", ko: "요금제", de: "Preise", fr: "Tarifs", ar: "الأسعار", es: "Precios", pt: "Preços",
};
/** The /pricing URL. English-only, an SPA route, so no trailing slash. */
export const PRICING_URL = "/pricing";
/**
 * The label for the /pricing link.
 *
 * This used to append "(in English)" in every non-English locale, on the premise
 * that the pricing page was English-only. That premise was wrong at the time:
 * the page is a client-rendered SPA route whose copy comes from i18n, and every
 * locale then carried a full pricingPage block. Fetching /pricing with curl
 * shows English because that is the shell, not because that is what a reader
 * sees. So the hint told Chinese readers their own fully-translated page was in
 * a language they might not read — a worse defect than the one it fixed.
 *
 * It stays gone after the 2026-08-14 language freeze, and the reasoning is now
 * split in two. For English and Chinese nothing changed: the SPA renders
 * /pricing in both, so the label is just the label. For the seven archived
 * locales the premise HAS become true — a reader clicking 料金 on /ja/privacy/
 * lands on an English page — but the answer is not seven per-link suffixes.
 * Every archived page carries one archived-translation notice (archiveNotice
 * below) saying, in that reader's own language, that the product and its
 * current documentation are English and Chinese. One disclosure covers every
 * link on the page, which is what "minimal and centralized" means here; seven
 * copies of it, one per footer entry, would be neither.
 */
export function pricingLabel(lang) {
  return PRICING_LABELS[lang];
}
// Footer link label for /releases/, per language. Matches each locale's page
// title in content/releases.mjs — a footer that calls the page one thing and the
// page itself another is the drift GLOSSARY.md exists to stop.
export const RELEASES_LABELS = {
  en: "Releases", zh: "版本发布记录", ja: "リリース", ko: "릴리스", de: "Versionen", fr: "Versions", ar: "الإصدارات", es: "Versiones", pt: "Versões",
};
export const BCP47 = { en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", de: "de", fr: "fr", ar: "ar", es: "es", pt: "pt" };
// Open Graph wants language_TERRITORY with an underscore, not BCP47.
export const OG_LOCALE = { en: "en_US", zh: "zh_CN", ja: "ja_JP", ko: "ko_KR", de: "de_DE", fr: "fr_FR", ar: "ar_AR", es: "es_ES", pt: "pt_BR" };

// Right-to-left languages. Only these emit a dir="rtl" attribute on <html>; every
// other language inherits the document default (ltr), so their markup is unchanged.
export const RTL_LANGS = new Set(["ar"]);
/** The dir attribute (with a leading space) for a page's <html>, or "" for LTR. */
export function dirAttr(lang) {
  return RTL_LANGS.has(lang) ? ' dir="rtl"' : "";
}

/**
 * A head string (title, description, og:*, twitter:*) with RTL base direction
 * forced when an RTL locale's copy happens to open with a Latin word.
 *
 * `dir="rtl"` on <html> only governs what the page renders. A <title> is read by
 * the browser chrome and by search engines, which resolve direction from the
 * FIRST STRONG CHARACTER instead — so "Relayium مقابل Snapdrop… آمن؟" resolves
 * LTR and puts the Arabic question mark on the wrong end, in the browser tab and
 * in the search result. U+200F in front is one invisible strong-RTL character
 * that settles it. GLOSSARY.md records the rule; the SPA tables already follow
 * it (see `titleDefault` in i18n/ar.ts) and the generated pages did not.
 *
 * Deliberately narrow: only RTL locales, only copy that opens with a Latin
 * letter, and only when the string actually contains RTL text — a title with no
 * Arabic in it has no bidi problem to solve. It is applied to the head only, so
 * structured data and the visible <h1> (already inside a dir="rtl" document)
 * stay byte-for-byte the author's string.
 */
export function rtlHead(lang, text) {
  if (!RTL_LANGS.has(lang) || !/^[A-Za-z]/.test(text)) return text;
  return /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(text) ? "‏" + text : text;
}

export const SITE = { origin: "https://relayium.com", name: "Relayium" };

/** The one social preview image, as the absolute URL every unfurler needs. */
export const OG_IMAGE = SITE.origin + "/og-image.jpg";

// The companions to og:image. Dimensions are not decoration: LinkedIn (and a few
// other unfurlers) drop an image whose size they would have to fetch the file to
// learn, so a card that renders fine on X/Slack silently loses its image there.
// index.html already emitted these; the generated templates did not.
export const OG_IMAGE_META = `<meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Relayium — end-to-end encrypted file and text transfer" />`;

export function pagePath(slug, lang) {
  return lang === DEFAULT_LANG ? `${slug}/index.html` : `${lang}/${slug}/index.html`;
}
// Two kinds of slug have no generated <slug>/index.html in English, so the origin
// serves both slash-less from a per-route SPA shell. They are declared separately
// and unioned below rather than listed twice, so a new one is registered in
// exactly one place.
//
// Kind 1: mode routes. English is the SPA; buildModePages generates a localized
// static twin for every LANDING_LANGS language (/zh/apps/, …).
export const MODE_SLUGS = new Set(["cross-network", "offline-transfer", "apps"]);

// Kind 2: English-only SPA pages. This is about generated PAGES, not
// about translation: the SPA itself renders /pricing and /cli in all nine
// languages from src/lib/i18n/*.ts (see the pricingLabel note above). What these
// three lack is a localized static twin — buildModePages generates /<lang>/apps/
// et al. for LANDING_LANGS, but nothing generates /<lang>/pricing/. So
// /zh/pricing/ is a 404, and asking urlPath() for one is a bug, not a URL:
// hreflang or an internal link built from it would point at nothing. Throwing
// keeps that unrepresentable instead of silently emitting a dead URL — which is
// the same class of mistake as the trailing-slash one above.
export const NO_LOCALIZED_TWIN_SLUGS = new Set(["pricing", "cli", "device-inbox"]);

// The union: every slug whose ENGLISH URL must not carry a trailing slash. Keep
// MODE_SLUGS in sync with the `modes` list in gen-pages.mjs and NO_LOCALIZED_TWIN_SLUGS
// with its `SPA_PAGES` list; buildSitemap asserts both.
//
// NO_LOCALIZED_TWIN_SLUGS was missing here until 2026-08-10. urlPath() therefore reported
// /pricing/ — a URL the origin 301s away — and the sitemap escaped emitting it
// only because gen-pages.mjs passed a hardcoded literal path that never went
// through urlPath() at all. That is the same duplicate-source-of-truth shape
// that put ~390 URLs in Search Console's "Page with redirect" bucket.
export const SPA_ONLY_EN_SLUGS = new Set([...MODE_SLUGS, ...NO_LOCALIZED_TWIN_SLUGS]);

// Every generated page is written to <slug>/index.html, and the origin 301s the
// slash-less form to the slashed one. So generated URLs MUST carry the trailing
// slash — otherwise canonical/hreflang/sitemap all point at a redirect, which is
// what put ~390 URLs in Search Console's "Page with redirect" bucket. The English
// SPA-only routes are the exception: they have no directory, serve 200 slash-less,
// and would 404-to-SPA-shell if we invented a slashed form for them.
export function urlPath(slug, lang) {
  if (lang === DEFAULT_LANG) return SPA_ONLY_EN_SLUGS.has(slug) ? `/${slug}` : `/${slug}/`;
  if (NO_LOCALIZED_TWIN_SLUGS.has(slug)) {
    throw new Error(
      `urlPath: "${slug}" has no localized static page, so /${lang}/${slug}/ is a 404. ` +
        `(The SPA itself does render it in all nine languages — this is about generated pages, not translation.) ` +
        `Link to /${slug} instead, or generate a localized page first and drop the slug from NO_LOCALIZED_TWIN_SLUGS.`
    );
  }
  return `/${lang}/${slug}/`;
}
export function absUrl(path) {
  return SITE.origin + path;
}
export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── The archived-translation disclosure ──
//
// One notice, one place, seven languages. It exists because "keep the page
// public" and "do not imply the language is supported" are both requirements,
// and a page that satisfies only the first is a German reader following German
// instructions into an app that no longer speaks German.
//
// It is deliberately the ONLY new copy written in a frozen language. Everything
// else on these pages is the translation that was already published and
// reviewed; this is a status disclosure, not product copy, which is why it is
// centralized here rather than folded into each document's own text.
//
// What it must convey, in the reader's own language, in one screenful:
//
//   1. this page is an archive, not the current documentation;
//   2. the product is maintained in English and Simplified Chinese, and the app
//      itself no longer offers this language — so what is described here may
//      differ from what the reader will see;
//   3. where the current version of THIS page is, in both maintained languages.
//
// Point 3 is what makes it more than a warning. A notice that says "this may be
// out of date" and stops has told the reader their next click is a guess.
const ARCHIVE_COPY = {
  ja: {
    label: "アーカイブされた翻訳",
    body:
      "このページは記録として残している日本語訳です。Relayium の製品と最新のドキュメントは英語と簡体字中国語で管理されており、アプリ自体も日本語を提供していません。ここに書かれている画面表示や細部は、現在の動作と異なる場合があります。",
    lead: "最新版",
  },
  ko: {
    label: "보관된 번역",
    body:
      "이 페이지는 기록으로 보관 중인 한국어 번역입니다. Relayium 제품과 최신 문서는 영어와 중국어 간체로 관리되며, 앱 자체도 더 이상 한국어를 제공하지 않습니다. 여기에 적힌 화면과 세부 사항은 현재 동작과 다를 수 있습니다.",
    lead: "최신 버전",
  },
  de: {
    label: "Archivierte Übersetzung",
    body:
      "Diese Seite ist eine archivierte deutsche Übersetzung. Produkt und aktuelle Dokumentation von Relayium werden auf Englisch und in vereinfachtem Chinesisch gepflegt; die App selbst bietet kein Deutsch mehr an. Beschriebene Bildschirme und Details können deshalb vom heutigen Verhalten abweichen.",
    lead: "Aktuelle Fassung",
  },
  fr: {
    label: "Traduction archivée",
    body:
      "Cette page est une traduction française archivée. Le produit Relayium et sa documentation à jour sont maintenus en anglais et en chinois simplifié ; l'application elle-même ne propose plus le français. Les écrans et les détails décrits ici peuvent donc différer du comportement actuel.",
    lead: "Version à jour",
  },
  ar: {
    label: "ترجمة مؤرشفة",
    body:
      "هذه الصفحة ترجمة عربية محفوظة للأرشيف. يجري صيانة منتج Relayium وتوثيقه الحالي بالإنجليزية والصينية المبسّطة، ولم يعد التطبيق نفسه يوفّر العربية. لذلك قد تختلف الشاشات والتفاصيل الموصوفة هنا عن السلوك الحالي.",
    lead: "النسخة الحالية",
  },
  es: {
    label: "Traducción archivada",
    body:
      "Esta página es una traducción al español archivada. El producto Relayium y su documentación actual se mantienen en inglés y en chino simplificado; la propia aplicación ya no ofrece español. Por eso las pantallas y los detalles descritos aquí pueden diferir del comportamiento actual.",
    lead: "Versión actual",
  },
  pt: {
    label: "Tradução arquivada",
    body:
      "Esta página é uma tradução em português arquivada. O produto Relayium e sua documentação atual são mantidos em inglês e em chinês simplificado; o próprio aplicativo não oferece mais português. Por isso as telas e os detalhes descritos aqui podem diferir do comportamento atual.",
    lead: "Versão atual",
  },
};

/**
 * The separator between the "current version" lead and the two links, including
 * whatever spacing that language's typography wants after it.
 *
 * The French entry — and the one before ";" in ARCHIVE_COPY.fr — is U+00A0, not
 * a plain space: French typography requires a no-break space before ":" and
 * ";", and a plain one lets the mark wrap alone onto the next line. GLOSSARY.md
 * settles it; register-glossary.test.mjs enforces it on the page corpus.
 */
const ARCHIVE_COLON = { fr: " : ", ja: "：", ko: ": ", de: ": ", ar: ": ", es: ": ", pt: ": " };

/**
 * The archived-translation notice for a frozen page, or "" for a maintained one.
 *
 * `twins` is `{ en, zh }` — the URL of the SAME page in each maintained
 * language. Passing the URLs in rather than deriving them here keeps this
 * function ignorant of the six different URL shapes the templates own
 * (`landingUrl`, `urlPath`, the slash-less SPA routes), which is the mistake
 * that would produce a notice linking to a 404.
 *
 * The two link labels are endonyms and are NOT translated: "English" and "中文"
 * are what a reader looking for their own language scans for. They carry `lang`
 * and `hreflang` so a screen reader switches voice, and `<bdi>` so the Arabic
 * page does not reorder two Latin/CJK runs around their separator.
 */
export function archiveNotice(lang, twins) {
  const copy = ARCHIVE_COPY[lang];
  if (!copy) return "";
  if (!twins?.en || !twins?.zh) {
    throw new Error(`archiveNotice: ${lang} needs both maintained twins, got ${JSON.stringify(twins)}`);
  }
  const links =
    `<a href="${twins.en}" lang="en" hreflang="en"><bdi>English</bdi></a>` +
    ` <span aria-hidden="true">·</span> ` +
    `<a href="${twins.zh}" lang="zh-Hans" hreflang="zh-Hans"><bdi>中文</bdi></a>`;
  return (
    `<aside class="archived" aria-label="${esc(copy.label)}">` +
    `<p class="archived-label">${esc(copy.label)}</p>` +
    `<p>${esc(copy.body)}</p>` +
    // The separator carries its own trailing space (or, for Japanese, does not:
    // a full-width "：" already sets its own spacing and a space after it reads
    // as a gap).
    `<p class="archived-links">${esc(copy.lead)}${ARCHIVE_COLON[lang]}${links}</p>` +
    `</aside>`
  );
}

/**
 * Styling for the notice, appended to a template's inlined stylesheet only on
 * the pages that render one. Uses the four tokens every template declares, so
 * it inherits each one's light/dark scheme instead of carrying its own.
 */
export const ARCHIVE_STYLE = `
.archived{margin:20px 0 8px;padding:14px 16px;border:1px solid var(--border);border-inline-start:3px solid var(--accent-fg);border-radius:10px;background:var(--card);font-size:14.5px}
.archived p{margin:6px 0}.archived p:first-child{margin-top:0}.archived p:last-child{margin-bottom:0}
.archived-label{color:var(--text-h);font-weight:600}
.archived-links a{color:var(--accent-fg);text-decoration:underline;text-underline-offset:2px}
`;

// ── Landing-page helpers ──
// The English homepage is the SPA at "/"; static landing pages exist only for
// the other languages, at "/<lang>/".
export const LANDING_LANGS = ["zh", "ja", "ko", "de", "fr", "ar", "es", "pt"];

export function landingUrl(lang) {
  return lang === DEFAULT_LANG ? "/" : `/${lang}/`;
}

export function landingPath(lang) {
  if (lang === DEFAULT_LANG) throw new Error("landingPath: the en homepage is the SPA, not a generated page");
  return `${lang}/index.html`;
}

/**
 * Where a page's "open the app" CTA points: the SPA, pre-set to this language.
 *
 * A frozen page sends the reader to the plain "/" with no `lang` parameter. The
 * app resolves `?lang=ja` to English anyway (see resolveLang in
 * src/lib/i18n/types.ts), so carrying it would be a parameter that promises a
 * language and delivers another — and worse than useless: it would OVERRIDE the
 * reader's own browser language, so a Chinese speaker reading the archived
 * Japanese page would land in English instead of Chinese. Dropping it lets
 * normal detection do its job.
 */
export function ctaHref(lang) {
  if (lang === DEFAULT_LANG || isFrozen(lang)) return "/";
  return `/?lang=${lang}`;
}

/** Throw (fail the build) when a doc is missing any required translation. */
export function validateLangs(name, langs, expected = LANGS) {
  const missing = expected.filter((l) => !langs[l]);
  if (missing.length) throw new Error(`${name}: missing translations: ${missing.join(", ")}`);
}
