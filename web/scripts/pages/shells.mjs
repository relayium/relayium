// web/scripts/pages/shells.mjs — per-route static shells for the English SPA
// routes.
//
// The problem this solves: /cross-network, /offline-transfer, /apps, /pricing,
// /cli and /device-inbox are English SPA routes, so the bytes a crawler
// receives were
// index.html — whose <head> hardcodes the HOMEPAGE's title, description,
// canonical ("https://relayium.com/") and hreflang cluster, and whose <noscript>
// block is the homepage's prose. The SPA rewrites all of that after boot
// (App.svelte + page-meta.ts), so a JS-executing crawler sees the right thing
// and everything else — most AI/answer-engine crawlers, Bing's second pass,
// link unfurlers — sees a duplicate of the homepage at every one of those
// URLs, all of which the sitemap actively submits. The eight localized twins
// (/zh/cross-network/ …) were static and correct the whole time; only English,
// the original, was broken.
//
// The fix is not to prerender the app (these routes must serve the app — they
// ARE the transfer UI). It is to emit one HTML file per route that is byte-wise
// the same SPA shell with two regions swapped: the SEO-HEAD block and the
// SEO-BODY (<noscript>) block, both marked in index.html. The SPA boots
// identically from any of them, the URL keeps its slash-less form (no redirect,
// no canonical churn), and the raw HTML finally describes the route it is
// serving.
//
// The file names double as the SPA route whitelist: nginx's `try_files $uri
// $uri.html …` finds /cross-network.html for /cross-network and =404s for
// anything not in this list, which is also what kills the soft-404 (every
// unknown extensionless URL used to answer 200 with the homepage). Adding a
// route means adding it here — there is no second list to forget.
import {
  MAINTAINED_LANGS,
  LANG_LABELS,
  DEFAULT_LANG,
  BCP47,
  OG_LOCALE,
  OG_IMAGE,
  OG_IMAGE_META,
  PRICING_URL,
  SITE,
  urlPath,
  absUrl,
  esc,
} from "./shared.mjs";

/** Marker pairs in index.html; see the comments there. */
export const HEAD_MARKERS = ["<!-- SEO-HEAD -->", "<!-- /SEO-HEAD -->"];
export const BODY_MARKERS = ["<!-- SEO-BODY -->", "<!-- /SEO-BODY -->"];

// The maintained cluster only — en, zh, x-default at en. The seven archived
// locales are not alternates of a current page; see article-template.mjs's
// alternates() for the reciprocity reasoning. Their /ja/apps/-shaped URLs stay
// public, indexable and in the sitemap.
function alternates(slug) {
  const links = MAINTAINED_LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function jsonLd(doc, canonical, updated) {
  const graph = [
    {
      "@type": "WebPage",
      name: doc.title,
      description: doc.description,
      url: canonical,
      inLanguage: "en",
      ...(updated ? { dateModified: updated } : {}),
      publisher: {
        "@type": "Organization",
        name: SITE.name,
        url: SITE.origin + "/",
        logo: { "@type": "ImageObject", url: SITE.origin + "/icon-512.png", width: 512, height: 512 },
      },
    },
  ];
  if (doc.faq?.items?.length) {
    graph.push({
      "@type": "FAQPage",
      inLanguage: "en",
      mainEntity: doc.faq.items.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

/** The <head> region for an indexable route. */
function indexableHead(doc, { route, slug, updated }) {
  const canonical = absUrl(route);
  return `<title>${esc(doc.title)}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="author" content="${SITE.name}" />
    <meta name="application-name" content="${SITE.name}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
    <link rel="canonical" href="${canonical}" />
    ${slug ? alternates(slug) : ""}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${esc(doc.title)}" />
    <meta property="og:description" content="${esc(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${OG_IMAGE}" />
    ${OG_IMAGE_META}
    <meta property="og:locale" content="${OG_LOCALE.en}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(doc.title)}" />
    <meta name="twitter:description" content="${esc(doc.description)}" />
    <meta name="twitter:image" content="${OG_IMAGE}" />
    <script type="application/ld+json">${jsonLd(doc, canonical, updated)}</script>`;
}

/** The <head> region for a route that must never be indexed (account pages,
 *  one-off email landings, /d/<id> download links). robots=noindex is the belt
 *  to robots.txt's braces: a Disallow only stops the crawl, it does not remove a
 *  URL someone else linked to from the index. */
function noindexHead(doc) {
  return `<title>${esc(doc.title)}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="robots" content="noindex, nofollow" />`;
}

function proseBody(doc, { links = [], langSlug = null } = {}) {
  const p = [];
  p.push(`<h1>${esc(doc.hero.h1)}</h1>`);
  p.push(`<p>${esc(doc.hero.pitch)}</p>`);
  if (doc.how) {
    p.push(`<h2>${esc(doc.how.heading)}</h2>`);
    p.push(`<ol>${doc.how.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`);
  }
  if (doc.why) {
    p.push(`<h2>${esc(doc.why.heading)}</h2>`);
    p.push(
      `<ul>${doc.why.items.map((i) => `<li><strong>${esc(i.title)}</strong> — ${esc(i.desc)}</li>`).join("")}</ul>`
    );
  }
  if (doc.compare) {
    p.push(`<h2>${esc(doc.compare.heading)}</h2>`);
    for (const i of doc.compare.items) {
      p.push(`<h3>${esc(i.title)}</h3>`);
      p.push(`<p>${esc(i.body)}</p>`);
    }
  }
  if (doc.faq) {
    p.push(`<h2>${esc(doc.faq.heading)}</h2>`);
    for (const i of doc.faq.items) {
      p.push(`<h3>${esc(i.q)}</h3>`);
      p.push(`<p>${esc(i.a)}</p>`);
    }
  }
  if (links.length) {
    p.push(`<h2>${esc(doc.learnHeading)}</h2>`);
    p.push(`<ul>${links.map((l) => `<li><a href="${urlPath(l.slug, "en")}">${esc(l.title)}</a></li>`).join("")}</ul>`);
  }
  // Ordinary navigation offers the maintained languages and nothing else. This
  // line used to list all eight non-English twins, which is exactly the
  // "primary navigation into a frozen locale" this batch removes: a crawler and
  // a reader would both have read it as eight supported languages.
  if (langSlug) {
    const other = MAINTAINED_LANGS.filter((l) => l !== DEFAULT_LANG).map(
      (l) => `<a href="${urlPath(langSlug, l)}">${esc(LANG_LABELS[l])}</a>`
    );
    p.push(`<p>Also available in: ${other.join(" · ")}</p>`);
  }
  p.push(
    `<p><a href="/">Relayium home</a> · <a href="/guides/">Guides</a> · ` +
      `<a href="/apps">Apps</a> · <a href="${PRICING_URL}">Pricing</a> · <a href="/cli">CLI</a> · ` +
      // The only inbound link to /device-inbox from the static graph. Without
      // it the route would sit in the sitemap linked from nowhere — the
      // "Discovered - currently not indexed" shape site-graph.test.mjs guards.
      `<a href="/device-inbox">Device Inbox</a> · ` +
      `<a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/security/">Security</a> · ` +
      // The only inbound link to the English /releases/. The eight localized
      // twins are linked from their own landing and legal pages; the English
      // homepage is this SPA, so without this line /releases/ would be in the
      // sitemap and linked from nowhere.
      `<a href="/releases/">Releases</a></p>`
  );
  return `<noscript>\n      <main>\n        ${p.join("\n        ")}\n      </main>\n    </noscript>`;
}

function stubBody(doc) {
  return `<noscript>\n      <main>\n        <h1>${esc(doc.hero.h1)}</h1>\n        <p>${esc(
    doc.hero.pitch
  )}</p>\n        <p><a href="/">Relayium home</a></p>\n      </main>\n    </noscript>`;
}

// Routes with no crawlable content of their own: personal pages, the landings
// the account emails link to, the Web Share Target, and the download-link route
// (whose content is one specific person's ciphertext). They still need a shell,
// because without a file at that path the new nginx/Go rules would 404 them.
const NOINDEX_ROUTES = [
  { file: "me.html", hero: "Personal center", pitch: "Sign in to see your transfers, stored files and nodes." },
  { file: "d.html", hero: "Encrypted download link", pitch: "This page decrypts a file in your browser using the key in the link. JavaScript is required." },
  { file: "verify-email.html", hero: "Verify your email", pitch: "Enter the password you chose to finish verifying your account." },
  { file: "reset-password.html", hero: "Reset your password", pitch: "Choose a new password for your Relayium account." },
  { file: "magic-link.html", hero: "Sign in", pitch: "You opened your sign-in link. Confirm below to finish signing in on this device." },
  { file: "share-target.html", hero: "Shared files", pitch: "Files shared into Relayium from your device land here. JavaScript is required." },
];

/**
 * buildShells returns [{ file, head, body }] — one entry per SPA route that must
 * be served with its own head. `file` is relative to the build output root.
 *
 * Each doc's title/description MUST equal what src/lib/page-meta.ts's pageMeta()
 * returns for that route, because the SPA overwrites the served <head> on boot:
 * if they disagree, a rendering crawler and a non-rendering one read two
 * different pages at one URL — the same defect this mechanism exists to remove,
 * just moved one step later. The i18n table can't be imported here (it is app
 * TypeScript, and pulling it into the vite-config project breaks that project's
 * resolution), so shells.test.mjs asserts the equality instead.
 */
export function buildShells({ modes = [], pricing, cli, deviceInbox, cliArticles = [] }) {
  const out = [];
  for (const { def, slug } of modes) {
    const doc = def.langs[DEFAULT_LANG];
    if (!doc) throw new Error(`buildShells: mode ${slug} has no English doc`);
    out.push({
      file: `${slug}.html`,
      head: indexableHead(doc, { route: urlPath(slug, DEFAULT_LANG), slug, updated: def.updated }),
      body: proseBody(doc, { langSlug: slug }),
    });
  }
  // /pricing, /cli and /device-inbox exist only in English, so they get a
  // self-referential canonical and no hreflang cluster — pointing an alternate
  // at a page that doesn't exist is worse than having none.
  out.push({
    file: "pricing.html",
    head: indexableHead(pricing, { route: "/pricing" }),
    body: proseBody(pricing),
  });
  out.push({
    file: "cli.html",
    head: indexableHead(cli, { route: "/cli" }),
    body: proseBody(cli, { links: cliArticles }),
  });
  // /device-inbox is the sixth primary destination and English-only for the same
  // reason: there is no /zh/device-inbox/ directory to point an alternate at.
  out.push({
    file: "device-inbox.html",
    head: indexableHead(deviceInbox, { route: "/device-inbox" }),
    body: proseBody(deviceInbox),
  });
  for (const r of NOINDEX_ROUTES) {
    const doc = { title: `${r.hero} · ${SITE.name}`, description: r.pitch, hero: { h1: r.hero, pitch: r.pitch } };
    out.push({ file: r.file, head: noindexHead(doc), body: stubBody(doc) });
  }
  return out;
}

/** Swap the two marked regions of the built index.html. */
export function applyShell(indexHtml, { head, body }) {
  let out = indexHtml;
  for (const [markers, replacement] of [
    [HEAD_MARKERS, head],
    [BODY_MARKERS, body],
  ]) {
    const [open, close] = markers;
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start < 0 || end < 0 || end < start) {
      throw new Error(`applyShell: markers ${open}…${close} not found in index.html`);
    }
    out = out.slice(0, start + open.length) + "\n    " + replacement + "\n    " + out.slice(end);
  }
  return out;
}
