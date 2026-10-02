// web/scripts/pages/cli-billing-accounting.test.mjs — routing is not billing.
//
// A CLI pairing-code session (send / receive, text, pair) is relayed whenever
// the server issues a TURN relay for the code. Whether those relayed bytes
// then count toward the code owner's monthly traffic allowance is a separate
// fact, decided by the relay that carried them:
//
//   - a Relayium fleet relay node reports its bytes over the node heartbeat,
//     stored billable for fleet nodes (server/account/nodes.go) — they count;
//   - coturn bills nothing today. Its legacy Redis ingest is disabled
//     (server/main.go guardCoturnRedisMetering). Its re-keyed accounting ingest
//     is OFF by default: the route exists only when -coturn-metering-relays is
//     configured (server/main.go coturnMeteringRoute), and production does not
//     configure it. IF it is configured, its default shadow mode records
//     measurements but never writes the billable ledger, usage periods or any
//     allowance (server/account/coturn_metering_store.go ApplyCoturnSnapshot).
//     So the copy must never say the bridge runs, or that measurements are
//     being recorded now — only what happens if it is configured.
//
// Until 2026-10-02 every maintained public surface said the opposite in one
// sentence: every relayed byte counts. This file pins the conditional form on
// the maintained (en, zh) copy that is actually exported and rendered — the
// article documents' default exports, realtime-facts, the legal documents, the
// /pricing and /cli shells and the i18n catalogues — and on the twelve
// generated HTML files those sources produce. It also refuses the opposite
// overclaim, that relaying is free: fleet relay nodes really do bill. The
// coturn exception applies to browser and CLI sessions alike, so the generic
// browser relay statements on the same pages are pinned billable-only too.
//
// It deliberately does not test the `currentEn` / `currentZh` objects at the
// bottom of cli-getting-started.mjs and guides-receive-from-cli.mjs: neither
// is exported, so no page renders them. The seven archived locales are frozen
// translations and are out of scope here (archived-fact-errata.test.mjs).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliDirectFacts } from "./content/realtime-facts.mjs";
import cliGettingStarted from "./content/articles/cli-getting-started.mjs";
import cliSendToSomeone from "./content/articles/cli-send-to-someone.mjs";
import receiveFromCli from "./content/articles/guides-receive-from-cli.mjs";
import security from "./content/legal/security.mjs";
import privacy from "./content/legal/privacy.mjs";
import { pricing, cli, deviceInbox } from "./content/spa-pages.mjs";
import { buildShells } from "./shells.mjs";
import { CLI_ARTICLES } from "./content/cli-articles.mjs";
import en from "../../src/lib/i18n/en";
import zh from "../../src/lib/i18n/zh";

const MAINTAINED = ["en", "zh"];
const PUBLIC = path.resolve(import.meta.dirname, "..", "..", "public");

// ---------------------------------------------------------------- helpers

/** Every string reachable from a value, depth first. */
function strings(value, out = [], seen = new Set()) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) strings(v, out, seen);
  }
  return out;
}

const MINTER = {
  en: /(minted the code|code's minter|code creator's (monthly|account))/,
  zh: /(生成配对码那个账号|生成码的账号|配对码创建端的?账号)/,
};
// "attribute" is a counting verb here: privacy's "we attribute relayed-byte
// totals to the code creator's account" is the same claim as "counts toward".
const COUNTS = { en: /\b(count|counts|counted|counting|metered|attribute|attributed)\b/, zh: /计入|归属到/ };
// The condition itself, not merely a word near it: "billed" in a disclaimer
// ("not by itself a billed one", "并不等于被计费") must not satisfy it.
const CONDITION = { en: /billable (relay )?usage/, zh: /计费用量/ };
const clauses = (text) => text.split(/[.;](?=\s)|[。；]/);

/** Clauses that charge the code owner's allowance with no billable-usage condition. */
function unconditional(lang, text) {
  return clauses(text).filter(
    (c) => MINTER[lang].test(c) && COUNTS[lang].test(c) && !CONDITION[lang].test(c),
  );
}
/** Clauses that state the conditional rule (so the scan above is not vacuous). */
function conditional(lang, text) {
  return clauses(text).filter(
    (c) => MINTER[lang].test(c) && COUNTS[lang].test(c) && CONDITION[lang].test(c),
  );
}

const ALL_RELAY_FREE = [
  /\b(all|every|any) relay(ed)? (traffic|bytes?|sessions?|transfers?)\b[^.]{0,40}\b(free|unmetered|never (counted|metered|billed)|not (counted|metered|billed))\b/i,
  /\brelay(ing|ed traffic)? is (always |never |)free\b/i,
  /\brelayed bytes (are|is) never (counted|metered|billed)\b/i,
  /所有(经)?中继(的)?(流量|字节|会话)?[^。]{0,20}(免费|不计)/,
  /中继(流量)?(始终|总是|一律|永远)免费/,
];
const allRelayFree = (text) => ALL_RELAY_FREE.filter((re) => re.test(text)).map(String);

// Who reports billable usage, and the durable coturn state: bills nothing
// today, optional ingest off by default, shadow only IF configured.
const WHO = {
  en: { bills: /relay nodes? Relayium operates/, coturn: /coturn TURN servers bill nothing today/, qualifier: /if configured in shadow mode/i },
  zh: { bills: /Relayium 运营的中继节点/, coturn: /coturn TURN 服务器目前不计费/, qualifier: /如果配置为影子模式/ },
};

// The r1 state claims this batch retired: coturn "currently only measures",
// the bridge "runs" in shadow mode, measurements "are" recorded. Production
// runs no bridge ingest, so each is a false statement about the present.
const FALSE_CURRENT_STATE = [
  /currently only measure/i,
  /is currently only measured/i,
  /\bruns measure-only\b/i,
  /\b(bridge|ingest) (runs|is running|is active|is on)\b/i,
  /\bmeasurement records (are|is) (currently )?(kept|recorded)\b/i,
  /目前只测量/,
  /目前只做测量/,
  /(正在|已经)以影子模式运行/,
];
const falseCurrentState = (text) => FALSE_CURRENT_STATE.filter((re) => re.test(text)).map(String);

/** Sentences that describe coturn/ingest measurements without the IF-configured qualifier. */
function unqualifiedMeasurement(text) {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？])/)
    .filter((s) => /coturn|bridge|\bingest\b|采集/i.test(s) && /measure|测量/i.test(s))
    .filter((s) => !/if configured in shadow mode|如果配置为影子模式/i.test(s));
}

function htmlText(file) {
  return fs
    .readFileSync(path.join(PUBLIC, file), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (s) => (s.includes("application/ld+json") ? s : " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ----------------------------------------------------- the maintained sources

const articles = { cliGettingStarted, cliSendToSomeone, receiveFromCli };
const shells = buildShells({ pricing, cli, deviceInbox, cliArticles: CLI_ARTICLES });
const cliShell = shells.find((s) => s.file === "cli.html").body;
const pricingShell = shells.find((s) => s.file === "pricing.html").body;

/** [name, lang, text] for every maintained source this batch owns. */
const SOURCES = [
  ...MAINTAINED.map((lang) => [`realtime-facts cliDirectFacts.${lang}`, lang, cliDirectFacts[lang]]),
  ...Object.entries(articles).flatMap(([name, doc]) =>
    MAINTAINED.map((lang) => [`${name}.langs.${lang}`, lang, strings(doc.langs[lang]).join("\n")]),
  ),
  ...MAINTAINED.map((lang) => [`security.langs.${lang}`, lang, strings(security.langs[lang]).join("\n")]),
  ...MAINTAINED.map((lang) => [`privacy.langs.${lang}`, lang, strings(privacy.langs[lang]).join("\n")]),
  ["i18n en.pricingPage", "en", strings(en.pricingPage).join("\n")],
  ["i18n zh.pricingPage", "zh", strings(zh.pricingPage).join("\n")],
  ["i18n en.cliPage", "en", strings(en.cliPage).join("\n")],
  ["i18n zh.cliPage", "zh", strings(zh.cliPage).join("\n")],
  ["spa-pages pricing", "en", strings(pricing).join("\n")],
  ["spa-pages cli", "en", strings(cli).join("\n")],
  ["shell cli.html", "en", cliShell],
  ["shell pricing.html", "en", pricingShell],
];

// The twelve tracked outputs gen-pages writes from those sources.
const GENERATED = [
  ["guides/transfer-files-from-terminal/index.html", "en"],
  ["guides/send-a-file-to-someone/index.html", "en"],
  ["guides/receive-files-from-the-command-line/index.html", "en"],
  ["guides/what-is-peer-to-peer-file-transfer/index.html", "en"],
  ["security/index.html", "en"],
  ["privacy/index.html", "en"],
  ["zh/guides/transfer-files-from-terminal/index.html", "zh"],
  ["zh/guides/send-a-file-to-someone/index.html", "zh"],
  ["zh/guides/receive-files-from-the-command-line/index.html", "zh"],
  ["zh/guides/what-is-peer-to-peer-file-transfer/index.html", "zh"],
  ["zh/security/index.html", "zh"],
  ["zh/privacy/index.html", "zh"],
];

// ------------------------------------------------------------------- tests

describe("CLI relay billing is conditional on the relay, in the maintained sources", () => {
  it.each(SOURCES)("%s: no clause charges the code owner unconditionally", (_name, lang, text) => {
    expect(unconditional(lang, text)).toEqual([]);
  });

  it.each(SOURCES)("%s: states the conditional rule and who bills", (_name, lang, text) => {
    expect(conditional(lang, text).length).toBeGreaterThan(0);
    expect(text).toMatch(WHO[lang].bills);
    expect(text).toMatch(WHO[lang].coturn);
    expect(text).toMatch(WHO[lang].qualifier);
  });

  it.each(SOURCES)("%s: coturn ingest is default-off, shadow only if configured", (_name, _lang, text) => {
    expect(falseCurrentState(text)).toEqual([]);
    expect(unqualifiedMeasurement(text)).toEqual([]);
  });

  it.each(SOURCES)("%s: never says relaying is free", (_name, _lang, text) => {
    expect(allRelayFree(text)).toEqual([]);
  });

  it("keeps the routing, encryption and older-peer facts the billing fix sits beside", () => {
    for (const lang of MAINTAINED) {
      const page = lang === "en" ? en.cliPage : zh.cliPage;
      const notes = page.modes.sendReceive.notes.join(" ");
      // Routing: relay-only whenever a relay is issued, peer to peer otherwise.
      expect(cliDirectFacts[lang]).toMatch(lang === "en" ? /whenever the server issues one for the code/ : /只要服务器为这个码签发了 TURN 中继/);
      expect(notes).toMatch(lang === "en" ? /Only when no relay is issued/ : /只有在没有签发中继时/);
      // Ciphertext only.
      expect(notes).toMatch(lang === "en" ? /ciphertext it cannot read/ : /读不了的密文/);
      // The current link's SAS comes from the exchanged keys; the older CLI pairing is unchanged.
      expect(notes).toMatch(lang === "en" ? /derived from the keys the two ends exchanged/ : /交换的密钥/);
      expect(notes).toMatch(lang === "en" ? /older CLI-to-CLI pairing is used unchanged/ : /旧的 CLI 对 CLI 配对/);
      // Usage accounting, not a per-transfer fee; direct server-to-server stays unmetered.
      const pricingText = strings(lang === "en" ? en.pricingPage : zh.pricingPage).join(" ");
      expect(pricingText).toMatch(lang === "en" ? /not a per-transfer charge/ : /不是按次收费/);
      expect(pricingText).toMatch(lang === "en" ? /use no allowance/ : /不占用任何额度/);
    }
  });

  it("covers the exported article documents, not the unexported current* objects", () => {
    for (const doc of Object.values(articles)) {
      expect(Object.keys(doc.langs)).toEqual(expect.arrayContaining(MAINTAINED));
    }
    // The shared CLI relay fact is what the three CLI-routing articles render.
    expect(strings(cliGettingStarted.langs.en)).toContain(cliDirectFacts.en);
    expect(strings(cliSendToSomeone.langs.zh)).toContain(cliDirectFacts.zh);
  });
});

describe("the twelve generated pages carry the same conditional fact", () => {
  it.each(GENERATED)("%s", (file, lang) => {
    const text = htmlText(file);
    expect(unconditional(lang, text)).toEqual([]);
    expect(conditional(lang, text).length).toBeGreaterThan(0);
    expect(text).toMatch(WHO[lang].coturn);
    expect(text).toMatch(WHO[lang].qualifier);
    expect(falseCurrentState(text)).toEqual([]);
    expect(unqualifiedMeasurement(text)).toEqual([]);
    expect(allRelayFree(text)).toEqual([]);
  });

  it("each guide renders the current shared fact verbatim", () => {
    for (const [file, lang] of GENERATED.filter(([f]) => /guides\/(transfer-files|send-a-file|what-is-peer)/.test(f))) {
      expect(htmlText(file), file).toContain(cliDirectFacts[lang]);
    }
  });
});

describe("generic browser relay statements on the same pages are billable-only", () => {
  it("pricing subtitle (app, /pricing shell) bills only billable relay traffic", () => {
    expect(en.pricingPage.subtitle).toMatch(/^Same-network[^.]*\. Billable cross-network relay traffic and hosted links draw on/);
    expect(pricing.description ?? strings(pricing).join(" ")).toContain(en.pricingPage.subtitle);
    expect(zh.pricingPage.subtitle).toContain("计费的跨网络中继流量与托管链接占用");
    expect(pricingShell).not.toMatch(/\. Cross-network relay and hosted links draw on/);
  });

  it("security records only billable relayed-byte counts, in both languages", () => {
    const enSec = strings(security.langs.en).join("\n");
    const zhSec = strings(security.langs.zh).join("\n");
    expect(enSec).toContain("We record billable relayed-byte counts per account");
    expect(enSec).not.toContain("We record the number of relayed bytes per account");
    expect(zhSec).toContain("我们按账号记录计费中继字节数");
    expect(zhSec).not.toContain("我们按账号记录中继字节数");
  });

  it("privacy attributes relayed bytes only when a relay reports billable usage", () => {
    const enPriv = strings(privacy.langs.en).join("\n");
    const zhPriv = strings(privacy.langs.zh).join("\n");
    expect(enPriv).toContain("when a relay node Relayium operates reports billable usage, we attribute those relayed-byte totals");
    expect(enPriv).toContain("billable relayed-byte totals that relays report for pairing codes you created");
    expect(zhPriv).toContain("Relayium 运营的中继节点上报计费用量时");
    expect(zhPriv).toContain("计费中继字节总量");
    // Retention is stated only for the configured case, never as current fact.
    expect(enPriv).toMatch(/If configured in shadow mode, that ingest records per-allocation measurements that are kept with the code creator's account/);
    expect(zhPriv).toMatch(/如果配置为影子模式，这项采集会记录按分配统计的测量值，随配对码创建端的账号保存/);
  });
});

describe("the checks themselves go red on the retired claims", () => {
  // Verbatim sentences this batch retired. Each must be caught, or the scan
  // above is proving nothing.
  const RETIRED = [
    ["en", "Relay and your allowance: whenever the server issues a relay for the code, every byte goes through that encrypted relay — even when the two ends could reach each other directly, on one LAN too — and counts toward the monthly traffic allowance of the account that minted the code. The relay carries only ciphertext it cannot read."],
    ["en", "A relay sees only ciphertext, but it is not free. When a pairing-code session (pair, send / receive, text) is relayed, the relay cannot read what it carries, and every byte counts toward the traffic allowance of the account that minted the code."],
    ["en", "Through Relayium's relay whenever it issues one (metered to the code's minter); otherwise peer to peer"],
    ["en", "CLI pairing-code sessions (files, text and pair) use TURN whenever the server issues a relay for the code, even when a direct path exists, and their relayed bytes count toward the code creator's monthly relay allowance; only when no relay is issued do they connect directly."],
    ["zh", "中继与你的额度：只要服务器为这个码签发了中继，每个字节都经这条加密中继传输——即使两端本可直接连通，同一局域网内也一样——并计入生成配对码那个账号的每月流量额度。中继只经手它读不了的密文。"],
    ["zh", "服务器签发中继时经 Relayium 中继（计入生成码的账号）；否则点对点"],
    ["zh", "CLI 配对码会话（文件、文本和 pair）只要服务器为该码签发了中继，就使用 TURN，即使存在直连路径也是如此，其中继字节计入配对码创建端账号的每月中继额度；只有在没有签发中继时才直连。"],
  ];
  it.each(RETIRED)("%s retired sentence is caught: %s", (lang, sentence) => {
    expect(unconditional(lang, sentence).length).toBeGreaterThan(0);
  });

  // r1's own wrong current-state wording, verbatim. Each must be caught.
  const R1_FALSE_STATE = [
    "the relay nodes Relayium operates do, while Relayium's coturn TURN servers currently only measure relayed traffic and count none of it toward any allowance.",
    "optional coturn for the TURN relay (its Redis relay-byte ingest is currently disabled; its newer metering bridge runs measure-only in shadow mode).",
    "while traffic through Relayium's coturn TURN servers is currently only measured — those measurement records may be kept with the code creator's account, but they count toward no quota.",
    "而 Relayium 的 coturn TURN 服务器目前只测量中继流量，一个字节也不计入任何额度。",
    "而经 Relayium 的 coturn TURN 服务器的流量目前只做测量——这些测量记录可能随配对码创建端的账号保存，但不计入任何配额。",
  ];
  it.each(R1_FALSE_STATE)("r1 false current state is caught: %s", (sentence) => {
    expect(falseCurrentState(sentence).length + unqualifiedMeasurement(sentence).length).toBeGreaterThan(0);
  });

  it("claiming the bridge already runs, or measurements are recorded now, is caught", () => {
    expect(falseCurrentState("Relayium's coturn metering bridge runs in shadow mode.").length).toBeGreaterThan(0);
    expect(falseCurrentState("Its coturn measurement records are kept with your account.").length).toBeGreaterThan(0);
    expect(falseCurrentState("coturn 计量网桥正在以影子模式运行。").length).toBeGreaterThan(0);
  });

  it("deleting the IF-configured qualifier from a real source turns it red", () => {
    const en = cliDirectFacts.en.replace("if configured in shadow mode, ", "");
    expect(en).not.toBe(cliDirectFacts.en);
    expect(unqualifiedMeasurement(en).length).toBeGreaterThan(0);
    const zhText = cliDirectFacts.zh.replace("如果配置为影子模式，", "");
    expect(zhText).not.toBe(cliDirectFacts.zh);
    expect(unqualifiedMeasurement(zhText).length).toBeGreaterThan(0);
    const priv = strings(privacy.langs.en).join("\n").replace("If configured in shadow mode, that ingest", "That ingest");
    expect(unqualifiedMeasurement(priv).length).toBeGreaterThan(0);
  });

  it("an unconditional browser attribution sentence is caught", () => {
    expect(unconditional("en", "We attribute relayed-byte totals and timestamps to the code creator's account for quotas and abuse prevention.").length).toBeGreaterThan(0);
    expect(unconditional("zh", "为执行配额并防止滥用，我们把中继字节总量与时间戳归属到配对码创建端的账号，但不检查消息或文件明文。").length).toBeGreaterThan(0);
  });

  it("an all-relay-free claim is caught in either language", () => {
    expect(allRelayFree("All relayed traffic is free, whichever relay carries it.").length).toBeGreaterThan(0);
    expect(allRelayFree("Relaying is free.").length).toBeGreaterThan(0);
    expect(allRelayFree("所有中继流量都免费。").length).toBeGreaterThan(0);
  });

  it("removing the condition from a real source turns it red", () => {
    const stripped = cliDirectFacts.en.replace(" when the relay reports them as billable usage", "");
    expect(stripped).not.toBe(cliDirectFacts.en);
    expect(unconditional("en", stripped).length).toBeGreaterThan(0);
    const strippedZh = cliDirectFacts.zh.replace("中继把这些字节上报为计费用量时，它们才", "");
    expect(strippedZh).not.toBe(cliDirectFacts.zh);
    expect(unconditional("zh", strippedZh).length).toBeGreaterThan(0);
  });
});
