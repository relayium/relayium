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
//   3. the retired product-level pledges do not come back;
//   4. routing is not billing. Which wire carries the bytes says nothing about
//      whether they are billed: relayed bytes count toward the code owner's
//      allowance only when the relay reports them as billable usage. Fleet
//      relay-node heartbeats do (account/nodes.go stores billable for fleet
//      nodes); coturn bills nothing today: its legacy Redis ingest is disabled
//      (main.go guardCoturnRedisMetering), and its re-keyed accounting ingest
//      is off by default — the route exists only when -coturn-metering-relays
//      is configured, and IF configured its default shadow mode never writes
//      the billable ledger (account/coturn_metering_store.go
//      ApplyCoturnSnapshot). So no maintained public surface may say every
//      relayed byte counts, none may say every relayed byte is free, and none
//      may say the coturn ingest is running or measuring now.
//
// The CLI help's own billing sentence (help.go linkRelayPolicy) is owned by
// help_test.go and scripts/test/cli-public-truth-test.sh, not by this file:
// claim 4 below pins only the routing half of it.
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

const EXPECTED_CLAIMS = 19;

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

  // 1-3. The three CLI usage texts attribute the direct-only limit to the
  // older CLI pairing (the wire every released CLI speaks), not to the CLI.
  // Since A10 (2026-09-23) send/receive/text use a link — relayed when TURN is
  // issued — with a current relayium or an app, and keep the older pairing
  // unchanged against an older CLI or a server without pairing hints; the
  // limit belongs to that wire only.
  claim("help|send-mode-scoped", has(w.help, "older CLI pairing is used unchanged: it is direct-only, so without a direct\npath (both ends behind strict NAT) the transfer fails"),
    "`relayium send --help` no longer says the limit belongs to the older CLI pairing");
  claim("help|receive-mode-scoped", has(w.help, "older CLI pairing is used unchanged, and it is direct-only: without a direct\npath the transfer fails"),
    "`relayium receive --help` no longer says the limit belongs to the older CLI pairing");
  claim("help|text-mode-scoped", has(w.help, "older CLI pairing is used unchanged, and it is direct-only: with no direct path\nbetween the two machines the session cannot open"),
    "`relayium text --help` does not state the direct-only limit of the older pairing");

  // 4. The help text names what DOES relay, so the reader can place the limit.
  // This pins routing only — whether the relayed bytes are billed is a separate
  // fact (see 11-18) that help_test.go owns for the help text; help_test.go also
  // ties this sentence to linkrtc.ChooseRTCConfig.
  claim("help|names-the-relayed-path", has(w.help, "whenever the server issues a TURN relay for the\ncode, a link sends every byte through that relay"),
    "the CLI help no longer tells the reader which paths are relayed");

  // 5. The source comment is a description of that wire, not of the product.
  claim("crossnet|comment-mode-scoped", has(w.crossnet, "This wire is direct-only: it races a direct connection"),
    "crossnet.go describes the CLI rather than its older pairing wire");

  // 6-8. The user-facing surfaces, in both maintained languages.
  claim("readme|mode-scoped", has(w.readme, "This mode is direct-only: with no direct path"),
    "README's send/receive bullet no longer scopes the limit to the mode");
  claim("cli-page|en-mode-scoped", has(w.en, "the older CLI-to-CLI pairing is used unchanged: it needs a direct path and fails rather than falling back to a relay"),
    "/cli's English note no longer scopes the limit to the mode");
  claim("cli-page|zh-mode-scoped", has(w.zh, "会原样使用旧的 CLI 对 CLI 配对：它需要一条直连路径，找不到时传输失败，而不是回落到中继"),
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

  // 11-16. Each maintained public surface states the CONDITIONAL billing fact
  // in its own words. Without a positive anchor, deleting the topic would pass
  // the structural check below vacuously.
  claim("billing-scope|readme-conditional", has(w.readme, "reports them as billable usage — the relay nodes Relayium operates do, while Relayium's coturn TURN servers bill nothing today"),
    "README no longer says relayed CLI bytes count only when the relay reports billable usage");
  claim("billing-scope|cli-page-en-conditional", has(w.en, "Those bytes count toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage: the relay nodes Relayium operates do"),
    "/cli's English send/receive note no longer states the conditional billing fact");
  claim("billing-scope|cli-page-zh-conditional", has(w.zh, "中继把这些字节上报为计费用量时，它们才计入生成配对码那个账号的每月流量额度：Relayium 运营的中继节点会这样上报"),
    "/cli's Simplified Chinese send/receive note no longer states the conditional billing fact");
  claim("billing-scope|facts-conditional", has(factsMaintained, "when the relay reports them as billable usage") && has(factsMaintained, "中继把这些字节上报为计费用量时"),
    "realtime-facts en/zh cliDirectFacts no longer state the conditional billing fact");
  claim("billing-scope|cli-shell-conditional", has(w.spa, "when the relay reports it as billable usage (the relay nodes Relayium operates do"),
    "the crawlable /cli shell no longer states the conditional billing fact");
  claim("billing-scope|billing-doc-conditional", has(w.billing, "Routing through a relay is\n  therefore not by itself proof that anything was billed"),
    "billing-transparency no longer separates routing from billing for the CLI");

  // 17. Structural: no clause on a maintained surface says the code owner's
  // allowance is charged without the billable-usage condition in that clause.
  const unconditional = [];
  const scan = (name, text) => {
    for (const clause of text.split(/[.;](?=\s)|[。；]/)) {
      const en = /(minted the code|code's minter|code creator's (monthly|account))/.test(clause) && /\b(count|counts|counted|counting|metered)\b/.test(clause);
      const zh = /(生成配对码那个账号|生成码的账号|配对码创建端的?账号)/.test(clause) && /计入/.test(clause);
      if ((en && !/billable (relay )?usage/.test(clause)) || (zh && !/计费用量/.test(clause))) unconditional.push(`${name}: ${clause.trim().slice(0, 120)}`);
    }
  };
  scan("README.md", w.readme);
  scan("i18n/en.ts", w.en);
  scan("i18n/zh.ts", w.zh);
  scan("realtime-facts en/zh", factsMaintained);
  scan("spa-pages.mjs", w.spa);
  scan("billing-transparency.md", w.billing);
  claim("all|relay-billing-conditional", unconditional.length === 0,
    `a surface says relayed bytes count unconditionally: ${unconditional.join(" | ")}`);

  // 18. The opposite overclaim: no maintained surface says relaying is free.
  // Fleet relay nodes really do bill.
  const ALL_RELAY_FREE = [
    /\b(all|every|any) relay(ed)? (traffic|bytes?|sessions?|transfers?)\b[^.]{0,40}\b(free|unmetered|never (counted|metered|billed)|not (counted|metered|billed))\b/i,
    /\brelay(ing|ed traffic)? is (always |never |)free\b/i,
    /\brelayed bytes (are|is) never (counted|metered|billed)\b/i,
    /所有(经)?中继(的)?(流量|字节|会话)?[^。]{0,20}(免费|不计)/,
    /中继(流量)?(始终|总是|一律|永远)免费/,
  ];
  const freeOffenders = [];
  for (const [name, text] of [["README.md", w.readme], ["i18n/en.ts", w.en], ["i18n/zh.ts", w.zh], ["realtime-facts en/zh", factsMaintained], ["spa-pages.mjs", w.spa], ["billing-transparency.md", w.billing]]) {
    for (const re of ALL_RELAY_FREE) { const m = text.match(re); if (m) freeOffenders.push(`${name}: ${m[0]}`); }
  }
  claim("all|no-all-relay-free", freeOffenders.length === 0,
    `a surface says relaying is free: ${freeOffenders.join(" | ")}`);

  // 19. The coturn accounting ingest is off by default; shadow mode is only
  // what happens IF it is configured. No surface may say it runs or measures
  // now, and every public sentence about its measurements carries the
  // qualifier. billing-transparency's technical config section is checked for
  // the false present-tense forms only.
  const FALSE_STATE = [/currently only measure/i, /is currently only measured/i, /\bruns measure-only\b/i,
    /(?<!When configured, the )\b(bridge|ingest) (runs|is running|is active|is on)\b/i, /目前只测量/, /目前只做测量/, /(正在|已经)以影子模式运行/];
  const stateOffenders = [];
  for (const [name, text, qualify] of [["README.md", w.readme, true], ["i18n/en.ts", w.en, true], ["i18n/zh.ts", w.zh, true],
    ["realtime-facts en/zh", factsMaintained, true], ["spa-pages.mjs", w.spa, true], ["billing-transparency.md", w.billing, false]]) {
    for (const re of FALSE_STATE) { const m = text.match(re); if (m) stateOffenders.push(`${name}: ${m[0]}`); }
    if (!qualify) continue;
    for (const s of text.split(/(?<=[.!?])\s+|(?<=[。！？])/)) {
      if (/coturn|bridge|\bingest\b|采集/i.test(s) && /measure|测量/i.test(s) && !/if configured in shadow mode|如果配置为影子模式/i.test(s))
        stateOffenders.push(`${name}: unqualified: ${s.trim().slice(0, 100)}`);
    }
  }
  claim("all|coturn-ingest-conditional", stateOffenders.length === 0,
    `a surface states the coturn ingest as running/measuring now: ${stateOffenders.join(" | ")}`);

  return out;
}

// One broken fact each. A claim that was never seen red proves nothing.
const MUTATIONS = {
  "help|send-mode-scoped": (w) => ({ ...w, help: w.help.replace("older CLI pairing is used unchanged: it is direct-only, so without a direct\npath (both ends behind strict NAT) the transfer fails", "CLI is direct-only, so without a direct\npath (both ends behind strict NAT) the transfer fails") }),
  "help|receive-mode-scoped": (w) => ({ ...w, help: w.help.replace("older CLI pairing is used unchanged, and it is direct-only: without a direct\npath the transfer fails", "CLI never relays: without a direct\npath the transfer fails") }),
  "help|text-mode-scoped": (w) => ({ ...w, help: w.help.replace("older CLI pairing is used unchanged, and it is direct-only: with no direct path\nbetween the two machines the session cannot open", "session is direct: it cannot open") }),
  "help|names-the-relayed-path": (w) => ({ ...w, help: w.help.replace("whenever the server issues a TURN relay for the\ncode, a link sends every byte through that relay", "a link behaves differently") }),
  "crossnet|comment-mode-scoped": (w) => ({ ...w, crossnet: w.crossnet.replace("This wire is direct-only: it races a direct connection", "The CLI is direct-only: it races a direct connection") }),
  "readme|mode-scoped": (w) => ({ ...w, readme: w.readme.replace("This mode is direct-only: with no direct path", "There is no relay: with no direct path") }),
  "cli-page|en-mode-scoped": (w) => ({ ...w, en: w.en.replace("the older CLI-to-CLI pairing is used unchanged: it needs a direct path and fails rather than falling back to a relay", "the CLI needs a direct path and fails rather than falling back to a relay") }),
  "cli-page|zh-mode-scoped": (w) => ({ ...w, zh: w.zh.replace("会原样使用旧的 CLI 对 CLI 配对：它需要一条直连路径，找不到时传输失败，而不是回落到中继", "CLI 需要一条直连路径，找不到时传输失败，而不是回落到中继") }),
  "billing|invariant-separate": (w) => ({ ...w, billing: w.billing.replace("no path lets relayium.com read a file", "relayium.com cannot meter a direct transfer") }),
  "all|no-retired-pledge": (w) => ({ ...w, readme: `${w.readme}\n\nthe CLI never relays file bytes\n` }),
  "billing-scope|readme-conditional": (w) => ({ ...w, readme: w.readme.replace("reports them as billable usage — the relay nodes Relayium operates do, while Relayium's coturn TURN servers bill nothing today", "reports them as billable usage") }),
  "billing-scope|cli-page-en-conditional": (w) => ({ ...w, en: w.en.replace("Those bytes count toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage: the relay nodes Relayium operates do", "Those bytes count toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage") }),
  "billing-scope|cli-page-zh-conditional": (w) => ({ ...w, zh: w.zh.replace("中继把这些字节上报为计费用量时，它们才计入生成配对码那个账号的每月流量额度：Relayium 运营的中继节点会这样上报", "中继把这些字节上报为计费用量时，它们才计入生成配对码那个账号的每月流量额度") }),
  "billing-scope|facts-conditional": (w) => ({ ...w, facts: w.facts.replace("中继把这些字节上报为计费用量时", "中继把这些字节上报成计费用量时") }),
  "billing-scope|cli-shell-conditional": (w) => ({ ...w, spa: w.spa.replace("when the relay reports it as billable usage (the relay nodes Relayium operates do", "when the relay reports it as billable usage (fleet nodes do") }),
  "billing-scope|billing-doc-conditional": (w) => ({ ...w, billing: w.billing.replace("Routing through a relay is\n  therefore not by itself proof that anything was billed", "Routing through a relay is\n  how it was billed") }),
  // The exact sentence this batch retired from /cli (en.ts cliPage.securityPoints).
  "all|relay-billing-conditional": (w) => ({ ...w, en: `${w.en}\n"When a pairing-code session (pair, send / receive, text) is relayed, the relay cannot read what it carries, and every byte counts toward the traffic allowance of the account that minted the code."\n` }),
  "all|no-all-relay-free": (w) => ({ ...w, zh: `${w.zh}\n"所有中继流量都免费。"\n` }),
  // Deleting the IF-configured qualifier from the maintained facts.
  "all|coturn-ingest-conditional": (w) => ({ ...w, facts: w.facts.replace("如果配置为影子模式，", "") }),
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
