// Lightweight, dependency-free i18n for the Relayium SPA, driven by Svelte 5 runes.
// The current language lives in module-level $state; components read
// `messages[lang()]` inside a $derived/template and re-render on a language change.
//
// Language tables are code-split: only the languages a user actually views are
// fetched (see loaders below), so the initial bundle carries none of them. The
// bootstrap in main.ts awaits the detected language before the first render, and
// setLang() loads a target before switching, so `messages[current]` is never
// undefined at render time.
import type { Lang, Messages } from "./i18n/types";
import { LANGS } from "./i18n/types";

export type { Lang, Messages, StatusKey } from "./i18n/types";
export { LANGS, legalUrl, pageUrl } from "./i18n/types";

// Dynamic imports become separate chunks — one per language.
const loaders: Record<Lang, () => Promise<{ default: Messages }>> = {
  zh: () => import("./i18n/zh"),
  en: () => import("./i18n/en"),
  ja: () => import("./i18n/ja"),
  ko: () => import("./i18n/ko"),
  de: () => import("./i18n/de"),
  fr: () => import("./i18n/fr"),
};

// Reactive table of the languages loaded so far. Typed as a full Record — not
// Partial — so components keep reading `messages[lang()]` as a non-null Messages;
// the load-before-switch invariant (main.ts bootstrap + setLang) guarantees the
// current language's entry is present before it's read.
export const messages = $state<Record<Lang, Messages>>({} as Record<Lang, Messages>);
const loaded = new Set<Lang>();

/** Ensure a language's table is loaded into `messages`. Idempotent. */
export async function loadLang(l: Lang): Promise<void> {
  if (loaded.has(l)) return;
  const mod = await loaders[l]();
  messages[l] = mod.default;
  loaded.add(l);
}

const STORAGE_KEY = "relayium-lang";
// Validate detected language codes against this static set (not `messages`, which
// is populated lazily) so a not-yet-loaded language still resolves.
const CODES = new Set<string>(LANGS.map((x) => x.code));

export function detect(search?: string): Lang {
  const s = search ?? (typeof location !== "undefined" ? location.search : "");
  try {
    const q = new URLSearchParams(s).get("lang");
    if (q && CODES.has(q)) return q as Lang;
  } catch { /* malformed search — fall through */ }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // A static code set (not a prototype-reachable key like "toString") — so a
    // poisoned value can't resolve and white-screen the app.
    if (saved && CODES.has(saved)) return saved as Lang;
  } catch { /* storage may be unavailable */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  for (const code of ["zh", "ja", "ko", "de", "fr"] as Lang[]) {
    if (nav.startsWith(code)) return code;
  }
  return "en";
}

let current = $state<Lang>(detect());

/** Reactive read of the current language. */
export function lang(): Lang {
  return current;
}

/** Switch language. Loads the target's table first so a component never reads an
 *  unloaded entry; the visible language changes once it's ready. */
export async function setLang(l: Lang): Promise<void> {
  await loadLang(l);
  current = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
