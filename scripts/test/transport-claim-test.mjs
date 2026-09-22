#!/usr/bin/env node
// scripts/test/transport-claim-test.mjs — how Relayium describes WHICH WIRE a
// transfer takes, on every maintained surface that describes it.
//
// ## What it guards, and why it exists at all
//
// Until 2026-09-22 the CLI's pairing modes were described with a product-level
// pledge — "the CLI never relays file bytes" — instead of a fact about those
// modes. The sentence was TRUE (there is no ICE or TURN code path in
// `server/cmd/relayium/`), and that is exactly why nothing caught it: a guard
// looking for falsehood finds none. What it cost was different. Stated as an
// identity rather than as a property of two modes, it read as a promise the
// product had made, and a design question — should the CLI be able to reach an
// app, which means speaking the apps' relayed transport — kept arriving at it
// as if at a wall. The owner's instruction on 2026-09-22 was to stop being
// misled by it ("不然总是被这个所谓的产品承诺误导").
//
// So this file pins the SHAPE of the claim, not its truth:
//
//   1. the confidentiality invariant stays absolute and unqualified — nothing
//      Relayium runs can read a user's files, on ANY path, relayed included;
//   2. the path fact is attributed to the MODE and in the present tense;
//   3. the retired product-level pledges do not come back.
//
// ## What it deliberately does NOT do
//
// It is not a repo-wide grep for "never relay". Two places say something very
// like it and are right to:
//
//   - `server/cmd/relayium/run.go`'s `push`/`pull`/`serve` usage ("no relay, no
//     Relayium account"). Those modes are ADDRESSED, not rendezvous-based:
//     there is no third party in the design at all, so it is not a property of
//     today's build that could change quietly. `help_test.go` owns that string.
//   - the frozen locales of `cliDirectFacts` (ja, ko, de, fr, ar, pt, es …).
//     Under the supported-language policy those are archived translations, not
//     maintained copy, and the sentence they carry is still factually true, so
//     it is not "publicly misleading" in the sense that policy cares about.
//     Only `en` and `zh` are maintained, and only those two are checked here.
//
// ## Why it lives here and not in Vitest
//
// The claim spans `server/`, `README.md`, `docs/` and `web/`. `web.yml` starts
// on `web/**` alone, so a CLI-only commit that re-absolutised the help text
// would run no web lane. `repo-hygiene.yml` has no path filter.
//
// ## Why it proves itself
//
// A claim check over a file that was never read, or through a matcher that
// cannot match, is as green as a true claim. After the real evaluation every
// claim is re-evaluated against an in-memory world with exactly one fact
// broken, and each mutation must turn exactly its own claim red.

import { readFileSync } from "node:fs";

const EXPECTED_CLAIMS = 10;

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const realWorld = () => ({
  help: read("server/cmd/relayium/help.go"),
  crossnet: read("server/cmd/relayium/crossnet.go"),
  readme: read("README.md"),
  en: read("web/src/lib/i18n/en.ts"),
  zh: read("web/src/lib/i18n/zh.ts"),
  facts: read("web/scripts/pages/content/realtime-facts.mjs"),
  spa: read("web/scripts/pages/content/spa-pages.mjs"),
  billing: read("docs/billing-transparency.md"),
});

// Every retired pledge, in both maintained languages. A surface that carries one
// of these has gone back to describing a mode's limit as the product's identity.
const RETIRED = [
  "the CLI never relays file bytes",
  "the CLI never proxies file bytes",
  "CLI 从不中继文件字节",
  "they never relay file or message bytes",
  "文件或消息字节绝不会通过",
];

const has = (hay, needle) => hay.includes(needle);
const hasNone = (hay, needles) => needles.filter((n) => hay.includes(n));

function evaluate(w) {
  const out = [];
  const claim = (id, ok, why) => out.push({ id, ok, why });

  // 1-3. The three CLI usage texts attribute the limit to the mode.
  claim("help|send-mode-scoped", has(w.help, "This mode\nis direct-only") || has(w.help, "This mode is direct-only"),
    "`relayium send --help` no longer says the limit belongs to this mode");
  claim("help|receive-mode-scoped", has(w.help, "mode is direct-only: if no direct path can be found"),
    "`relayium receive --help` no longer says the limit belongs to this mode");
  claim("help|text-mode-scoped", has(w.help, 'this\nmode is direct-only like "send"/"receive"'),
    "`relayium text --help` does not state the direct-only limit it has");

  // 4. The help text names what DOES relay, so the reader can place the limit.
  claim("help|names-the-relayed-path", has(w.help, "the web page relay a\ncross-network transfer by design"),
    "the CLI help no longer tells the reader which paths are relayed");

  // 5. The source comment is a description of these modes, not of the product.
  claim("crossnet|comment-mode-scoped", has(w.crossnet, "The pairing-code modes are direct-only"),
    "crossnet.go describes the CLI rather than its pairing-code modes");

  // 6-8. The user-facing surfaces, in both maintained languages.
  claim("readme|mode-scoped", has(w.readme, "This mode is direct-only: with no direct path"),
    "README's send/receive bullet no longer scopes the limit to the mode");
  claim("cli-page|en-mode-scoped", has(w.en, "This mode is direct-only, so if both ends are behind strict NAT"),
    "/cli's English note no longer scopes the limit to the mode");
  claim("cli-page|zh-mode-scoped", has(w.zh, "这个模式只走直连"),
    "/cli's Simplified Chinese note no longer scopes the limit to the mode");

  // 9. The invariant stays absolute, and stays separate from the path fact.
  claim("billing|invariant-separate", has(w.billing, "no path lets relayium.com read a file"),
    "billing-transparency no longer states the invariant separately from the path fact");

  // 10. No maintained surface carries a retired pledge. The frozen locales of
  // `cliDirectFacts` are excluded by construction: only the `en:` and `zh:`
  // lines of that file are searched.
  const factsMaintained = w.facts
    .split("\n")
    .filter((l) => /^\s*(en|zh):/.test(l))
    .join("\n");
  const offenders = [
    ...hasNone(w.help, RETIRED).map((s) => `help.go: ${s}`),
    ...hasNone(w.crossnet, RETIRED).map((s) => `crossnet.go: ${s}`),
    ...hasNone(w.readme, RETIRED).map((s) => `README.md: ${s}`),
    ...hasNone(w.en, RETIRED).map((s) => `i18n/en.ts: ${s}`),
    ...hasNone(w.zh, RETIRED).map((s) => `i18n/zh.ts: ${s}`),
    ...hasNone(factsMaintained, RETIRED).map((s) => `realtime-facts en/zh: ${s}`),
    ...hasNone(w.spa, RETIRED).map((s) => `spa-pages.mjs: ${s}`),
    ...hasNone(w.billing, RETIRED).map((s) => `billing-transparency.md: ${s}`),
  ];
  claim("all|no-retired-pledge", offenders.length === 0,
    `a retired product-level pledge is back: ${offenders.join("; ")}`);

  return out;
}

// One broken fact each. A claim that was never seen red proves nothing.
const MUTATIONS = {
  "help|send-mode-scoped": (w) => ({ ...w, help: w.help.replaceAll("This mode\nis direct-only", "The CLI is direct-only") }),
  "help|receive-mode-scoped": (w) => ({ ...w, help: w.help.replace("mode is direct-only: if no direct path can be found", "the CLI never relays, so if no direct path is found") }),
  "help|text-mode-scoped": (w) => ({ ...w, help: w.help.replace('this\nmode is direct-only like "send"/"receive"', "this is a direct session") }),
  "help|names-the-relayed-path": (w) => ({ ...w, help: w.help.replace("the web page relay a\ncross-network transfer by design", "the web page behave differently") }),
  "crossnet|comment-mode-scoped": (w) => ({ ...w, crossnet: w.crossnet.replace("The pairing-code modes are direct-only", "The CLI is direct-only") }),
  "readme|mode-scoped": (w) => ({ ...w, readme: w.readme.replace("This mode is direct-only: with no direct path", "There is no relay: with no direct path") }),
  "cli-page|en-mode-scoped": (w) => ({ ...w, en: w.en.replace("This mode is direct-only, so if both ends are behind strict NAT", "The CLI is direct-only, so if both ends are behind strict NAT") }),
  "cli-page|zh-mode-scoped": (w) => ({ ...w, zh: w.zh.replace("这个模式只走直连", "CLI 只走直连") }),
  "billing|invariant-separate": (w) => ({ ...w, billing: w.billing.replace("no path lets relayium.com read a file", "relayium.com cannot meter a direct transfer") }),
  "all|no-retired-pledge": (w) => ({ ...w, readme: `${w.readme}\n\nthe CLI never relays file bytes\n` }),
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
  console.error(`\ntransport-claim: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`ok transport-claim: ${real.length} claims true, ${Object.keys(MUTATIONS).length} mutations each red for its own claim`);
