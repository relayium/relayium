// The generated pages render the app's sidebar. Its labels therefore exist in
// two places, and this is what stops them becoming two different sidebars.
//
// `content/shell-nav.mjs` is a COPY of the SPA's i18n, taken because the page
// builder runs on plain Node and CI's Node 24 cannot be relied on to strip
// TypeScript. This test is the other half of that trade: Vitest transpiles TS
// itself, so it can import the real modules and compare, on any Node.
//
// It is written as `.ts` for exactly that reason — a `.mjs` test could not
// import `src/lib/i18n/en.ts` at all.
//
// The seven archived locales are not an exception to the comparison, only to
// the GROUP titles: those keys were added to the app after the 2026-08-14
// freeze, so `shell.*` does not exist in the archive and the table must say
// `null`. A non-null group title on an archived locale would mean somebody had
// translated frozen copy, which is the thing the freeze forbids — so that is
// asserted, not tolerated.
import { describe, it, expect } from "vitest";
import { SHELL_NAV } from "./content/shell-nav.mjs";

const MAINTAINED = ["en", "zh"] as const;
const ARCHIVED = ["ja", "ko", "de", "fr", "ar", "es", "pt"] as const;

/** The i18n module for one locale: maintained ones ship, archived ones are kept. */
async function messages(lang: string): Promise<any> {
  const mod = (MAINTAINED as readonly string[]).includes(lang)
    ? await import(`../../src/lib/i18n/${lang}.ts`)
    : await import(`../../src/lib/i18n/archive/${lang}.ts`);
  return mod.default;
}

/** What the table SHOULD hold for a locale, derived from the app's own copy. */
function expected(m: any) {
  return {
    navLabel: m.nav.primaryLabel,
    lan: m.shell?.lanShort ?? m.nav.lanTab,
    lanFull: m.nav.lanTab,
    cross: m.shell?.crossShort ?? m.nav.crossTab,
    crossFull: m.nav.crossTab,
    offline: m.shell?.offlineShort ?? m.nav.offlineTab,
    offlineFull: m.nav.offlineTab,
    inbox: m.shell?.deviceInboxShort ?? m.nav.deviceInboxTab,
    inboxFull: m.nav.deviceInboxTab,
    cli: m.nav.cliTab,
    apps: m.nav.appsTab,
    pricing: m.pricingPage.navLink,
    groupDirect: m.shell?.groupDirect ?? null,
    groupLinks: m.shell?.groupLinks ?? null,
    groupDevices: m.shell?.groupThisDevice ?? null,
    groupTools: m.nav.toolsLabel ?? null,
  };
}

describe("the generated sidebar says what the app's sidebar says", () => {
  it("covers exactly the nine generated locales", () => {
    expect(Object.keys(SHELL_NAV).sort()).toEqual([...MAINTAINED, ...ARCHIVED].sort());
  });

  it.each([...MAINTAINED, ...ARCHIVED])("%s matches src/lib/i18n, key for key", async (lang) => {
    const want = expected(await messages(lang));
    expect(SHELL_NAV[lang as keyof typeof SHELL_NAV], `content/shell-nav.mjs is stale for ${lang} — regenerate it from src/lib/i18n`)
      .toEqual(want);
  });

  it("gives the two maintained locales their group titles", () => {
    for (const lang of MAINTAINED) {
      const row = SHELL_NAV[lang];
      for (const key of ["groupDirect", "groupLinks", "groupDevices", "groupTools"] as const) {
        expect(row[key], `${lang}.${key} must be a real title`).toBeTruthy();
      }
    }
  });

  it("leaves every archived locale's group titles null", () => {
    // Not "it happens to be null today": a translated title here would mean
    // frozen copy had been written, and the ungrouped sidebar those pages get
    // is a deliberate consequence of the freeze, not a bug to be fixed by
    // translating four words.
    const translated: string[] = [];
    for (const lang of ARCHIVED) {
      const row = SHELL_NAV[lang];
      for (const key of ["groupDirect", "groupLinks", "groupDevices", "groupTools"] as const) {
        if (row[key] !== null) translated.push(`${lang}.${key} = ${row[key]}`);
      }
    }
    expect(translated, "frozen locales must not gain new group titles").toEqual([]);
  });

  it("never leaves a destination unnamed in any locale", () => {
    // The failure this catches is an empty string or an undefined slipping
    // through as "no label", which renders as a nameless row a screen reader
    // announces as "link".
    const blank: string[] = [];
    for (const [lang, row] of Object.entries(SHELL_NAV)) {
      for (const key of ["navLabel", "lan", "lanFull", "cross", "crossFull", "offline",
        "offlineFull", "inbox", "inboxFull", "cli", "apps", "pricing"] as const) {
        const v = (row as Record<string, unknown>)[key];
        if (typeof v !== "string" || v.trim() === "") blank.push(`${lang}.${key}`);
      }
    }
    expect(blank).toEqual([]);
  });
});
