// web/scripts/pages/page-chrome.mjs — the one visual system the six static
// templates share: design tokens, base typography, site chrome (header +
// footer) and the small set of primitives their content uses.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Until 2026-09-21 each template carried its own hand-written inline <style>.
// The four blocks shared nine colour variables and nothing else: no surface
// hierarchy, no radius, no spacing scale, no button system, their own type
// scales, and a `<span class="logo">⇌</span>` text glyph where the product has
// a drawn mark. Next to `/` — which renders the owner reference's settings
// shell out of `src/app.css` — the generated tree read as a different product.
// Four copies also meant a fix had to be made four times, which is why the
// drift happened in the first place.
//
// ── What is unified, and what deliberately is not ───────────────────────────
// UNIFIED, because these are what make two pages read as one product:
//   · the surface hierarchy (window → content → card) and its borders and
//     separators, taken from `Relayium 设计规范` §3 exactly as `src/app.css`
//     takes them;
//   · accent discipline — §3's "紫色只出现在三处". The old templates painted
//     EVERY link with the accent, so a guides hub was a wall of purple. Here
//     the accent is the primary action, the current-page marker, and an inline
//     link inside a paragraph (which has to be separable from the sentence
//     around it); list links are `--text-h` and go accent on hover, exactly as
//     `PageFooter.svelte` already does in the app;
//   · flat accent fills. The reference has no gradient anywhere, and a flat
//     fill is also the one axe can actually measure — a two-stop ramp under
//     white text reports as "incomplete", which is how an unreadable CTA hides;
//   · geometry: 11px card radius, 1px border, and the app's own two content
//     tracks. `--shell-col-w` is 660px at the shell's 15px scale; the same
//     ~68-character measure at this tree's 17px reading scale is 720px, and
//     `--shell-col-wide` (1040px) carries the guides hub's card grid;
//   · the chrome: the real brand mark, a header that names where else to go,
//     and a footer that looks like the app's.
//
// NOT unified: the type scale. `.appshell.shell` runs the reference's five
// macOS sizes (20/17/15/13/12) because it is a settings window. A 2,000-word
// guide set in 15px with a 20px h1 is a worse page, not a more consistent one,
// so the static tree keeps the site's reading scale — the same `--fs-*` token
// names, one set of values up. Everything else about the two is the same
// system.
//
// ── No copy lives here ──────────────────────────────────────────────────────
// Every word the chrome renders already exists, translated, in shared.mjs
// (`GUIDES_LABELS`, `APPS_LABELS`, `pricingLabel`) or is the product name. That
// is a hard constraint, not an accident: adding chrome copy would mean nine
// translations, and would break the 2026-08-14 freeze on the seven archived
// locales, whose wording must stay byte-for-byte what was published.
import { GUIDES_LABELS, APPS_LABELS, pricingLabel, PRICING_URL, urlPath, esc } from "./shared.mjs";

/**
 * The pre-paint theme snippet, byte-identical to the first inline <script> in
 * web/index.html.
 *
 * Byte-identical is the whole contract. nginx's CSP (relayium-ops
 * `deploy/nginx/relayium-security.conf`, included by the `location /` that
 * serves this tree) allows inline script by sha256 hash, and the hash it
 * carries is this snippet's — so an identical copy is already permitted and a
 * one-character difference is silently blocked. `theme-snippet-parity.test.mjs`
 * fails the build if the two ever drift; `csp-headers.test.mjs` keeps the nginx
 * side honest.
 *
 * It is here at all because the theme is an explicit choice in the app: a
 * reader who picks Light on `/` and then opens a guide from the footer used to
 * land on a dark page, on a dark OS, with no way to say otherwise. That is the
 * same defect class as two different card styles, and it is three lines to fix.
 * Without it (JS off, CSP mismatched, storage blocked) the page falls back to
 * `prefers-color-scheme`, which is what it did before.
 */
export const THEME_SCRIPT = `<script>
      try {
        var t = localStorage.getItem('relayium-theme');
        if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
      } catch (e) {}
    </script>`;

/**
 * The two head lines every template emits together: the theme snippet and the
 * browser-chrome colour that has to agree with what the page actually paints.
 *
 * The values are `--bg` in each scheme. They used to be `#ffffff` / `#16171d`,
 * which were the SITE's background tokens and not this tree's — on Android the
 * address bar sat a visible step away from the page under it.
 */
export const THEME_HEAD = `${THEME_SCRIPT}
    <meta name="theme-color" content="#f8f8fa" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#232326" media="(prefers-color-scheme: dark)" />`;

/**
 * The dark palette, written once and emitted into three selectors.
 *
 * Two of them are the media query and the `[data-theme="dark"]` attribute the
 * snippet above sets; the light block is guarded with
 * `:root:not([data-theme="light"])` so a reader who forced Light on a dark OS
 * gets light. This is the same three-selector shape `src/app.css` uses, for the
 * same reason — a theme that is an attribute cannot be expressed by a media
 * query alone.
 */
const DARK_TOKENS = `--text:#9ca3af;--text-h:#f3f4f6;--bg:#232326;--card:#2d2d30;--border:rgb(255 255 255/.075);--sep:rgb(255 255 255/.075);--row-hover:rgb(255 255 255/.05);--code-bg:#1e1e20;--accent:#8b6bff;--accent-fg:#bda4ff;--accent-action:#6d45f5;--accent-border:rgb(139 107 255/.42)`;

/**
 * Design tokens.
 *
 * Values are `Relayium 设计规范` §3 as `src/app.css` reads it, so a colour
 * picker on `/guides/` and on `/` returns the same numbers. Names are the
 * static tree's own (`--bg`, `--card`, `--border`) rather than the app's
 * `--shell-*`, because here there is only one palette and the extra prefix
 * would name a distinction that does not exist on these pages.
 *
 * Contrast, measured against the surface each one is actually used on
 * (`--bg` = the content pane, `--card` = a card on it):
 *   light  --text #6b6375      5.46:1 on --bg · 5.86:1 on --card
 *          --text-h #08060d   18.9:1  · 20.1:1
 *          --accent-fg #6640e6 5.75:1 · 6.10:1      white on --accent-action 6.10:1
 *   dark   --text #9ca3af      6.19:1 on --bg · 5.39:1 on --card
 *          --text-h #f3f4f6   13.5:1  · 11.8:1
 *          --accent-fg #bda4ff 7.40:1 · 5.65:1      white on --accent-action 5.53:1
 * `--accent` itself is decorative — rims, tints, the mark — and is never the
 * colour of a word. `static-landmarks.test.mjs` pins that.
 */
const TOKENS = `
:root{color-scheme:light dark;--text:#6b6375;--text-h:#08060d;--bg:#f8f8fa;--card:#ffffff;--border:rgb(0 0 0/.09);--sep:rgb(0 0 0/.075);--row-hover:rgb(0 0 0/.05);--code-bg:#f2f2f5;--accent:#6d45f5;--accent-fg:#6640e6;--accent-action:#6640e6;--accent-border:rgb(109 69 245/.42);--radius:11px;--radius-sm:8px;--col:720px;--col-wide:1040px;--fs-h1:34px;--fs-hero:42px;--fs-h2:24px;--fs-h3:18px;--fs-body:17px;--fs-sm:14px;--fs-xs:13px}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_TOKENS}}}
:root[data-theme="dark"]{${DARK_TOKENS}}
@media(max-width:1024px){:root{--fs-hero:34px;--fs-h1:29px;--fs-h2:21px;--fs-body:16px}}`;

/**
 * Base document: reset, reading typography, link ranks.
 *
 * One surface, `--bg` = the app's content pane. The app's four-step hierarchy
 * (window → sidebar → content → card) needs four real boxes to exist, and a
 * document page has two of them: the pane and the cards on it. Painting a
 * window frame around a 660px column would be inventing a distinction the page
 * does not have — which is what `:root.shell-route body` already concludes
 * below 1180px, where the whole viewport IS the content pane.
 */
const BASE = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-body)/1.65 system-ui,'Segoe UI',Roboto,sans-serif;font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.wrap{max-inline-size:var(--col);margin:0 auto;padding:0 22px 72px}
.wrap.wide{max-inline-size:var(--col-wide)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1{color:var(--text-h);font-size:var(--fs-h1);line-height:1.2;letter-spacing:-1px;margin:36px 0 8px}
h2{color:var(--text-h);font-size:var(--fs-h2);line-height:1.3;letter-spacing:-.3px;margin:40px 0 10px}
h3{color:var(--text-h);font-size:var(--fs-h3);line-height:1.4;margin:24px 0 4px}
p{margin:12px 0}
ul,ol{margin:12px 0;padding-inline-start:22px}li{margin:6px 0}
b,strong{color:var(--text-h);font-weight:600}
/* Link ranks. An inline link inside a sentence takes the accent and an
   underline, because it has to be findable mid-paragraph. Everything that is
   already a list of destinations — the guides hub, related articles, the
   footer — is heading-coloured and goes accent on hover, which is what stops a
   page of links from being a page of purple (设计规范 §3). */
a{color:var(--accent-fg)}
main p>a,main li>a{text-underline-offset:2px}
.updated{color:var(--text);font-size:var(--fs-sm);margin:0 0 8px}
.lead{font-size:calc(var(--fs-body) + 2px);color:var(--text)}`;

/**
 * Site chrome: the header band and the footer.
 *
 * The header is modelled on the app's own compact top bar (`.topnav` in
 * `Nav.svelte`) rather than on its 216px sidebar. A settings rail belongs to an
 * app with destinations; a guide read from a search result has one destination
 * — its own text — and a rail of transfer modes down the side of 447 crawled
 * pages would be navigation wearing the content's clothes. The app shows the
 * same top bar whenever the rail does not fit, so this is its form, not a
 * different one.
 */
const CHROME = `
header{display:flex;align-items:center;flex-wrap:wrap;gap:10px 20px;padding:14px 0;margin-block-end:8px;border-block-end:1px solid var(--sep)}
.brand{display:inline-flex;align-items:center;gap:8px;flex:none;color:var(--text-h);text-decoration:none;font-weight:600;font-size:16px;letter-spacing:-.4px}
.brand svg{display:block;transition:transform .25s cubic-bezier(.22,1,.36,1)}
.brand:hover svg{transform:rotate(-8deg) scale(1.08)}
.sitenav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px}
/* Pushed to the far edge only while it shares the brand's row. Once the header
   wraps — 320px, or a long wordmark in a long locale — the auto margin would park
   the links against the opposite margin on a line of their own, which reads as
   a layout accident rather than as a choice. */
@media(min-width:560px){.sitenav{margin-inline-start:auto}}
.sitenav a{color:var(--text);font-size:var(--fs-xs);text-decoration:underline 1px transparent;text-underline-offset:4px;transition:color .13s,text-decoration-color .13s}
.sitenav a:hover{color:var(--text-h);text-decoration-color:var(--accent-border)}
.sitenav a[aria-current]{color:var(--accent-fg);text-decoration-color:currentColor}
footer{margin-block-start:56px;padding-block-start:20px;border-block-start:1px solid var(--sep);display:flex;gap:10px 16px;flex-wrap:wrap;font-size:12.5px}
footer a{color:var(--text-h);text-decoration:none}
footer a:hover{color:var(--accent-fg)}
@media(pointer:coarse){.sitenav a,footer a{display:inline-flex;align-items:center;min-block-size:44px}}
@media(prefers-reduced-motion:reduce){.brand svg,.brand:hover svg,.sitenav a{transition:none;transform:none}}`;

/**
 * Content primitives, named and shaped like the app's `.ui-*` layer.
 *
 * Class names are the ones the generated tree already used (`.cta`, `.ctacard`,
 * `.langbar`, `.crumbs`), so this is a restyle and not a rename: `e2e/`
 * runners, `article-template.test.mjs` and `maintained-frozen-split.test.mjs`
 * all select on them, and a rename would have been churn charged to those files
 * for no reader-visible gain.
 */
const PRIMITIVES = `
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:18px 22px}
pre{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;overflow-x:auto;margin:16px 0}
pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--text-h);white-space:pre;line-height:1.6}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--code-bg);border-radius:4px;padding:1px 5px}
pre code{background:none;padding:0;border-radius:0}
/* The one purple fill on a content page. Flat, not a ramp: 设计规范 §3 has no
   gradient, and white on --accent-action measures 6.10:1 light / 5.53:1 dark —
   a number axe can read, which a gradient's cannot be. */
.cta{display:inline-flex;align-items:center;justify-content:center;min-block-size:44px;padding:0 22px;border-radius:var(--radius-sm);color:#fff;font-weight:600;font-size:var(--fs-sm);text-decoration:none;background:var(--accent-action);transition:filter .13s,transform .05s}
.cta:hover{filter:brightness(1.12)}
.cta:active{transform:translateY(1px)}
.langbar{display:flex;flex-wrap:wrap;gap:6px 14px;margin:14px 0 8px;font-size:var(--fs-xs)}
/* Underlined, not just coloured. Two words side by side with one of them
   heading-coloured is not an affordance — a reader cannot tell 中文 is a link
   at all. The current one loses the underline instead of gaining a colour, so
   the state survives a colour filter. */
.langbar a{color:var(--text-h);text-decoration:underline;text-decoration-color:var(--accent-border);text-underline-offset:3px}
.langbar a:hover{color:var(--accent-fg);text-decoration-color:currentColor}
.langbar a[aria-current]{color:var(--text);font-weight:600;text-decoration:none}
.crumbs{margin:16px 0 0;font-size:var(--fs-xs);color:var(--text)}
.crumbs a{color:var(--text-h);text-decoration:underline;text-underline-offset:2px}
.crumbs a:hover{color:var(--accent-fg)}
.crumbs [aria-current]{color:var(--text)}
@media(pointer:coarse){.langbar a,.crumbs a{display:inline-flex;align-items:center;min-block-size:44px}}
@media(prefers-reduced-motion:reduce){.cta{transition:none}.cta:hover,.cta:active{filter:none;transform:none}}`;

/**
 * Compose a template's stylesheet: the shared system, then whatever that one
 * template owns.
 *
 * Order matters — `extra` comes last so a template can specialise a primitive
 * without raising its specificity, which is how the old per-template blocks
 * ended up fighting each other in the first place.
 */
export function pageStyle(extra = "") {
  return `${TOKENS}${BASE}${CHROME}${PRIMITIVES}${extra}`;
}

/** Exported for the tests that assert the system's contracts directly. */
export const STYLE_PARTS = { TOKENS, BASE, CHROME, PRIMITIVES };

/**
 * The Relayium mark, kept in sync with `src/lib/Logo.svelte` and
 * `public/favicon.svg` — two arrows passing each other, drawn as strokes.
 *
 * The generated tree used to print `⇌` in a gradient square instead. That is a
 * different shape, in a different colour, from the logo in the app the page is
 * advertising; a reader who noticed would be right to wonder whether they were
 * still on the same site. `aria-hidden` because the wordmark beside it already
 * says Relayium.
 */
export function brandMark(size = 28) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="bm" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" stop-color="#a94bff" /><stop offset="1" stop-color="#635bff" /></linearGradient></defs>`
    + `<rect width="64" height="64" rx="15" fill="url(#bm)" />`
    + `<path d="M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

/**
 * The site header: the mark and wordmark, then the three places a reader of a
 * static page can usefully go next.
 *
 * `home` is passed in rather than derived because the templates already
 * disagree for a good reason — a landing or an article sends the reader to the
 * app pre-set to this page's language (`ctaHref`), while a legal page sends
 * them to `/`. That difference predates this file and is not this file's to
 * settle.
 *
 * `self` is this page's own URL and `section` the nav entry it belongs under, so
 * the guides hub does not offer a link to itself with no sign that it is where
 * you already are, and an article shows which section it sits in. Same treatment
 * as `.tool.active` in `Nav.svelte`.
 *
 * Every destination here is one the footer of these pages already linked, so
 * the internal link graph gains no new edge — `site-graph.test.mjs` keeps
 * watching that the archive is never linked from a maintained page and that no
 * link lands on a redirect.
 */
export function siteHeader({ lang, home, self = null, section = null }) {
  const items = [
    ["guides", urlPath("guides", lang), GUIDES_LABELS[lang]],
    ["apps", urlPath("apps", lang), APPS_LABELS[lang]],
    ["pricing", PRICING_URL, pricingLabel(lang)],
  ];
  // `page` and `true` are different claims and the difference is not cosmetic:
  // `aria-current="page"` says "this link is where you are", and an article page
  // that marked the Guides hub with it would announce two current pages — the
  // hub link and the breadcrumb's own leaf — neither of which is the hub. So an
  // exact URL match gets `page`, and belonging to a section gets `true`.
  const mark = (id, href) =>
    (self !== null && href === self) ? ' aria-current="page"'
      : (id === section) ? ' aria-current="true"' : "";
  const links = items
    .map(([id, href, label]) => `<a href="${href}"${mark(id, href)}>${esc(label)}</a>`)
    .join("");
  // aria-label is English in every locale, matching the language bar's
  // `aria-label="Language"` that has shipped on all nine since the tree
  // existed. Translating one landmark name and not the other would be the
  // inconsistency, and new chrome copy is exactly what this change may not add.
  return `<header><a class="brand" href="${home}">${brandMark()}<span>Relayium</span></a>`
    + `<nav class="sitenav" aria-label="Site">${links}</nav></header>`;
}
