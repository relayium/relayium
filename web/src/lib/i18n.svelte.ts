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
import { resolveLang } from "./i18n/types";

export type { Lang, FrozenLang, AnyLang, Messages, StatusKey } from "./i18n/types";
export { LANGS, FROZEN_LANGS, isMaintainedLang, isFrozenLang, resolveLang, legalUrl, pageUrl } from "./i18n/types";

// Dynamic imports become separate chunks — one per language.
//
// Two entries, not nine. The seven frozen locales are not merely unselectable:
// there is no loader for them, so no bundle, no precache entry and no network
// request for a language the product does not maintain. Their former tables are
// archived under ./i18n/archive/ (see that directory's README).
const loaders: Record<Lang, () => Promise<{ default: Messages }>> = {
  zh: () => import("./i18n/zh"),
  en: () => import("./i18n/en"),
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

// Right-to-left languages. Kept as a plain string set (not keyed to the Lang
// union) so document direction can be resolved independently of, and before,
// a language is registered.
//
// Arabic is retained here even though `ar` is no longer a runtime language:
// dir() answers for any tag, the archived Arabic static pages still render
// dir="rtl", and a function that started returning "ltr" for "ar" would be
// wrong rather than simplified. It just never fires on a maintained language.
const RTL = new Set<string>(["ar"]);

/** The `dir` a language should render in. LTR for everything but Arabic. */
export function dir(l: string): "rtl" | "ltr" {
  return RTL.has(l) ? "rtl" : "ltr";
}

const STORAGE_KEY = "relayium-lang";

/**
 * Which maintained language to start in.
 *
 * Precedence is unchanged — explicit `?lang=`, then the saved preference, then
 * the browser — but each step now goes through `resolveLang()` instead of an
 * exact match against a nine-code set. That is what carries a reader across the
 * language freeze: `?lang=ja` and a saved `"ja"` used to select a table that no
 * longer exists, and would now be a white screen rather than a fallback. They
 * resolve to English, which is the declared fallback, and `zh-TW`/`zh-Hans`
 * resolve to Chinese from all three sources rather than only from the browser.
 *
 * A saved frozen code is also rewritten in place. Leaving it would be harmless
 * on every read — it resolves to English every time — but it would keep a
 * preference the reader can no longer see or change, and it would make the
 * next person to read this storage key believe the app still has nine tables.
 */
export function detect(search?: string): Lang {
  const s = search ?? (typeof location !== "undefined" ? location.search : "");
  let q: string | null = null;
  try {
    q = new URLSearchParams(s).get("lang");
  } catch { /* malformed search — fall through */ }
  if (q) return resolveLang(q);

  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch { /* storage may be unavailable */ }
  if (saved) {
    const resolved = resolveLang(saved);
    // Migrate a pre-freeze preference (or a poisoned value) to what it now
    // means. Best-effort: storage can be full or blocked, and a failed rewrite
    // must not change what this function returns.
    if (saved !== resolved) {
      try { localStorage.setItem(STORAGE_KEY, resolved); } catch { /* ignore */ }
    }
    return resolved;
  }

  return resolveLang(typeof navigator !== "undefined" ? navigator.language : "en");
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
  if (typeof document !== "undefined") {
    document.documentElement.lang = l;
    document.documentElement.dir = dir(l);
  }
}
