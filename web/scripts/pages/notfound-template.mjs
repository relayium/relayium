// web/scripts/pages/notfound-template.mjs — the static 404 page.
//
// Until this existed there was no 404 anywhere in the product: nginx and the Go
// server both answered every unknown extensionless URL with 200 + the SPA shell,
// so /compare/typo, /guides/deleted-article and any random string rendered the
// homepage. Search Console files those as soft 404s / duplicates, they burn
// crawl budget, and a deleted page can never fall out of the index.
//
// Deliberately NOT an SPA shell: booting the app on a 404 URL would show the
// transfer UI under a "not found" status, which is worse than a plain page. It
// is one self-contained English document (nginx's error_page serves a single
// file for every language) carrying noindex and links back into the site.
import { SITE, esc } from "./shared.mjs";
import { STYLE } from "./landing-template.mjs";

const LINKS = [
  ["/", "Relayium home — send a file now"],
  ["/cross-network", "Cross-network transfer"],
  ["/offline-transfer", "Encrypted download links"],
  ["/device-inbox", "Device Inbox — send to your own computer or server"],
  ["/apps", "Apps: web, CLI, macOS, iOS"],
  ["/cli", "Relayium CLI"],
  ["/guides/", "Guides"],
  ["/pricing", "Pricing"],
];

export function renderNotFoundPage() {
  const links = LINKS.map(([href, label]) => `<li><a href="${href}">${esc(label)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Page not found · ${SITE.name}</title>
    <meta name="description" content="That page doesn't exist. Here's the way back into Relayium." />
    <meta name="robots" content="noindex, follow" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo" aria-hidden="true">⇌</span><a href="/">${SITE.name}</a></header>
      <main>
      <h1>Page not found</h1>
      <p class="pitch">
        The page you asked for doesn't exist — it may have been moved, or the link
        may have a typo. If you followed a download link, it may simply have expired
        or been opened already: Relayium deletes stored files at expiry or after the
        first download, by design.
      </p>
      <a class="cta" href="/">Send a file</a>
      <section class="reveal">
        <h2>Where to go instead</h2>
        <ul class="learn">${links}</ul>
      </section>
      </main>
      <footer>
        <a href="/">← ${SITE.name}</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/security/">Security</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
