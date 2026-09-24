// Every executable inline script the site generates must be one the production
// CSP allows — and every allowed hash must still be generated.
//
// Production's nginx CSP (in the private relayium-ops repo) carries a fixed
// list of script hashes, because nginx can't compute them the way server/spa.go
// does at startup. That list is written down once, in
// csp-inline-scripts-v1.json next to this file, and ops vendors a copy of it.
// This suite holds the SOURCE to it: web/index.html plus every page
// buildAllPages() generates. `node scripts/check-csp-inline.mjs dist`, run by
// the web workflow right after `npm run build`, holds the BUILT tree to it.
//
// This file used to compare index.html against a copy of the ops nginx config
// and skip whenever that copy was absent — which was always, on CI. It now has
// no skip path: everything it reads is in this repository. What it cannot prove
// is that the deployed nginx carries the fixture's hashes; that is the ops
// side's check against its vendored copy.
//
// Changing an inline script means changing the fixture by hand, in the same
// commit. Never regenerate the fixture from the current pages — that approves
// whatever drift it is run against.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import {
  FIXTURE_PATH,
  MIN_PAGES,
  checkPages,
  classifyScript,
  cspHash,
  loadFixture,
  parseFixture,
  scanHtml,
} from "../check-csp-inline.mjs";
import { THEME_SCRIPT } from "./page-chrome.mjs";
import { buildAllPages } from "../gen-pages.mjs";

const fixture = loadFixture();
const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
const byId = Object.fromEntries(fixture.scripts.map((s) => [s.id, s]));
const sourcePages = [
  { path: "index.html", html: readFileSync(resolve(process.cwd(), "index.html"), "utf8") },
  ...buildAllPages(),
];

// Parsing ~450 pages takes seconds; the negative controls below each change a
// handful of them, so unchanged pages are scanned once.
const memo = new Map();
const scan = (html) => {
  if (!memo.has(html)) memo.set(html, scanHtml(html));
  return memo.get(html);
};
const check = (pages, fx = fixture, opts = {}) => checkPages(pages, fx, { scan, ...opts });
const withFixture = (edit) => {
  const doc = JSON.parse(fixtureText);
  edit(doc);
  return parseFixture(JSON.stringify(doc, null, 2) + "\n");
};
const SLOW = 120_000;

// The builder script's one distinctive statement, used to change it by a byte
// on the pages that really carry it.
const BUILDER_MARK = "setTimeout(function(){copy.textContent=o;},1500);";
const builderPages = sourcePages.filter((p) => p.html.includes(BUILDER_MARK));

describe("csp-inline-scripts-v1.json", () => {
  it("is the versioned two-script contract, checked strictly", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.scripts.map((s) => [s.id, s.scope])).toEqual([
      ["theme", "every-page"],
      ["cli-copy-builder", "some-pages"],
    ]);
  });

  it("refuses every malformed variant", () => {
    const refuse = (text, why) => expect(() => parseFixture(text), why).toThrow();
    const variant = (edit) => {
      const doc = JSON.parse(fixtureText);
      edit(doc);
      return JSON.stringify(doc, null, 2) + "\n";
    };
    refuse(fixtureText.replace(/\n$/, ""), "no trailing newline");
    refuse(JSON.stringify(JSON.parse(fixtureText)) + "\n", "not canonical");
    refuse(fixtureText.replace('"version": 1,', '"version": 1,\n  "version": 1,'), "duplicate key");
    refuse(variant((d) => (d.version = 2)), "version");
    refuse(variant((d) => (d.schema = "relayium.web.csp")), "schema");
    refuse(variant((d) => (d.extra = true)), "extra top-level key");
    refuse(variant((d) => (d.scripts = [])), "empty scripts");
    refuse(variant((d) => d.scripts.push({ ...d.scripts[0], hash: byId["cli-copy-builder"].hash })), "duplicate id");
    refuse(variant((d) => d.scripts.push({ ...d.scripts[1], id: "copy" })), "duplicate hash");
    refuse(variant((d) => (d.scripts[0].hash = d.scripts[0].hash.slice(0, -2) + "=")), "short hash");
    refuse(variant((d) => (d.scripts[0].hash = "sha384-" + d.scripts[0].hash.slice(7))), "wrong algorithm");
    refuse(variant((d) => (d.scripts[0].scope = "most-pages")), "scope");
    refuse(variant((d) => (d.scripts[0].source = " ")), "empty source");
    refuse(variant((d) => delete d.scripts[1].source), "missing key");
    refuse(variant((d) => (d.scripts[1].note = "x")), "extra entry key");
  });
});

describe("script classification", () => {
  const scriptEl = (tag) => new JSDOM(`<!doctype html>${tag}</script>`).window.document.querySelector("script");
  const cases = [
    ["<script>", "inline"],
    ['<script type="">', "inline"],
    ['<script type="text/javascript">', "inline"],
    ['<script type="application/javascript">', "inline"],
    ['<SCRIPT TYPE=" Application/JavaScript ">', "inline"],
    ['<script type="module">', "inline"],
    ['<script type="MODULE">', "inline"],
    ['<script language="javascript">', "inline"],
    ['<script data-src="/x.js">', "inline"], // a substring "src=" is not a src attribute
    ['<script type="application/ld+json">', "inert"],
    ['<script type="application/json">', "inert"],
    ['<script src="/x.js">', "external"],
    ['<script  src = "/x.js" >', "external"],
    ["<script src>", "external"],
    ['<script type="module" crossorigin src="/assets/x.js">', "external"],
  ];
  it.each(cases)("%s → %s", (tag, want) => {
    expect(classifyScript(scriptEl(tag))).toBe(want);
  });

  it.each([
    '<script type="text/plain">',
    '<script type="importmap">',
    '<script type="speculationrules">',
    '<script type="text/javascript; charset=utf-8">',
    '<script type="  ">',
  ])("refuses to guess about %s", (tag) => {
    expect(() => classifyScript(scriptEl(tag))).toThrow(/neither JavaScript nor a named inert/);
  });

  it("hashes the text a browser hashes, and finds scripts wherever they hide", () => {
    const body = "\nvar a = 1;\n";
    const { hashes, problems } = scanHtml(
      `<!doctype html><script type="application/ld+json">{"a":1}</script>` +
        `<script>${body}</script><svg></svg><template><script type="module">t()</script></template>` +
        `<script src="/x.js">ignored()</script>`,
    );
    expect(problems).toEqual([]);
    expect(hashes).toEqual([cspHash(body), cspHash("t()")]);
    // CRLF is normalised by the HTML parser before the script has text.
    expect(scanHtml(`<script>a;\r\nb;</script>`).hashes).toEqual([cspHash("a;\nb;")]);
  });

  it("reports what no hash can allow", () => {
    const { problems } = scanHtml(
      `<!doctype html><button onclick="x()"></button><a href=" javascript:x()"></a>` +
        `<svg><script>y()</script></svg><script type="text/x-template">z</script>`,
    );
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/onclick/);
    expect(problems.join("\n")).toMatch(/javascript: URL/);
    expect(problems.join("\n")).toMatch(/namespace/);
    expect(problems.join("\n")).toMatch(/text\/x-template/);
  });
});

describe("the source pages", () => {
  it(
    "carry exactly the fixture's scripts, and every one of them",
    () => {
      const { errors, counts, pages } = check(sourcePages);
      expect(errors).toEqual([]);
      expect(pages).toBeGreaterThan(MIN_PAGES);
      expect(counts.get("theme")).toBe(sourcePages.length);
      expect(counts.get("cli-copy-builder")).toBe(builderPages.length);
      expect(builderPages.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "fail when the theme snippet changes by one byte",
    () => {
      const inner = /^<script>([\s\S]*)<\/script>$/.exec(THEME_SCRIPT)[1];
      const mutated = sourcePages.map((p) => ({
        ...p,
        html: p.html.replace(inner, inner.replace("'dark'", "'dark' ")),
      }));
      const { errors } = check(mutated);
      expect(errors.some((e) => /index\.html: inline script sha256-\S+ is not in/.test(e))).toBe(true);
      expect(errors.some((e) => /carries theme 0 times/.test(e))).toBe(true);
      expect(errors.some((e) => /^theme .* is on no page/.test(e))).toBe(true);
    },
    SLOW,
  );

  it(
    "fail when the copy builder changes by one byte",
    () => {
      const mutated = sourcePages.map((p) => ({ ...p, html: p.html.replace(BUILDER_MARK, BUILDER_MARK.replace("1500", "1501")) }));
      const { errors } = check(mutated);
      expect(errors.filter((e) => /is not in .* nginx will block it/.test(e))).toHaveLength(builderPages.length);
      expect(errors.some((e) => /^cli-copy-builder .* is on no page/.test(e))).toBe(true);
    },
    SLOW,
  );

  it(
    "fail when the copy builder stops being emitted",
    () => {
      const strip = (html) => html.replace(/\s*<script>\s*\(function\(\)\{[\s\S]*?<\/script>/g, "");
      const mutated = sourcePages.map((p) => ({ ...p, html: strip(p.html) }));
      expect(mutated.some((p) => p.html.includes(BUILDER_MARK))).toBe(false);
      const { errors } = check(mutated);
      expect(errors).toEqual([expect.stringMatching(/^cli-copy-builder .* is on no page/)]);
    },
    SLOW,
  );

  it.each([
    ['<script type="application/javascript">extra()</script>'],
    ['<script type="module">extra()</script>'],
    ["<script>extra()</script>"],
  ])(
    "fail when a page gains %s",
    (tag) => {
      const mutated = sourcePages.map((p, i) => (i === 7 ? { ...p, html: p.html.replace("</body>", tag + "</body>") } : p));
      const { errors } = check(mutated);
      expect(errors).toEqual([expect.stringMatching(new RegExp(`^${sourcePages[7].path}: inline script ${cspHash("extra()").replace(/[+/]/g, "\\$&")} is not in`))]);
    },
    SLOW,
  );

  it(
    "fail against a fixture missing an entry, or carrying a stale one",
    () => {
      const missing = withFixture((d) => d.scripts.splice(1, 1));
      expect(check(sourcePages, missing).errors).toHaveLength(builderPages.length);
      const stale = withFixture((d) =>
        d.scripts.push({ id: "retired", hash: cspHash("retired()"), scope: "some-pages", source: "nowhere" }),
      );
      expect(check(sourcePages, stale).errors).toEqual([expect.stringMatching(/^retired .* is on no page/)]);
    },
    SLOW,
  );

  it(
    "fail when the tree is truncated or index.html is missing",
    () => {
      expect(check(sourcePages.slice(1)).errors).toEqual(["index.html: missing"]);
      const { errors } = check(sourcePages.slice(0, 20));
      expect(errors.some((e) => /only 20 pages to check/.test(e))).toBe(true);
      expect(check([]).errors.length).toBeGreaterThan(0);
    },
    SLOW,
  );
});

// The CLI is what CI runs against the real dist/; here it runs against a tree
// written from the source pages, which exercises the walk and the refusals.
describe("check-csp-inline CLI", () => {
  const writeTree = () => {
    const dir = mkdtempSync(join(tmpdir(), "csp-inline-"));
    for (const p of sourcePages) {
      mkdirSync(dirname(join(dir, p.path)), { recursive: true });
      writeFileSync(join(dir, p.path), p.html);
    }
    return dir;
  };
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/check-csp-inline.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });

  it(
    "passes a complete tree and fails a partial or absent one",
    () => {
      const dir = writeTree();
      try {
        const ok = run(dir);
        expect(ok.status, ok.stderr).toBe(0);
        expect(ok.stdout).toContain(`theme ${byId.theme.hash} on ${sourcePages.length} pages`);
        expect(ok.stdout).toContain(`cli-copy-builder ${byId["cli-copy-builder"].hash} on ${builderPages.length} pages`);

        // One generated page gone: still far above MIN_PAGES, still refused.
        unlinkSync(join(dir, builderPages[0].path));
        const partial = run(dir);
        expect(partial.status).toBe(1);
        expect(partial.stderr).toContain(`${builderPages[0].path}: missing`);

        rmSync(dir, { recursive: true, force: true });
        const absent = run(dir);
        expect(absent.status).toBe(1);
        expect(absent.stderr).toMatch(/not a directory/);
        expect(run().status).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
