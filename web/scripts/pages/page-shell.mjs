// web/scripts/pages/page-shell.mjs — the app's settings shell, rendered
// statically for the generated pages.
//
// ── What this is and why it exists ──────────────────────────────────────────
// `20d02e3a` gave the 447 generated pages the app's PAINT — tokens, radius,
// type scale, accent discipline — and left them with a document skeleton: a
// thin top bar, one centred column, no cards. Next to `/cli` the difference was
// immediately visible and the owner said so. The answer chosen was the full
// shell: the reference's 216px rail (`Relayium 设计规范` §1), the content pane
// behind it, and the page's own content grouped into cards.
//
// Everything here reproduces `Nav.svelte`'s `@media (min-width: 1180px)` rail
// and `App.svelte`'s `.appshell` grid, number for number. Where a value looks
// arbitrary it is the reference's: 216px rail, 28px rows with a 7px radius and
// 10px inline padding, 11px/600 group titles.
//
// ── One nav, two presentations — not two navs ───────────────────────────────
// Below 1180px the same element is a wrapping top bar; at and above it, it is
// the rail. That is how `Nav.svelte` does it, and it matters more here than it
// does in the app: a second copy of the navigation in the DOM would ship on 447
// crawled pages, giving every one of them a duplicate set of links for a reader
// who can only ever see one.
//
// ── No JavaScript, still ────────────────────────────────────────────────────
// The rail is links and CSS. The app's rail also carries a theme control; this
// one does not, because a theme switch needs a script and these pages are
// crawled documents. They are not left behind by it: `page-chrome.mjs`'s
// pre-paint snippet already applies the theme the reader chose in the app, so
// the setting follows them here even though the control does not.
import { SHELL_NAV } from "./content/shell-nav.mjs";
import { urlPath, esc, ctaHref, isFrozen } from "./shared.mjs";

/**
 * The Relayium mark, kept in sync with `src/lib/Logo.svelte` and
 * `public/favicon.svg` — two arrows passing each other, drawn as strokes.
 *
 * The generated tree printed `⇌` in a gradient square until 2026-09-21: a
 * different shape, in a different colour, from the logo in the app the page is
 * advertising. `aria-hidden` because the wordmark beside it already says
 * Relayium. It lives here rather than in page-chrome.mjs because the rail is
 * its only caller, and the two modules would otherwise import each other.
 */
export function brandMark(size = 28) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">`
    + `<defs><linearGradient id="bm" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">`
    + `<stop offset="0" stop-color="#a94bff" /><stop offset="1" stop-color="#635bff" /></linearGradient></defs>`
    + `<rect width="64" height="64" rx="15" fill="url(#bm)" />`
    + `<path d="M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

/**
 * The destinations, in the reference's own three groups plus tools.
 *
 * `href` is a function of the language because the same destination has three
 * different URL shapes: a localized static twin (`/zh/cross-network/`), an
 * English-only SPA route (`/cli`, `/device-inbox`, `/pricing`), or the app
 * itself pre-set to this language (`ctaHref`). `urlPath` already knows which is
 * which and throws on a combination that does not exist, so the wrong URL is
 * unrepresentable rather than silently a 404.
 */
const GROUPS = [
  {
    title: (t) => t.groupDirect,
    items: [
      { id: "lan", href: (l) => ctaHref(l), short: (t) => t.lan, full: (t) => t.lanFull },
      { id: "cross", href: (l) => urlPath("cross-network", l), short: (t) => t.cross, full: (t) => t.crossFull },
    ],
  },
  {
    title: (t) => t.groupLinks,
    items: [
      { id: "offline", href: (l) => urlPath("offline-transfer", l), short: (t) => t.offline, full: (t) => t.offlineFull },
    ],
  },
  {
    title: (t) => t.groupDevices,
    items: [
      { id: "device-inbox", href: () => "/device-inbox", short: (t) => t.inbox, full: (t) => t.inboxFull },
    ],
  },
  {
    title: (t) => t.groupTools,
    items: [
      { id: "cli", href: () => "/cli", short: (t) => t.cli, full: (t) => t.cli },
      { id: "apps", href: (l) => urlPath("apps", l), short: (t) => t.apps, full: (t) => t.apps },
      { id: "pricing", href: () => "/pricing", short: (t) => t.pricing, full: (t) => t.pricing },
    ],
  },
];

/**
 * One rail row.
 *
 * The visible label is the SHORT form and the accessible name is the full one,
 * exactly as `Nav.svelte` does it — and every short form is a SUBSTRING of its
 * full form in both maintained languages, which is what WCAG 2.5.3 requires of
 * a control whose visible text differs from its accessible name. The archived
 * locales have only one form, so they get no `aria-label` at all rather than
 * one that repeats the text.
 */
function row(item, lang, t, current, tool = false) {
  const short = item.short(t);
  const full = item.full(t);
  const named = full && full !== short ? ` aria-label="${esc(full)}"` : "";
  const now = item.id === current ? ' aria-current="page"' : "";
  const cls = ["row", tool ? "tool" : "dest", item.id === current ? "is-current" : ""].filter(Boolean).join(" ");
  return `<a class="${cls}" href="${item.href(lang)}"${named}${now}>${esc(short)}</a>`;
}

/**
 * The rail: brand, destinations, and (on a maintained page) the language bar.
 *
 * `foot` is whatever the template wants in the rail's bottom slot — in practice
 * the language selector, which is navigation and belongs with the rest of it.
 * An archived page passes nothing: its language slot is the archived-translation
 * notice, which is a paragraph of explanation and has no business in a 216px
 * rail, so it stays in the content where it already was.
 */
export function rail({ lang, home, current = null, foot = "" }) {
  const t = SHELL_NAV[lang];
  if (!t) throw new Error(`page-shell: no sidebar labels for ${lang}`);
  const flat = isFrozen(lang);
  const body = GROUPS.map((g, gi) => {
    const title = g.title(t);
    // The last group is "downloads and tools". Nav.svelte draws it as a
    // different RANK from the destinations — "the destinations are pills, these
    // are text links, so the header shows two ranks" — and the narrow header
    // here has to say the same thing, or seven links read as one flat list.
    const tools = gi === GROUPS.length - 1;
    // A group title exists only in en and zh. On the seven archived locales the
    // same destinations render as one ungrouped list rather than under an
    // English heading — see content/shell-nav.mjs for why that is the only
    // option the language freeze leaves.
    const head = !flat && title ? `<span class="rail-group">${esc(title)}</span>` : "";
    return head + g.items.map((i) => row(i, lang, t, current, tools)).join("");
  }).join("");
  return `<header class="rail">`
    + `<a class="brand" href="${home}">${brandMark(26)}<span>Relayium</span></a>`
    + `<nav class="railnav" aria-label="${esc(t.navLabel)}">${body}</nav>`
    + (foot ? `<div class="rail-foot">${foot}</div>` : "")
    + `</header>`;
}

/**
 * The page: rail, then the content pane and its track.
 *
 * `wide` picks the reference's decision-width track (1040px) over its reading
 * track (660px + gutter), the same choice `App.svelte` makes between
 * `--shell-col-w` and `--shell-col-wide`.
 */
export function appShell({ lang, home, current = null, foot = "", wide = false, content }) {
  return `<div class="appshell">\n      ${rail({ lang, home, current, foot })}\n`
    + `      <div class="pane"><div class="wrap${wide ? " wide" : ""}">\n${content}\n      </div></div>\n    </div>`;
}

/**
 * The shell's CSS, appended after page-chrome.mjs's base layer.
 *
 * Below 1180px the rail is a wrapping top bar and the page is one column; at
 * and above it the grid appears and the rail becomes the reference's settings
 * sidebar. No JavaScript is involved in either form.
 */
export const SHELL_CSS = `
/* ── The rail, narrow: a wrapping top bar ─────────────────────────────────── */
.rail{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 22px;border-block-end:1px solid var(--sep);background:var(--card)}
.rail .brand{display:inline-flex;align-items:center;gap:8px;flex:none;color:var(--text-h);text-decoration:none;font-weight:600;font-size:16px;letter-spacing:-.4px}
.rail .brand svg{display:block;transition:transform .25s cubic-bezier(.22,1,.36,1)}
.rail .brand:hover svg{transform:rotate(-8deg) scale(1.08)}
.railnav{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-inline-size:0}
.rail-group{display:none}
/* Two ranks, the same two Nav.svelte draws below its rail breakpoint: the four
   destinations are pills, the three tools are text links. Seven links at one
   rank read as one flat list and say nothing about what the product's main
   surfaces are. No copy is involved — it is which element gets a border. */
.row.dest{border-color:var(--border);background:var(--row-hover);border-radius:999px;padding:6px 14px;font-size:var(--fs-sm)}
.row.dest:hover{border-color:var(--accent-border)}
.row.tool{padding-inline:4px;text-decoration:underline 1px transparent;text-underline-offset:4px;font-size:var(--fs-xs)}
.row.tool:hover{background:none;text-decoration-color:var(--accent-border)}
.row.tool.is-current{background:none;color:var(--accent-fg);font-weight:600;text-decoration-color:currentColor}
.row{display:inline-flex;align-items:center;box-sizing:border-box;min-block-size:28px;padding:4px 10px;border:1px solid transparent;border-radius:7px;background:none;color:var(--text);font-size:13px;line-height:1.3;text-decoration:none;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.row:hover{background:var(--row-hover);color:var(--text-h)}
.row.is-current{font-weight:600;color:#fff;background:var(--accent-action);border-color:transparent}
.rail-foot{display:flex;align-items:center;margin-inline-start:auto}
.rail-foot .langbar{margin:0}
@media(pointer:coarse){.row{min-block-size:44px}}
@media(prefers-reduced-motion:reduce){.rail .brand svg,.rail .brand:hover svg,.row{transition:none;transform:none}}

/* Between a phone and the rail breakpoint there is still more width than a line
   of prose should use — the same reasoning, and the same 760px, as
   App.svelte's \`.appshell.shell .appshell-col\` at this width. */
@media(min-width:700px){.wrap{max-inline-size:760px}.wrap.wide{max-inline-size:var(--col-wide)}}

/* ── The rail, wide: the reference's settings sidebar ─────────────────────── */
@media(min-width:1180px){
  .appshell{display:grid;grid-template-columns:var(--shell-side-w) minmax(0,1fr);align-items:start}
  .rail{position:sticky;inset-block-start:0;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;gap:2px;inline-size:var(--shell-side-w);block-size:100svh;overflow-y:auto;padding:var(--space-4) var(--space-3);border-block-end:0;border-inline-end:1px solid var(--sep);background:var(--shell-side)}
  .rail .brand{gap:9px;padding-inline:10px;margin-block-end:var(--space-2);min-block-size:28px}
  .railnav{flex-direction:column;align-items:stretch;gap:2px;inline-size:100%}
  .rail-group{display:block;margin-block:var(--space-3) 4px;padding-inline:10px;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--text)}
  .railnav>.rail-group:first-child{margin-block-start:var(--space-2)}
  /* In the rail both ranks are rows again — the sidebar's grouping is what
     carries the distinction there, exactly as it does in Nav.svelte, so the
     pill and the underline are narrow-only. */
  .row{justify-content:flex-start;inline-size:100%;white-space:normal;text-align:start}
  .row.dest,.row.tool{border-color:transparent;background:none;border-radius:7px;padding:4px 10px;font-size:13px;text-decoration:none}
  .row.dest:hover,.row.tool:hover{background:var(--row-hover)}
  .row.is-current{color:#fff;background:var(--accent-action);font-weight:600}
  .rail-foot{margin-block-start:var(--space-4);margin-inline-start:0;padding-inline:10px}
  /* The content pane — the box that finally carries the pane surface, the same
     role App.svelte gives \`.appshell-main\`. */
  .pane{display:flex;flex-direction:column;min-inline-size:0;min-block-size:100svh;background:var(--bg)}
  /* The reading and operating track. The window may be any width; this is not. */
  .wrap{inline-size:100%;max-inline-size:calc(var(--col) + 44px);margin-inline:auto;padding:var(--space-5) 22px var(--space-8)}
  .wrap.wide{max-inline-size:calc(var(--col-wide) + 44px)}
}

/* ── Content, grouped into cards ──────────────────────────────────────────────
   The other half of the owner's answer. A section of a guide or a policy is a
   card, the same card \`.ui-card\` is in the app — so the page reads as grouped
   rows on a pane rather than as an unbroken wall of prose.

   \`.sheet\` rather than \`.card\`: \`.card\` is already a page-chrome primitive that
   a few blocks opt into, and a section wrapper has to be able to sit around one
   of those without turning into a card inside a card. */
.sheet{margin-block:14px;padding:18px 22px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.sheet>:first-child{margin-block-start:0}
.sheet>:last-child{margin-block-end:0}
.sheet>h2{margin-block-start:0}
/* A block that already draws its own surface flattens inside a sheet: its rim
   and fill would otherwise repeat the sheet's one step further in, which reads
   as depth that means nothing. Its reading-start accent rule stays — that is
   what says "this is an aside", and it is the only thing the block needs. */
.sheet .cbox,.sheet pre,.sheet .tw,.sheet .builder{background:var(--bg)}
@media(min-width:1180px){.sheet{margin-block:16px}}`;
