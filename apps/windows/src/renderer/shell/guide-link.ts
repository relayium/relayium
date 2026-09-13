// The one journey out of the help.
//
// The page sends a SCREEN and a language and gets back whether a browser
// opened. It never composes, holds or receives an address: main owns the slug
// table (`shared/help-guides.ts`) and the origin it is published on. A channel
// that took an address from a page would be script-triggered navigation
// carrying the user's real browser session, which is why `accountManage` is
// written the same way.

import type { GuideLanguage, HelpSurface } from "../../shared/help-guides.js";
import type { Lang } from "../i18n/messages.js";

/** The preload surface this uses. Declared, not inferred. */
export interface HelpBridge {
  openGuide(payload: {
    surface: HelpSurface;
    language: GuideLanguage;
  }): Promise<{ ok: boolean }>;
}

/**
 * The UI's language set and the set a guide may be promised in are the same
 * question, so this is a compile error rather than a second list to keep in
 * step. If a third language is ever shipped, this stops the build until the
 * site publishes that prefix — which is the failure the check exists for.
 */
const _languagesAgree: Lang extends GuideLanguage ? (GuideLanguage extends Lang ? true : never) : never = true;
void _languagesAgree;

function defaultBridge(): HelpBridge | null {
  const relayium = (globalThis as unknown as { relayium?: { help?: HelpBridge } }).relayium;
  return relayium?.help ?? null;
}

/**
 * Ask main to open one screen's guide.
 *
 * Returns false rather than throwing when the bridge is absent, so a page shows
 * the same honest "could not open your browser" it shows for a refusal instead
 * of an unhandled rejection. A guide that did not open must not look like one
 * that did.
 */
export async function openGuide(
  surface: HelpSurface,
  language: GuideLanguage,
  bridge: HelpBridge | null = defaultBridge(),
): Promise<boolean> {
  if (bridge === null) return false;
  try {
    const result = await bridge.openGuide({ surface, language });
    return result.ok === true;
  } catch {
    return false;
  }
}
