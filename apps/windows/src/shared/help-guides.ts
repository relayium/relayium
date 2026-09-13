// Which screens may promise a document, and where that document lives.
//
// ## Why a link is optional rather than on every screen
//
// Because it is a promise. `relayium.com/guides/<slug>` is a maintained page
// and `/device-inbox` is a real product route; the Account screen has neither.
// An invented "learn more" pointing somewhere that does not answer the question
// is worse than the honest absence of one, so the table below holds `null` for
// that screen and a test asserts the absence rather than leaving it to taste.
//
// ## Why the URL is built here and not in the page that renders it
//
// The renderer never names a destination. It asks to open the guide for a
// SCREEN, and this table turns that closed token into an address — the same
// shape `accountManage` already uses, for the same reason written there: a
// channel that accepted an address from a page would be script-triggered
// navigation carrying the user's real browser session.
//
// ## Why the production origin, always
//
// Documentation is published by the product site. It is not served by whatever
// server this build happens to dial, so the address must NOT come from
// `apiOrigin()`: an engineering build points its API at loopback, and a guide
// link built on that origin would open a page that has never existed there.
// The site is the one destination this channel can reach, in every build.

import { PRODUCTION_SITE_ORIGIN } from "./origin-constants.js";

/** The five browseable screens, named the way the renderer names them. */
export type HelpSurface = "lan" | "pair" | "stored" | "inbox" | "account";

const SURFACES: readonly HelpSurface[] = ["lan", "pair", "stored", "inbox", "account"];

export function isHelpSurface(value: unknown): value is HelpSurface {
  return typeof value === "string" && (SURFACES as readonly string[]).includes(value);
}

/** The two shipped languages, which decide which translation may be promised. */
export type GuideLanguage = "en" | "zh";

export function isGuideLanguage(value: unknown): value is GuideLanguage {
  return value === "en" || value === "zh";
}

export type HelpGuide =
  /**
   * A guide under `/guides/<slug>`. English lives at the root and every other
   * shipped language under its own prefix, mirroring the site's own rule.
   */
  | { readonly kind: "localized"; readonly slug: string }
  /**
   * A product page the site publishes in English only. Generating `/zh/<path>`
   * for one of these would be a 404 shipped to every Chinese reader, so the
   * language is deliberately ignored when the address is built.
   */
  | { readonly kind: "english"; readonly path: string };

/**
 * Every screen, so adding one without deciding this question is a type error.
 *
 * `Record<HelpSurface, …>` rather than a partial map on purpose: "we never
 * thought about it" and "there is deliberately no guide" must not look the same
 * in this file.
 */
export const HELP_GUIDES: Readonly<Record<HelpSurface, HelpGuide | null>> = {
  lan: { kind: "localized", slug: "what-is-peer-to-peer-file-transfer" },
  pair: { kind: "localized", slug: "send-a-file-to-someone" },
  stored: { kind: "localized", slug: "push-to-cloud-pull-on-another-computer" },
  // The feature's own page rather than a guide, and English-only by the site's
  // decision — not something this app may paper over.
  inbox: { kind: "english", path: "device-inbox" },
  // Deliberately none. Plans, devices and stored files are account state rather
  // than a workflow with a document behind it, and the one page that could be
  // linked is the web account page this client does not send people to.
  account: null,
};

/** The address a screen's guide link opens, or null where it promises none. */
export function guideUrl(
  surface: HelpSurface,
  language: GuideLanguage,
  origin: string = PRODUCTION_SITE_ORIGIN,
): string | null {
  const guide = HELP_GUIDES[surface];
  if (guide === null) return null;
  if (guide.kind === "english") return `${origin}/${guide.path}`;
  const prefix = language === "en" ? "" : `${language}/`;
  return `${origin}/${prefix}guides/${guide.slug}`;
}

/**
 * What main decides when a page asks to open a guide.
 *
 * The handler around this is deliberately thin — validate, resolve, open — and
 * this is the part worth being able to test: the three ways a request does NOT
 * produce an address are the ways this channel could leak into something other
 * than the documentation site.
 */
export type GuideRequest =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly why: "unknown-surface" | "unknown-language" | "no-guide" };

export function resolveGuideRequest(
  payload: { readonly surface: unknown; readonly language: unknown },
  origin: string = PRODUCTION_SITE_ORIGIN,
): GuideRequest {
  if (!isHelpSurface(payload.surface)) return { ok: false, why: "unknown-surface" };
  if (!isGuideLanguage(payload.language)) return { ok: false, why: "unknown-language" };
  const url = guideUrl(payload.surface, payload.language, origin);
  // The screen that promises no document. Not an error, and not an invented
  // destination either.
  if (url === null) return { ok: false, why: "no-guide" };
  return { ok: true, url };
}
