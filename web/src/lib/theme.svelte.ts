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

let current = $state<Theme>(read());

/** Reactive read of the current theme choice. */
export function theme(): Theme {
  return current;
}

export function setTheme(t: Theme): void {
  current = t;
  applyTheme(t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

/** Re-assert the stored choice onto <html>. Idempotent; the inline head snippet
 *  usually did this already, so this is a belt-and-suspenders boot call. */
export function initTheme(): void {
  applyTheme(current);
}
