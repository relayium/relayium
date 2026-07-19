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

export const SITE = { origin: "https://relayium.com", name: "Relayium" };

export function pagePath(slug, lang) {
  return lang === DEFAULT_LANG ? `${slug}/index.html` : `${lang}/${slug}/index.html`;
}
export function urlPath(slug, lang) {
  return lang === DEFAULT_LANG ? `/${slug}` : `/${lang}/${slug}`;
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
