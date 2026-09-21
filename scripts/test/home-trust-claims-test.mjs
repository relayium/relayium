#!/usr/bin/env node
// scripts/test/home-trust-claims-test.mjs — the home page's trust block says
// four things about this repository; this checks that all four are still true.
//
// ## What it guards
//
// `web/src/lib/HomeTrust.svelte` renders "Every claim here can be checked": read
// the code, read the protocol, check the connection yourself, verify what you
// install. Each row is a sentence of fact about something OUTSIDE `web/` — the
// three LICENSE files, `docs/protocol/`, `.github/workflows/release.yml`, a
// section of the root `README.md` — and each of those can change in a commit
// that touches nothing under `web/`.
//
// ## Why it lives here and not in Vitest
//
// `web.yml` starts on `web/**` alone. A README-only commit that renames
// "### Verify a download" breaks the link the install row sends visitors to, and
// no web lane runs; the next unrelated web push would find `main` red. That is
// the 2026-09-20 incident shape (`document-claims-test.mjs` has the history).
// `repo-hygiene.yml` has no path filter, so this runs on the commit that edits
// the copy AND on the commit that edits the thing the copy describes.
//
// This file OWNS these claims. `web/src/lib/HomeTrust.test.ts` pins the
// component's structure and must not grow a second copy of them.
//
// ## Why it proves itself
//
// A claim check over a file that was never read, or through a matcher that
// cannot match, is as green as a true claim. So after the real evaluation every
// claim is re-evaluated against an in-memory world with exactly one fact broken,
// and must go red — and ONLY that claim may go red. The number of claims is held
// to a literal so one cannot be dropped silently.
//
// No dependencies, so there is nothing to install.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(resolve(repoRoot, p), "utf8");

const EXPECTED_CLAIMS = 10;
const REPO_URL = "https://github.com/relayium/relayium";
const VERIFY_HEADING = "### Verify a download";

/** Everything the claims look at, read once, so a mutation can replace one fact. */
function realWorld() {
  return {
    en: read("web/src/lib/i18n/en.ts"),
    zh: read("web/src/lib/i18n/zh.ts"),
    links: read("web/src/lib/home-trust-links.ts"),
    serverLicense: read("server/LICENSE"),
    appsLicense: read("apps/LICENSE"),
    docsLicense: read("docs/LICENSE"),
    protocolFiles: readdirSync(resolve(repoRoot, "docs/protocol")),
    release: read(".github/workflows/release.yml"),
    readme: read("README.md"),
  };
}

/** The `homeTrust: { … }` object literal of one catalogue, as source text. */
function trustBlock(catalogue) {
  const start = catalogue.indexOf("\n  homeTrust: {");
  if (start < 0) return "";
  const end = catalogue.indexOf("\n  },", start);
  return end < 0 ? "" : catalogue.slice(start, end);
}

/** The README section the install row links to, up to the next heading. */
function verifySection(readme) {
  const at = readme.split("\n").findIndex((line) => line === VERIFY_HEADING);
  if (at < 0) return "";
  const rest = readme.split("\n").slice(at + 1);
  const next = rest.findIndex((line) => /^#{1,3} /.test(line));
  return rest.slice(0, next < 0 ? undefined : next).join("\n");
}

function evaluate(w) {
  const results = [];
  const claim = (id, ok, why) => results.push({ id, ok: ok === true, why });
  const en = trustBlock(w.en);
  const zh = trustBlock(w.zh);

  // A catalogue with no homeTrust block fails here too: an empty block names no
  // licence. One claim per language rather than a separate "present" claim, so
  // that every claim can be broken on its own.
  for (const [lang, block] of [["en", en], ["zh", zh]]) {
    claim(`copy|${lang}-licences`,
      block.includes("AGPL-3.0") && block.includes("Apache-2.0") && block.includes("CC BY 4.0") && !/\bMIT\b/.test(block),
      `${lang}: a homeTrust block must exist, name AGPL-3.0, Apache-2.0 and CC BY 4.0, and must not say MIT (the repository was relicensed)`);
  }
  claim("licence|server-agpl3", /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/.test(w.serverLicense),
    "server/LICENSE is no longer AGPL-3.0, but the home page says the server, web app and CLI are");
  claim("licence|apps-apache2", /Apache License\s+Version 2\.0/.test(w.appsLicense),
    "apps/LICENSE is no longer Apache-2.0, but the home page says the native apps are");
  claim("licence|docs-ccby4", /Attribution 4\.0 International/.test(w.docsLicense),
    "docs/LICENSE is no longer CC BY 4.0, but the home page says the protocol specifications are");
  claim("protocol|link", w.links.includes(`"${REPO_URL}/tree/main/docs/protocol"`),
    "the protocol row must link to docs/protocol on main");
  claim("protocol|versioned-specs", w.protocolFiles.filter((f) => /-v\d+\.md$/.test(f)).length >= 5,
    "docs/protocol no longer holds versioned specifications, but the home page says the protocol is written down as them");
  claim("release|attests-every-family",
    /uses:\s*actions\/attest-build-provenance@/.test(w.release)
      && ["dist/relayium_*.tar.gz", "dist/relayium_*.zip", "dist/relayium-node_*.tar.gz"].every((s) => w.release.includes(s)),
    "release.yml no longer attests every archive family, but the home page says every CLI release carries an attestation");
  claim("verify|link", w.links.includes(`"${REPO_URL}#verify-a-download"`),
    "the install row must link to the README's #verify-a-download anchor");
  const section = verifySection(w.readme);
  claim("verify|readme-section",
    section.includes("gh attestation verify") && section.includes("--repo relayium/relayium"),
    `README.md must keep a "${VERIFY_HEADING}" section (GitHub derives the anchor from that exact text) that shows the verify command`);
  return results;
}

// One broken fact per claim. Each must turn exactly its own claim red.
const MUTATIONS = {
  "copy|en-licences": (w) => ({ ...w, en: w.en.replace("under AGPL-3.0", "under MIT") }),
  "copy|zh-licences": (w) => ({ ...w, zh: w.zh.replace("以 AGPL-3.0 开源", "以 MIT 开源") }),
  "licence|server-agpl3": (w) => ({ ...w, serverLicense: "MIT License\n" }),
  "licence|apps-apache2": (w) => ({ ...w, appsLicense: "MIT License\n" }),
  "licence|docs-ccby4": (w) => ({ ...w, docsLicense: "All rights reserved.\n" }),
  "protocol|link": (w) => ({ ...w, links: w.links.replace("/tree/main/docs/protocol", "/tree/main/docs/specs") }),
  "protocol|versioned-specs": (w) => ({ ...w, protocolFiles: ["README.md"] }),
  "release|attests-every-family": (w) => ({ ...w, release: w.release.replace("dist/relayium_*.zip", "") }),
  "verify|link": (w) => ({ ...w, links: w.links.replace("#verify-a-download", "#verifying") }),
  "verify|readme-section": (w) => ({ ...w, readme: w.readme.replace(VERIFY_HEADING, "### Verifying downloads") }),
};

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

const world = realWorld();
const real = evaluate(world);
for (const r of real) if (!r.ok) fail(`${r.id}: ${r.why}`);
if (real.length !== EXPECTED_CLAIMS) fail(`evaluated ${real.length} claims, expected ${EXPECTED_CLAIMS} — a claim was added or dropped without updating the literal`);
const ids = real.map((r) => r.id);
for (const id of ids) if (!(id in MUTATIONS)) fail(`${id}: no mutation — a claim that was never seen red proves nothing`);
for (const id of Object.keys(MUTATIONS)) if (!ids.includes(id)) fail(`${id}: mutation for a claim that does not exist`);

if (failed === 0) {
  for (const [id, mutate] of Object.entries(MUTATIONS)) {
    const mutated = mutate(world);
    if (JSON.stringify(mutated) === JSON.stringify(world)) { fail(`${id}: the mutation changed nothing — its anchor text is gone`); continue; }
    const red = evaluate(mutated).filter((r) => !r.ok).map((r) => r.id);
    if (red.length !== 1 || red[0] !== id) fail(`${id}: mutation turned [${red.join(", ") || "nothing"}] red, expected exactly itself`);
  }
}

if (failed > 0) {
  console.error(`\nhome-trust-claims: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`ok home-trust-claims: ${real.length} claims true, ${Object.keys(MUTATIONS).length} mutations each red for its own claim`);
