// web/scripts/pages/shared.mjs — constants + pure path/url/escape helpers.
export const LANGS = ["en", "zh", "ja", "ko", "de", "fr", "ar", "es", "pt"];
export const DEFAULT_LANG = "en";

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
// Eight locales send readers to /pricing behind a localized label, and the page
// they land on is English — the plan tiers come from the billing API and there
// is no localized twin. The label alone promises otherwise, so it carries the
// warning in the reader's own language. English gets no suffix: there is nothing
// to warn an English reader about.
const PRICING_ENGLISH_HINT = {
  en: "", zh: "（英文）", ja: "（英語）", ko: " (영문)", de: " (englisch)",
  fr: " (en anglais)", ar: " (بالإنجليزية)", es: " (en inglés)", pt: " (em inglês)",
};
/** The /pricing footer label for a language, warning when the page is not in it. */
export function pricingLabel(lang) {
  return PRICING_LABELS[lang] + PRICING_ENGLISH_HINT[lang];
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
// Slugs that have no generated <slug>/index.html in English — they are SPA routes
// (see LANDING_LANGS: mode pages are built for every language *except* en). Keep
// this in sync with the `modes` list in gen-pages.mjs; buildSitemap asserts it.
export const SPA_ONLY_EN_SLUGS = new Set(["cross-network", "offline-transfer", "apps"]);

// Every generated page is written to <slug>/index.html, and the origin 301s the
// slash-less form to the slashed one. So generated URLs MUST carry the trailing
// slash — otherwise canonical/hreflang/sitemap all point at a redirect, which is
// what put ~390 URLs in Search Console's "Page with redirect" bucket. The English
// SPA-only routes are the exception: they have no directory, serve 200 slash-less,
// and would 404-to-SPA-shell if we invented a slashed form for them.
export function urlPath(slug, lang) {
  if (lang === DEFAULT_LANG) return SPA_ONLY_EN_SLUGS.has(slug) ? `/${slug}` : `/${slug}/`;
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

/** Where a page's "open the app" CTA points: the SPA, pre-set to this language. */
export function ctaHref(lang) {
  return lang === DEFAULT_LANG ? "/" : `/?lang=${lang}`;
}

/** Throw (fail the build) when a doc is missing any required translation. */
export function validateLangs(name, langs, expected = LANGS) {
  const missing = expected.filter((l) => !langs[l]);
  if (missing.length) throw new Error(`${name}: missing translations: ${missing.join(", ")}`);
}
