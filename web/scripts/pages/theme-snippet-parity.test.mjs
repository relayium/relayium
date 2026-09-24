// The pre-paint theme snippet has to be the SAME three lines in two places, and
// its hash has to be the one nginx allows. This test is what makes that true.
//
// Since 2026-09-21 the generated tree carries the snippet too, so a reader who
// picks Light in the app and then opens a guide from the footer stays in light.
// It works because nginx's CSP allows inline script by sha256 and already
// carries this snippet's hash for web/index.html — an identical copy is
// permitted, and a copy that differs by one character is silently blocked. The
// failure mode is quiet: the page still renders, it just ignores the reader's
// theme, with one console line nobody is watching for.
//
// So three things are pinned here:
//   1. the two copies are byte-identical;
//   2. every generated page emits exactly one of them;
//   3. the hash is the fixture's "theme" entry — the hash nginx carries.
//
// (3) reads csp-inline-scripts-v1.json rather than keeping its own copy of the
// hash: that fixture is the one hand-edited record of what production's
// script-src allows, relayium-ops vendors it, and a second literal here could
// only drift from it. The fixture is never regenerated from the snippet, so an
// edit to the snippet still fails here until someone changes the fixture on
// purpose. csp-headers.test.mjs and scripts/check-csp-inline.mjs hold every
// OTHER inline script (source and built) to the same fixture.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { THEME_SCRIPT } from "./page-chrome.mjs";
import { buildAllPages } from "../gen-pages.mjs";
import { loadFixture } from "../check-csp-inline.mjs";

/** The hash relayium-ops' nginx script-src carries, from the fixture it vendors. */
const theme = loadFixture().scripts.find((s) => s.id === "theme");
const ALLOWED = theme?.hash;

const inner = (block) => /^<script>([\s\S]*)<\/script>$/.exec(block)?.[1];

describe("the pre-paint theme snippet", () => {
  it("is byte-identical to the one in web/index.html", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    // The same extraction server/spa.go's spaScriptHashes uses: the first
    // inline <script> with no src.
    const first = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .find((m) => !m[1].toLowerCase().includes("src="))?.[2];
    expect(first, "no inline script found in index.html").toBeTruthy();
    expect(inner(THEME_SCRIPT), "page-chrome.mjs and index.html have drifted").toBe(first);
  });

  it("hashes to the value nginx allows", () => {
    expect(theme?.scope, "csp-inline-scripts-v1.json has no every-page theme entry").toBe("every-page");
    const got = "sha256-" + createHash("sha256").update(inner(THEME_SCRIPT)).digest("base64");
    expect(
      got,
      "the snippet changed: update the theme entry in scripts/pages/csp-inline-scripts-v1.json to " +
        got + ", then relayium-ops' vendored copy and nginx script-src before promoting",
    )
      .toBe(ALLOWED);
  });

  it("is on every generated page, exactly once", () => {
    const pages = buildAllPages();
    const wrong = pages
      .map((p) => [p.path, p.html.split(THEME_SCRIPT).length - 1])
      .filter(([, n]) => n !== 1);
    expect(wrong.map(([path, n]) => `${path}: ${n}`)).toEqual([]);
    // Guards the guard: an empty tree would satisfy the line above.
    expect(pages.length).toBeGreaterThan(400);
  });
});
