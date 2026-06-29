// web/scripts/legal/shared.mjs — constants + pure path/url/escape helpers.
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
