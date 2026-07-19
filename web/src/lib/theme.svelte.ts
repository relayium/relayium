// Manual light/dark theme override, on top of the default "follow the OS" behaviour.
// The choice is reflected as a `data-theme` attribute on <html> that app.css keys
// off; "system" removes the attribute so the prefers-color-scheme media query wins.
// An inline snippet in index.html applies the stored value before first paint to
// avoid a flash; this module is the reactive source of truth thereafter.

export type Theme = "system" | "light" | "dark";
const KEY = "relayium-theme";

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage unavailable */ }
  return "system";
}

/** Reflect a theme choice onto <html> (removing the attribute for "system"). */
export function applyTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

// Briefly enable a global colour transition around a theme flip so palettes
// cross-fade instead of hard-cutting. The class (see app.css `.theme-anim`)
// exists only for the switch's duration, never during normal interaction.
let animTimer: ReturnType<typeof setTimeout> | null = null;
function flashThemeTransition(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.add("theme-anim");
  if (animTimer) clearTimeout(animTimer);
  animTimer = setTimeout(() => root.classList.remove("theme-anim"), 320);
}

let current = $state<Theme>(read());

/** Reactive read of the current theme choice. */
export function theme(): Theme {
  return current;
}

export function setTheme(t: Theme): void {
  current = t;
  flashThemeTransition(); // class on <html> before the attribute change so the swap animates
  applyTheme(t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

/** Re-assert the stored choice onto <html>. Idempotent; the inline head snippet
 *  usually did this already, so this is a belt-and-suspenders boot call. */
export function initTheme(): void {
  applyTheme(current);
}
