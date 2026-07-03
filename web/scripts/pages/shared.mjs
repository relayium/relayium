// web/scripts/pages/shared.mjs — constants + pure path/url/escape helpers.
export const LANGS = ["en", "zh", "ja", "ko", "de", "fr"];
export const DEFAULT_LANG = "en";

export const LANG_LABELS = {
  en: "English", zh: "中文", ja: "日本語", ko: "한국어", de: "Deutsch", fr: "Français",
};
export const BCP47 = { en: "en", zh: "zh-Hans", ja: "ja", ko: "ko", de: "de", fr: "fr" };

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
export const LANDING_LANGS = ["zh", "ja", "ko", "de", "fr"];

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
