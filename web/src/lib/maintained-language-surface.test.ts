// web/src/lib/maintained-language-surface.test.ts — the 2026-08-14 language
// freeze as the RUNNING APP presents it.
//
// i18n.test.ts owns the type split and the resolution rules; this file owns what
// a person and a network tab actually see:
//
//   • every language selector in the app offers exactly English and 中文;
//   • no frozen language has a loader, so no chunk for one can be built,
//     precached or fetched;
//   • the archived tables are still in the repository, unimported and outside
//     the type-checked program, so the freeze is reversible without being live.
//
// The last one is the easiest to get wrong in the tidy direction: deleting the
// seven tables would make every other assertion here pass, and would also throw
// away the only reviewed translation of the copy the archived static pages were
// written against.
import { describe, expect, it, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Nav from "./Nav.svelte";
import DownloadPage from "./DownloadPage.svelte";
import { LANGS, FROZEN_LANGS, setLang, loadLang, messages } from "./i18n.svelte";

const here = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(here(p), "utf8");

let app: unknown;
let target: HTMLDivElement | undefined;

afterEach(async () => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  target = undefined;
  await setLang("en");
});

function render(Component: unknown): HTMLDivElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Component as never, { target });
  flushSync();
  return target;
}

describe("every language selector in the app", () => {
  // Both selectors are data-driven from LANGS, which is the point: there is one
  // list, so a language cannot be offered on one surface and not the other. What
  // is asserted here is that both really do render it — a hardcoded <option>
  // added to either would be invisible to a LANGS-only check.
  const SURFACES: [string, unknown][] = [
    ["the main nav", Nav],
    ["the download page", DownloadPage],
  ];

  it.each(SURFACES.map(([name]) => name))("%s offers exactly English and 中文", async (name) => {
    const Component = SURFACES.find(([n]) => n === name)![1];
    await loadLang("en");
    const el = render(Component);
    const select = el.querySelector<HTMLSelectElement>("select.lang");
    expect(select, `${name} has no language selector`).toBeTruthy();
    const options = [...select!.options];
    expect(options.map((o) => o.value)).toEqual(LANGS.map((l) => l.code));
    expect(options.map((o) => o.textContent)).toEqual(LANGS.map((l) => l.label));
    expect(options).toHaveLength(2);
    for (const frozen of FROZEN_LANGS) {
      expect(options.some((o) => o.value === frozen), `${name} still offers ${frozen}`).toBe(false);
    }
  });

  it("switches the whole selector set with one click, not per surface", async () => {
    await loadLang("zh");
    const el = render(Nav);
    const select = el.querySelector<HTMLSelectElement>("select.lang")!;
    select.value = "zh";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    // setLang loads the target table before switching, so the change is two
    // awaits deep even when the module is already in the import cache.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flushSync();
    expect(select.value).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
    expect(document.documentElement.dir).toBe("ltr");
  });
});

describe("no frozen locale can reach the bundle", () => {
  it("has a loader for the maintained languages and for nothing else", () => {
    // Read as source: the loaders object is what vite turns into one chunk per
    // entry, so an added line is an added chunk whether or not anything calls
    // it. Counting the actual `import("./i18n/…")` calls is the only way to see
    // that from a test.
    const src = read("src/lib/i18n.svelte.ts");
    const loaded = [...src.matchAll(/import\("\.\/i18n\/([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(loaded.sort()).toEqual(LANGS.map((l) => l.code).sort());
    for (const frozen of FROZEN_LANGS) {
      // The exact import form, not a substring: "./i18n/ar" is a prefix of the
      // "./i18n/archive/" the module's own comment points at, and a loose
      // `toContain` fails on that comment while proving nothing.
      expect(src, `a loader for ${frozen} would ship its table`)
        .not.toContain(`import("./i18n/${frozen}")`);
      expect(src, `${frozen} must not be reachable from the archive path either`)
        .not.toContain(`import("./i18n/archive/${frozen}")`);
    }
  });

  it("loads a table for each maintained language and leaves the record at two", async () => {
    for (const { code } of LANGS) await loadLang(code);
    expect(Object.keys(messages).sort()).toEqual(LANGS.map((l) => l.code).sort());
  });

  it("has no shipped module importing an archived table", () => {
    // The archive is inert by having no importer. A single stray import would
    // pull ~60 kB of unmaintained copy back into the graph, and nothing else
    // here would notice.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(here(dir), { withFileTypes: true })) {
        const path = `${dir}/${name.name}`;
        if (name.isDirectory()) {
          if (path.endsWith("/i18n/archive")) continue;
          walk(path);
        } else if (/\.(ts|svelte)$/.test(name.name) && !name.name.includes(".test.")) {
          if (/from ["'][^"']*i18n\/archive/.test(read(path))) offenders.push(path);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

describe("the archive is preserved, and preserved out of the way", () => {
  it("still holds a table for every frozen language", () => {
    for (const frozen of FROZEN_LANGS) {
      expect(existsSync(here(`src/lib/i18n/archive/${frozen}.ts`)), `${frozen}.ts was deleted`).toBe(true);
    }
    // Not empty stubs: these are the tables the archived static pages were
    // translated alongside, and a stub would make that history unverifiable.
    expect(read("src/lib/i18n/archive/ja.ts").length).toBeGreaterThan(20_000);
  });

  it("explains itself where someone would look", () => {
    const readme = read("src/lib/i18n/archive/README.md");
    expect(readme).toMatch(/frozen|archive/i);
    expect(readme, "restoration must not read as 'un-exclude the directory'")
      .toMatch(/re-translat/i);
  });

  it("stays outside the type-checked program", () => {
    // Governance requires new copy in English and Chinese only. If the archive
    // were checked, every new `Messages` field would be a seven-file edit in
    // languages nobody maintains — which ends in seven machine translations or
    // seven placeholders that would ship if a locale were ever re-enabled.
    const cfg = JSON.parse(read("tsconfig.app.json").replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(cfg.exclude).toContain("src/lib/i18n/archive");
  });
});
