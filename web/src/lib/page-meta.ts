import type { Route } from "./router.svelte";
import { CROSS_PATH, OFFLINE_PATH, PRICING_PATH, APPS_PATH, CLI_PATH, DEVICE_INBOX_PATH } from "./router.svelte";
import type { Messages } from "./i18n/types";

export interface PageMeta {
  title: string;
  description: string;
  /** null for private/noindex routes, which must not inherit a public canonical. */
  canonicalPath: string | null;
}

// pageMeta returns each route's <title>, description and canonical contract.
// Public product routes point canonical/og:url at their own URL; private app and
// token routes use null so they cannot inherit the homepage's discovery links.
export function pageMeta(
  route: Route,
  m: Messages
): PageMeta {
  if (route === "cross") return { title: m.titleCross, description: m.descCross, canonicalPath: CROSS_PATH };
  if (route === "offline") return { title: m.titleOffline, description: m.descOffline, canonicalPath: OFFLINE_PATH };
  if (route === "pricing") return { title: `${m.pricingPage.title} · Relayium`, description: m.pricingPage.subtitle, canonicalPath: PRICING_PATH };
  if (route === "apps") return { title: m.appsPage.metaTitle, description: m.appsPage.metaDesc, canonicalPath: APPS_PATH };
  // /cli was missing here, so the docs page inherited the homepage's title AND
  // its canonical — the page told Google "I am the homepage" and de-indexed
  // itself. The static shell (scripts/pages/shells.mjs) gets it right in the raw
  // HTML; without this branch the SPA overwrote that back to "/" on boot, which
  // is exactly what a rendering crawler reads.
  if (route === "cli") return { title: m.cliPage.metaTitle, description: m.cliPage.metaDesc, canonicalPath: CLI_PATH };
  // Public product route: it gets its own canonical, and its title/description
  // must match the static shell byte for byte (shells.mjs), or a rendering
  // crawler and a non-rendering one read two different pages at one URL.
  if (route === "device-inbox") {
    return {
      title: m.deviceInboxPage.metaTitle,
      description: m.deviceInboxPage.metaDesc,
      canonicalPath: DEVICE_INBOX_PATH,
    };
  }
  if (route === "verify-email") return { title: `${m.verifyEmail.title} · Relayium`, description: m.verifyEmail.confirmPrompt, canonicalPath: null };
  if (route === "reset-password") return { title: `${m.resetPassword.title} · Relayium`, description: m.resetPassword.lead, canonicalPath: null };
  if (route === "magic-link") return { title: `${m.magicLink.title} · Relayium`, description: m.magicLink.lead, canonicalPath: null };
  if (route === "me") return { title: `${m.me.title} · Relayium`, description: m.me.loginRequired, canonicalPath: null };
  if (route === "download") return { title: `${m.download.title} · Relayium`, description: m.download.loading, canonicalPath: null };
  return { title: m.titleDefault, description: m.descDefault ?? m.titleDefault, canonicalPath: "/" };
}

// hreflang → localized-URL prefix. English (and x-default) live at the root; each
// other language has static pages under "/<prefix>". Order and codes mirror the
// static <link rel=alternate> tags baked into index.html.
const HREFLANG_PREFIX: [string, string][] = [
  ["en", ""],
  ["zh-Hans", "/zh"],
  ["ja", "/ja"],
  ["ko", "/ko"],
  ["de", "/de"],
  ["fr", "/fr"],
  ["ar", "/ar"],
  ["es", "/es"],
  ["pt", "/pt"],
  ["x-default", ""],
];

// Routes that actually have a localized page in every language. Only these get an
// hreflang cluster: /pricing and /cli exist in English only, and pointing an
// alternate at /zh/pricing — a URL that 404s — is worse than emitting none.
const CLUSTERED_PATHS = new Set(["/", CROSS_PATH, OFFLINE_PATH, APPS_PATH]);

// altHreflangs maps a canonical path to its per-language alternate URLs, or to an
// empty list when the route has no localized twins. index.html ships the homepage
// cluster (/, /zh/, …); the SPA calls this so /cross-network and /offline-transfer
// point their hreflang at their own localized pages instead of the homepage.
//
// The localized pages are generated at <lang>/<slug>/index.html and the origin
// 301s the slash-less form, so the alternates MUST carry the trailing slash —
// that is the form the static pages use to reference each other, and an
// alternate that redirects is a non-reciprocal cluster. English keeps its
// slash-less SPA route (there is no /cross-network/ directory).
export function altHreflangs(canonicalPath: string | null): { hreflang: string; path: string }[] {
  if (!canonicalPath || !CLUSTERED_PATHS.has(canonicalPath)) return [];
  return HREFLANG_PREFIX.map(([hreflang, prefix]) => ({
    hreflang,
    path: canonicalPath === "/" ? prefix + "/" : prefix + canonicalPath + (prefix ? "/" : ""),
  }));
}

/** Apply reactive SPA metadata without letting a public route's canonical or
 * hreflang cluster leak into a private route. Every removal has a matching
 * create path so private → public client navigation restores the public head. */
export function applyHeadMeta(doc: Document, meta: PageMeta, origin: string): void {
  doc.title = meta.title;

  let description = doc.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!description) {
    description = doc.createElement("meta");
    description.name = "description";
    doc.head.appendChild(description);
  }
  description.content = meta.description;

  let robots = doc.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!robots) {
    robots = doc.createElement("meta");
    robots.name = "robots";
    doc.head.appendChild(robots);
  }
  robots.content = meta.canonicalPath
    ? "index, follow, max-image-preview:large, max-snippet:-1"
    : "noindex, nofollow";

  let canonical = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  let ogUrl = doc.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  if (meta.canonicalPath) {
    const href = origin + meta.canonicalPath;
    if (!canonical) {
      canonical = doc.createElement("link");
      canonical.rel = "canonical";
      doc.head.appendChild(canonical);
    }
    canonical.href = href;
    if (!ogUrl) {
      ogUrl = doc.createElement("meta");
      ogUrl.setAttribute("property", "og:url");
      doc.head.appendChild(ogUrl);
    }
    ogUrl.content = href;
  } else {
    canonical?.remove();
    ogUrl?.remove();
  }

  const stale = new Map(
    [...doc.head.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')].map((link) => [
      link.getAttribute("hreflang"),
      link,
    ]),
  );
  for (const { hreflang, path } of altHreflangs(meta.canonicalPath)) {
    let link = stale.get(hreflang);
    if (!link) {
      link = doc.createElement("link");
      link.rel = "alternate";
      link.setAttribute("hreflang", hreflang);
      doc.head.appendChild(link);
    }
    link.href = origin + path;
    stale.delete(hreflang);
  }
  for (const link of stale.values()) link.remove();
}
