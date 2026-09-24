// web/scripts/check-csp-inline.mjs — every inline script the site ships must be
// one the production CSP allows, and every hash the CSP is told to allow must
// still be shipped.
//
// Production's nginx cannot compute hashes the way server/spa.go does at
// startup, so its script-src carries a fixed list of 'sha256-…' tokens. A page
// whose inline script differs from that list by one byte still renders; the
// browser just refuses the script with one console line nobody watches for. So
// the list is written down ONCE, in scripts/pages/csp-inline-scripts-v1.json,
// and this module holds the site to it in both directions:
//
//   - an executable inline script whose hash the fixture does not name fails;
//   - a fixture entry no page emits any more fails (a stale allowance is an
//     allowance nobody reviews);
//   - an entry scoped "every-page" missing from, or duplicated on, any page
//     fails.
//
// The fixture is edited BY HAND, never regenerated from the current pages: a
// generator would approve whatever drift it was run against, which is the
// failure this exists to catch. Relayium-ops vendors the same file to check its
// nginx script-src; a changed hash has to be rolled out there (old and new both
// allowed) before the product carrying it is promoted.
//
// Two consumers:
//   - scripts/pages/csp-headers.test.mjs checks the SOURCE (web/index.html plus
//     every page buildAllPages() generates) through checkPages();
//   - the web workflow runs this file as a CLI against the real `dist/` right
//     after `npm run build`, so the bytes checked are the bytes deployed, not
//     the generator's strings:
//
//       node scripts/check-csp-inline.mjs dist
//
// Pages are parsed with jsdom (already a dev dependency; no scripts run, no
// resources load) rather than a regex, so the text hashed is the text a browser
// hashes. One consequence worth knowing: the HTML parser normalises CRLF to LF
// before a script's text exists, so a CRLF checkout hashes the same as an LF one
// here and in the browser — while server/spa.go's byte regex would not.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = resolve(here, "pages", "csp-inline-scripts-v1.json");
export const FIXTURE_SCHEMA = "relayium.web.csp-inline-scripts";
export const FIXTURE_VERSION = 1;
/** Fewer pages than this is a missing or truncated tree, not a smaller site. */
export const MIN_PAGES = 400;

const SCOPES = new Set(["every-page", "some-pages"]);
const HASH_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;
const ID_RE = /^[a-z][a-z0-9-]*$/;

// The HTML spec's JavaScript MIME type essence strings. A type attribute that
// is an ASCII case-insensitive match for one of these (after trimming) runs as
// a classic script; "module" runs as a module script.
const JS_MIME = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
// Data blocks this site deliberately ships (structured data). Named, not
// inferred: every other non-JS type is refused below rather than assumed inert,
// because "importmap", "speculationrules" and whatever comes next are
// governed by script-src too.
const INERT_TYPES = new Set(["application/ld+json", "application/json"]);

const HTML_NS = "http://www.w3.org/1999/xhtml";
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/**
 * Reads and strictly validates the fixture. Throws on anything but the exact
 * canonical shape — including formatting, so the ops copy can be compared
 * byte-for-byte and a duplicated JSON key cannot hide behind JSON.parse.
 * @returns {{ schema: string, version: number, scripts: { id: string, hash: string, scope: string, source: string }[] }}
 */
export function loadFixture(path = FIXTURE_PATH) {
  return parseFixture(readFileSync(path, "utf8"), path);
}

export function parseFixture(text, label = "fixture") {
  const fail = (why) => {
    throw new Error(`${label}: ${why}`);
  };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    fail(`not JSON (${err.message})`);
  }
  if (text !== JSON.stringify(doc, null, 2) + "\n") {
    fail("not in canonical form (2-space JSON, one trailing newline, no duplicate keys)");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("top level must be an object");
  exactKeys(doc, ["schema", "version", "scripts"], "top level", fail);
  if (doc.schema !== FIXTURE_SCHEMA) fail(`schema must be ${JSON.stringify(FIXTURE_SCHEMA)}`);
  if (doc.version !== FIXTURE_VERSION) fail(`version must be ${FIXTURE_VERSION}`);
  if (!Array.isArray(doc.scripts) || doc.scripts.length === 0) fail("scripts must be a non-empty array");
  const ids = new Set();
  const hashes = new Set();
  for (const [i, s] of doc.scripts.entries()) {
    if (!s || typeof s !== "object" || Array.isArray(s)) fail(`scripts[${i}] must be an object`);
    exactKeys(s, ["id", "hash", "scope", "source"], `scripts[${i}]`, fail);
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) fail(`scripts[${i}].id must match ${ID_RE}`);
    if (typeof s.hash !== "string" || !HASH_RE.test(s.hash)) fail(`scripts[${i}].hash must match ${HASH_RE}`);
    if (!SCOPES.has(s.scope)) fail(`scripts[${i}].scope must be one of ${[...SCOPES].join(", ")}`);
    if (typeof s.source !== "string" || s.source.trim() === "") fail(`scripts[${i}].source must name where the script lives`);
    if (ids.has(s.id)) fail(`duplicate id ${s.id}`);
    if (hashes.has(s.hash)) fail(`duplicate hash ${s.hash}`);
    ids.add(s.id);
    hashes.add(s.hash);
  }
  return doc;
}

function exactKeys(obj, want, where, fail) {
  const got = Object.keys(obj);
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    fail(`${where} keys must be exactly [${want.join(", ")}] in that order, got [${got.join(", ")}]`);
  }
}

/** The CSP source token for a script's text: sha256 over its UTF-8 bytes. */
export function cspHash(text) {
  return "sha256-" + createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * Classifies a <script> element the way the HTML spec's "prepare the script
 * element" does. Returns "external" | "inline" | "inert", or throws for a type
 * this checker refuses to guess about.
 */
export function classifyScript(el) {
  let type;
  if (el.hasAttribute("type")) {
    type = el.getAttribute("type");
  } else if (el.hasAttribute("language") && el.getAttribute("language") !== "") {
    type = "text/" + el.getAttribute("language");
  } else {
    type = "";
  }
  const t = type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase();
  const runs = type === "" || JS_MIME.has(t) || t === "module";
  if (runs) return el.hasAttribute("src") ? "external" : "inline";
  if (INERT_TYPES.has(t)) return "inert";
  throw new Error(`<script type=${JSON.stringify(type)}> is neither JavaScript nor a named inert data type`);
}

/**
 * Every executable inline script in one HTML document, plus the problems found
 * that no fixture entry could make acceptable (unknown script types, inline
 * event handlers, javascript: URLs — CSP blocks all of these without
 * 'unsafe-inline'/'unsafe-hashes', which this site does not grant).
 * @returns {{ hashes: string[], problems: string[] }}
 */
export function scanHtml(html) {
  const dom = new JSDOM(html);
  try {
    const hashes = [];
    const problems = [];
    for (const el of allElements(dom.window.document)) {
      for (const a of el.attributes) {
        const name = a.name.toLowerCase();
        if (name.startsWith("on")) {
          problems.push(`<${el.localName}> has an inline event handler ${a.name}=`);
        } else if (URL_ATTRS.has(name) && /^javascript:/i.test(a.value.replace(/[\u0000- ]/g, ""))) {
          problems.push(`<${el.localName}> has a javascript: URL in ${a.name}=`);
        }
      }
      if (el.localName !== "script") continue;
      if (el.namespaceURI !== HTML_NS) {
        problems.push(`<script> in namespace ${el.namespaceURI} is not supported by this checker`);
        continue;
      }
      let kind;
      try {
        kind = classifyScript(el);
      } catch (err) {
        problems.push(err.message);
        continue;
      }
      if (kind === "inline") hashes.push(cspHash(el.textContent));
    }
    return { hashes, problems };
  } finally {
    dom.window.close();
  }
}

// Every element, including the contents of <template>s, which a script can
// clone into the live document.
function* allElements(root) {
  for (const el of root.querySelectorAll("*")) {
    yield el;
    if (el.localName === "template" && el.content) yield* allElements(el.content);
  }
}

/**
 * Checks a set of pages against the fixture.
 * @param {{ path: string, html: string }[]} pages
 * `scan` exists so a test that re-checks mostly unchanged pages can memoize
 * scanHtml; everything else leaves it alone.
 * @returns {{ errors: string[], counts: Map<string, number>, pages: number }}
 *   counts is fixture id → number of pages carrying it.
 */
export function checkPages(
  pages,
  fixture,
  { minPages = MIN_PAGES, requirePaths = ["index.html"], scan = scanHtml } = {},
) {
  const errors = [];
  const byHash = new Map(fixture.scripts.map((s) => [s.hash, s]));
  const counts = new Map(fixture.scripts.map((s) => [s.id, 0]));
  if (pages.length < minPages) {
    errors.push(`only ${pages.length} pages to check, expected at least ${minPages} — missing or truncated tree`);
  }
  const paths = new Set(pages.map((p) => p.path));
  for (const want of requirePaths) {
    if (!paths.has(want)) errors.push(`${want}: missing`);
  }
  for (const { path, html } of pages) {
    const { hashes, problems } = scan(html);
    for (const p of problems) errors.push(`${path}: ${p}`);
    const perId = new Map();
    for (const h of hashes) {
      const entry = byHash.get(h);
      if (!entry) {
        errors.push(`${path}: inline script ${h} is not in ${relativeFixture()} — nginx will block it`);
        continue;
      }
      perId.set(entry.id, (perId.get(entry.id) ?? 0) + 1);
    }
    for (const s of fixture.scripts) {
      const n = perId.get(s.id) ?? 0;
      if (n > 0) counts.set(s.id, counts.get(s.id) + 1);
      if (s.scope === "every-page" && n !== 1) {
        errors.push(`${path}: carries ${s.id} ${n} times, expected exactly once`);
      }
    }
  }
  for (const s of fixture.scripts) {
    if (counts.get(s.id) === 0) {
      errors.push(`${s.id} (${s.hash}) is on no page — stale fixture entry, or its script stopped being emitted`);
    }
  }
  return { errors, counts, pages: pages.length };
}

function relativeFixture() {
  return relative(resolve(here, ".."), FIXTURE_PATH);
}

/** Every *.html under dir as { path, html }, with paths relative to dir using "/". */
export function readHtmlTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith(".html")) {
        out.push({ path: relative(dir, p).split(sep).join("/"), html: readFileSync(p, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The CLI: checks a built tree. Besides the fixture rules, every page the
 * generator produces must be present in it, so a partial copy of dist/ fails
 * even when it still has more than MIN_PAGES pages. That list is used only to
 * say which files must EXIST; the bytes checked are the built ones.
 */
export async function checkDist(dir, { fixturePath = FIXTURE_PATH } = {}) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { errors: [`${dir}: not a directory — run npm run build first`], counts: new Map(), pages: 0 };
  }
  const fixture = loadFixture(fixturePath);
  const { buildAllPages } = await import("./gen-pages.mjs");
  const generated = buildAllPages().map((p) => p.path);
  const pages = readHtmlTree(dir);
  return { ...checkPages(pages, fixture, { requirePaths: ["index.html", ...generated] }), fixture };
}

async function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: node scripts/check-csp-inline.mjs <built-dir>");
    return 2;
  }
  let result;
  try {
    result = await checkDist(resolve(argv[0]));
  } catch (err) {
    console.error(`check-csp-inline: ${err.message}`);
    return 1;
  }
  if (result.errors.length) {
    for (const e of result.errors) console.error(`check-csp-inline: ${e}`);
    console.error(`check-csp-inline: ${result.errors.length} problem(s) in ${result.pages} pages`);
    return 1;
  }
  const summary = result.fixture.scripts.map((s) => `${s.id} ${s.hash} on ${result.counts.get(s.id)} pages`).join("; ");
  console.log(`ok check-csp-inline: ${result.pages} pages, every executable inline script allowed; ${summary}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
