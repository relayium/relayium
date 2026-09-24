// Keeps the browser's `theme-color` (the mobile address bar / PWA title bar) on
// the surface the page is actually painting.
//
// index.html ships two static tags keyed on `prefers-color-scheme`, both naming
// the site's `--bg`. That is the right no-JS fallback and stays untouched in the
// served HTML, but it is wrong for the running app in three ways a browser
// measured: the shell routes paint `--shell-content` (narrow) or `--shell-win`
// (≥1180px) instead of `--bg`, and a manual light/dark choice that disagrees
// with the OS leaves the OS-matching tag naming the other theme.
//
// The colour is not duplicated here. app.css derives `--browser-surface` from
// the same tokens `body` paints, under the same selectors and breakpoint, and
// this module only reads it back. Custom properties are not registered, so the
// read is the TARGET palette even during the `.theme-anim` cross-fade, never an
// interpolated mid-transition colour.
//
// Every existing tag receives the same colour (their `media` attributes stay,
// so the no-JS contract of the served HTML is unchanged): whichever one the
// browser selects is then correct regardless of whether the OS agrees with the
// manual choice. Dispose restores the tags' original content.

export interface BrowserThemeColorEnv {
  doc?: Document;
  win?: Window;
  /** Reads the current surface; defaults to `--browser-surface` on <html>. */
  readSurface?: () => string;
}

export const SURFACE_PROPERTY = "--browser-surface";

export function startBrowserThemeColor(env: BrowserThemeColorEnv = {}): () => void {
  const doc = env.doc ?? (typeof document === "undefined" ? undefined : document);
  const win = env.win ?? doc?.defaultView ?? undefined;
  if (!doc || !win) return () => {};
  const root = doc.documentElement;
  const readSurface =
    env.readSurface ?? (() => win.getComputedStyle(root).getPropertyValue(SURFACE_PROPERTY).trim());

  let metas = Array.from(doc.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const originals = metas.map((m) => m.getAttribute("content"));
  let created: HTMLMetaElement | null = null;
  if (metas.length === 0) {
    created = doc.createElement("meta");
    created.name = "theme-color";
    doc.head.appendChild(created);
    metas = [created];
  }

  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const colour = readSurface();
    // Empty means the stylesheet has not applied (or lacks the token): keep
    // whatever the tags already say rather than blanking the address bar.
    if (!colour) return;
    for (const m of metas) {
      if (m.getAttribute("content") !== colour) m.setAttribute("content", colour);
    }
  };

  // Manual theme (`data-theme`) and the shell-route class both land on <html>.
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
  // "System" follows the OS live.
  const scheme = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
  scheme?.addEventListener("change", sync);
  // The shell's breakpoint lives in app.css only; a resize re-reads the token
  // instead of repeating 1180px here.
  win.addEventListener("resize", sync);

  sync();

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    scheme?.removeEventListener("change", sync);
    win.removeEventListener("resize", sync);
    if (created) created.remove();
    else metas.forEach((m, i) => {
      const v = originals[i];
      if (v === null) m.removeAttribute("content");
      else m.setAttribute("content", v);
    });
  };
}
