// web/scripts/pages/billing-doc-pointers.test.mjs — docs/billing-transparency.md
// opens by promising "a file/function pointer for every claim, so a skeptical
// reader can verify it rather than take our word for it". That promise is the
// document; a pointer that no longer resolves does not merely age, it converts
// the doc's central feature into a way to waste a reader's time.
//
// And it is the failure mode with no natural symptom. Nothing builds these
// numbers, nothing reads them, and every edit anywhere in `server/` can move
// them by a line or fifty. On 2026-08-06 roughly a dozen had drifted — including
// the schema table, whose rows were off by 9-25 lines each — while the document
// still read as authoritative.
//
// So this pins the pattern the document actually uses: a backticked SYMBOL
// followed by a backticked `path:line`, e.g.
//
//     `handleICE` (`account/turn.go:63`)
//
// and asserts the symbol really is defined at that line. Where a pointer names
// a range (`:53-68`) the symbol must appear somewhere inside it.
//
// **Deliberately not asserted:** that every claim HAS a pointer. That is an
// editorial judgement about prose, and a test that demanded one per paragraph
// would be satisfied by decorative ones. This checks only that the pointers
// present are true.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const docPath = resolve(repoRoot, "docs/billing-transparency.md");

/// Where a bare `account/foo.go` style pointer is rooted. The document writes
/// server paths without the `server/` prefix — that is its own convention, and
/// changing the doc to spell it out would be churn for no reader's benefit.
/// The document's schema table also cites a BARE filename — `sqlite.go:48` —
/// because within that table the package is obvious from context. Those resolve
/// through the same list.
const ROOTS = ["server", "", "web", "server/account", "server/internal"];

function resolveDocPath(relative) {
  for (const root of ROOTS) {
    const candidate = root ? resolve(repoRoot, root, relative) : resolve(repoRoot, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/// Every `` `symbol` (`path:line`) `` or `` `symbol` (`path:line-line`) `` pair.
///
/// The symbol must be a plain identifier — the document also writes prose in
/// backticks, and matching those would produce noise rather than coverage.
function pointerPairs(markdown) {
  // **Only the `symbol` (`path:line`) shape, and that is a decision rather than
  // an oversight.**
  //
  // The document also writes the pointer first — (`account/handlers.go:515`,
  // `handleMeUsage`) — and a widened pattern to catch that was tried and
  // reverted. On this corpus it found zero further real defects and four false
  // ones, because in prose the token after a pointer is not reliably its
  // symbol: `false` in "(`account/nodes.go:1252`) — i.e. `false` for a
  // self-hosted node"; the *next* pointer's symbol in "(`turn.go:122`,
  // `turnCredentials` at `turn.go:273`)"; and the first of two in
  // "(`account/stripe.go:311`, `EnsureCustomer`/`CreateCheckoutSession`)".
  //
  // This repository has already settled that trade-off once, for the locale
  // register lint: enforce only what is mechanically decidable with zero false
  // positives, because a check that cries wolf gets suppressed and then protects
  // nothing. The pointer-first occurrences were verified by hand on 2026-08-06 —
  // all four were wrong, one naming the wrong FILE (`ReserveUpload` cited in
  // `files.go`, defined in `sqlite.go`) — and are simply not machine-checked.
  const pattern =
    /`([A-Za-z_][A-Za-z0-9_.]*)`[^`\n]{0,12}\n?[^`\n]{0,12}`([A-Za-z0-9_/.-]+\.(?:go|ts|mjs|svelte)):(\d+)(?:-(\d+))?`/g;
  const found = [];
  for (const m of markdown.matchAll(pattern)) {
    found.push({
      symbol: m[1],
      path: m[2],
      start: Number(m[3]),
      end: m[4] ? Number(m[4]) : Number(m[3]),
      context: m[0],
    });
  }
  return found;
}

/// The last path component of a dotted symbol — the document writes
/// `s.overTraffic` and `Worker.handle`, and what is on the line is the method
/// name.
function leaf(symbol) {
  const parts = symbol.split(".");
  return parts[parts.length - 1];
}

describe("docs/billing-transparency.md file:line pointers", () => {
  const markdown = readFileSync(docPath, "utf8");
  const pairs = pointerPairs(markdown);

  it("finds pointers to check, so a doc rewrite cannot silently empty this test", () => {
    // A floor rather than an exact count: the document is expected to grow.
    // Without it, deleting every pointer would make this file pass loudest.
    expect(pairs.length).toBeGreaterThanOrEqual(20);
  });

  it("names only files that exist", () => {
    const missing = pairs
      .filter((p) => resolveDocPath(p.path) === null)
      .map((p) => `${p.path} (cited for ${p.symbol})`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("points at the line the symbol is actually on", () => {
    // A window rather than an exact line. A pointer is a reader's aid, not a
    // cursor position: landing a few lines above a function — on its doc comment
    // or its receiver — is correct and normal, and demanding exactness would
    // make this test fail on formatting.
    const WINDOW = 6;
    const wrong = [];
    for (const p of pairs) {
      const file = resolveDocPath(p.path);
      if (!file) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      const from = Math.max(0, p.start - 1 - WINDOW);
      const to = Math.min(lines.length, p.end + WINDOW);
      const slice = lines.slice(from, to).join("\n");
      if (!slice.includes(leaf(p.symbol))) {
        // Where it actually lives, so the failure is a fix instruction rather
        // than a puzzle.
        const actual = lines.findIndex((l) => l.includes(leaf(p.symbol)));
        wrong.push(
          `${p.path}:${p.start}${p.end !== p.start ? `-${p.end}` : ""} cites \`${p.symbol}\`` +
            (actual >= 0 ? ` — nearest definition is line ${actual + 1}` : " — symbol not found in file"),
        );
      }
    }
    expect(wrong).toEqual([]);
  });
});
