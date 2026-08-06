// web/scripts/pages/guides-tutorial-structure.test.mjs — the eight guides of the
// third tutorial batch, in all nine locales.
//
// ── THE THING THIS BATCH HAD TO DECIDE, AND WHY IT IS ASSERTED HERE ─────────
// The first two batches were homogeneous: every article was a procedure, so
// every article got prerequisites, numbered steps, an expected result and
// troubleshooting. This batch is not. Five of these eight tell you how to set
// something up. The other three explain how something works, and giving an
// explainer invented "installation steps" would have produced a fake tutorial —
// a page that looks like the others and teaches a procedure nobody performs.
//
// So the classification is part of the content, not a private note: PROCEDURAL
// articles carry a setup procedure, EXPLAINER articles carry a VERIFICATION
// procedure — a way for the reader to check the claim the article just made,
// which is the one genuinely actionable thing an explainer has to offer.
//
// The partition is asserted to be TOTAL and DISJOINT. A ninth article added to
// this batch without a decision about which kind it is fails here, which is the
// whole point: the next person has to make the same call deliberately rather
// than inheriting whichever list they happened to edit.
//
// ── WHAT ELSE HAS TEETH ─────────────────────────────────────────────────────
//  1. Presence per article PER LOCALE. Not "somewhere in the corpus": all 72
//     documents carry their class's blocks.
//  2. Semantics in the OUTPUT. A procedure has to reach the page as a real <ol
//     data-block="steps">, so it survives a reordered step, a screen reader and
//     reader-mode extraction. A "1." typed into the text survives none of those
//     and is rejected outright.
//  3. Locale alignment, structurally and on every command: the nine locales must
//     agree on how many steps there are and on the literal text of every code
//     block, because a translated flag is a command that does not run.
//  4. A contract on troubleshooting that DIFFERS BY CLASS. A procedural check
//     must be executable — a command line whose first token is a real program.
//     An explainer's check is a thing to go and look at, so a URL qualifies;
//     "check your network" qualifies as neither.
//  5. Prose must not contain markdown. This template escapes and does not
//     render, so a backtick or a ** reaches the page literally. Both shipped
//     once in this batch and were caught before release; the guard is here so
//     the third time is caught by CI instead of by a person.
//  6. Mutation proofs at the bottom: the validator, run over a document with its
//     troubleshooting removed and over one whose steps were demoted to bullets,
//     must FAIL. A guard nobody has watched fail is not a guard.
import { describe, it, expect } from "vitest";

import selfHost from "./content/articles/guides-self-host.mjs";
import ownNode from "./content/articles/guides-own-node.mjs";
import alwaysOn from "./content/articles/guides-always-on-service.mjs";
import receiveCli from "./content/articles/guides-receive-from-cli.mjs";
import serverBackups from "./content/articles/howto-automate-server-backups.mjs";
import whatIsP2p from "./content/articles/guides-what-is-p2p-file-transfer.mjs";
import howEncryption from "./content/articles/guides-how-encryption-works.mjs";
import isItSafe from "./content/articles/guides-is-it-safe.mjs";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import { buildArticlePages } from "./build-pages.mjs";
import { LANGS } from "./shared.mjs";

/** Set up something. The reader ends with a thing running that was not before. */
const PROCEDURAL = {
  "guides-self-host": selfHost,
  "guides-own-node": ownNode,
  "guides-always-on-service": alwaysOn,
  "guides-receive-from-cli": receiveCli,
  "howto-automate-server-backups": serverBackups,
};

/** Explain something. The procedure they carry is how to CHECK what was said. */
const EXPLAINER = {
  "guides-what-is-p2p-file-transfer": whatIsP2p,
  "guides-how-encryption-works": howEncryption,
  "guides-is-it-safe": isItSafe,
};

const BATCH = { ...PROCEDURAL, ...EXPLAINER };
const REVISED = "2026-08-06";

const sections = (doc) => doc.sections || [];
const withPrereqs = (doc) => sections(doc).filter((s) => s.prereqs);
const withSteps = (doc) => sections(doc).filter((s) => s.steps?.length);
const withSuccess = (doc) => sections(doc).filter((s) => s.success);
const withTrouble = (doc) => sections(doc).filter((s) => s.troubleshooting);

/** Every code block a section can hold, in render order. */
const sectionCode = (s) => [
  ...(s.code || []),
  ...(s.steps || []).flatMap((step) => step.code || []),
  ...(s.success?.code || []),
  ...(s.troubleshooting?.items || []).flatMap((i) => i.code || []),
];

/**
 * Programs a PROCEDURAL troubleshooting check may invoke. The allowlist is the
 * point of the rule: a "check" that is a sentence rather than something you can
 * run has no first token in it, so it fails. Every entry appears in one of these
 * five guides today — extend it deliberately.
 */
const RUNNABLE = new Set([
  "command", "curl", "docker", "grep", "journalctl", "relayium",
  "ssh", "stat", "sudo", "systemctl", "tail",
]);

/** An EXPLAINER check may instead be a place to go and look. */
const isLookable = (first) => /^https:\/\/(relayium\.com|github\.com)\//.test(first);

const firstToken = (block) => block.split("\n")[0].trim().split(/\s+/)[0];

/** Strings a reader reads, as opposed to blocks a reader pastes. */
function proseStrings(doc) {
  const code = new Set(sections(doc).flatMap(sectionCode));
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") {
      if (!code.has(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(sections(doc));
  return out;
}

/**
 * Complaints about one document. A list rather than an assertion so the mutation
 * tests at the bottom can run it over a deliberately broken document and demand
 * it speaks up.
 */
function validate(name, lang, doc, enDoc, { explainer }) {
  const at = `${name}[${lang}]`;
  const bad = [];
  if (!doc) return [`${at}: missing`];

  if (!withPrereqs(doc).length) bad.push(`${at}: no prerequisites`);
  if (!withSteps(doc).length) bad.push(`${at}: no ordered procedure`);
  if (!withSuccess(doc).length) bad.push(`${at}: no expected result`);
  if (!withTrouble(doc).length) bad.push(`${at}: no troubleshooting`);

  // A numeral at the head of a step is a second numbering scheme fighting the
  // <ol>, and the one that does not survive a reorder.
  for (const s of withSteps(doc)) {
    for (const [i, step] of s.steps.entries()) {
      if (/^\s*\(?\d+[.)、．]/.test(step.text)) {
        bad.push(`${at}: step ${i} types its own number — ${JSON.stringify(step.text.slice(0, 40))}`);
      }
    }
  }

  for (const s of withTrouble(doc)) {
    for (const [i, item] of s.troubleshooting.items.entries()) {
      if (!item.code?.length) {
        bad.push(`${at}: troubleshooting ${i} has no check`);
        continue;
      }
      const first = firstToken(item.code[0]);
      const ok = explainer ? isLookable(first) || RUNNABLE.has(first) : RUNNABLE.has(first);
      if (!ok) bad.push(`${at}: troubleshooting ${i} check is not actionable — ${JSON.stringify(first)}`);
      if (!item.fix?.trim()) bad.push(`${at}: troubleshooting ${i} has no fix`);
    }
  }

  // The template escapes and does not render markdown, so either of these
  // reaches the reader as punctuation.
  for (const s of proseStrings(doc)) {
    if (s.includes("**")) bad.push(`${at}: ** in prose reaches the page literally`);
    // Any backtick, not just one wrapping an identifier: `docker compose ps`
    // renders as literally as `Dockerfile` does, and an earlier, narrower
    // version of this rule missed exactly that shape. No article in this batch
    // quotes program output that genuinely contains a backtick — if one ever
    // does, the exception belongs here tied to the source that prints it, the
    // way cli-getting-started's nine are.
    if (s.includes("`")) bad.push(`${at}: backticks in prose reach the page literally`);
  }

  if (enDoc) {
    const mine = withSteps(doc).map((s) => s.steps.length).join("/");
    const theirs = withSteps(enDoc).map((s) => s.steps.length).join("/");
    if (mine !== theirs) bad.push(`${at}: ${mine} steps against English's ${theirs}`);

    // Commands and expected output are the same bytes in every language; only
    // the `#` comments inside them are translated (content/GLOSSARY.md). Strip
    // the comments — a whole line, or a trailing one — and compare what is left,
    // which is exactly the half a reader pastes into a shell. The trailing
    // pattern needs whitespace on BOTH sides of the `#` so a `#k=` fragment,
    // which carries a decryption key, survives.
    const runnable = (d) =>
      sections(d)
        .flatMap(sectionCode)
        .flatMap((b) => b.split("\n"))
        .map((l) => l.replace(/\s+#\s.*$/, "").trim())
        .filter((l) => l && !l.startsWith("#"))
        .join("\n");
    if (runnable(doc) !== runnable(enDoc)) bad.push(`${at}: a command or an expected output was translated`);
  }
  return bad;
}

describe("the eight guides of the third batch carry their class's tutorial blocks", () => {
  it("classifies every article in the batch as procedural or explainer, with no overlap", () => {
    // The decision this batch had to make, asserted rather than remembered.
    const p = Object.keys(PROCEDURAL);
    const e = Object.keys(EXPLAINER);
    expect(p.filter((k) => e.includes(k)), "an article cannot be both").toEqual([]);
    expect(Object.keys(BATCH)).toHaveLength(p.length + e.length);
    expect(p).toHaveLength(5);
    expect(e).toHaveLength(3);
  });

  it("carries prerequisites, an ordered procedure, an expected result and troubleshooting", () => {
    const bad = [];
    for (const [name, article] of Object.entries(BATCH)) {
      const explainer = name in EXPLAINER;
      for (const lang of LANGS) {
        bad.push(...validate(name, lang, article.langs[lang], lang === "en" ? null : article.langs.en, { explainer }));
      }
    }
    expect(bad).toEqual([]);
  });

  it("covers all eight articles and all nine locales, not a subset", () => {
    // Guards the guard: a renamed import or a shrunken LANGS would otherwise
    // turn every assertion above green by checking nothing.
    expect(Object.keys(BATCH)).toHaveLength(8);
    expect(LANGS).toHaveLength(9);
    for (const [name, article] of Object.entries(BATCH)) {
      expect(Object.keys(article.langs), name).toEqual([...LANGS]);
      for (const lang of LANGS) {
        expect(sections(article.langs[lang]).length, `${name}[${lang}]`).toBeGreaterThan(2);
      }
    }
  });

  it("publishes the rewrite date for every article in the batch", () => {
    for (const [name, article] of Object.entries(BATCH)) {
      expect(article.updated, name).toBe(REVISED);
    }
  });

  it("renders the procedure as a real ordered list, in every locale", () => {
    const bad = [];
    for (const [name, article] of Object.entries(BATCH)) {
      for (const page of buildArticlePages([article])) {
        if (!/<ol class="steps" data-block="steps">/.test(page.html)) {
          bad.push(`${name}: ${page.path} has no <ol data-block="steps">`);
        }
        // The four blocks are the reason the CSS ships; a page carrying one
        // without the other would render unstyled.
        if (!page.html.includes("ol.steps{")) bad.push(`${name}: ${page.path} uses a block but ships no block CSS`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("leaves an unrelated prose article byte-for-byte free of all of it", () => {
    const plain = buildArticlePages([compareSnapdrop])[0].html;
    expect(plain).not.toContain('data-block="');
    expect(plain).not.toContain("ol.steps{");
  });

  it("holds explainers to a check you can go and look at, not a command they do not have", () => {
    // The rule that differs by class, stated positively so it cannot rot into
    // "explainers are exempt". Every explainer check is still SOMETHING —
    // it just does not have to be a shell command.
    const bad = [];
    for (const [name, article] of Object.entries(EXPLAINER)) {
      for (const s of withTrouble(article.langs.en)) {
        for (const [i, item] of s.troubleshooting.items.entries()) {
          const first = firstToken(item.code[0]);
          if (!isLookable(first) && !RUNNABLE.has(first)) bad.push(`${name}: check ${i} is ${JSON.stringify(first)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── MUTATION PROOFS ─────────────────────────────────────────────────────────
// Each runs the validator over a deliberately broken copy and demands it speak
// up. Without these, every assertion above could be vacuously true.
describe("the guard fails on the shapes it exists to reject", () => {
  const clone = (doc) => JSON.parse(JSON.stringify(doc));

  it("notices troubleshooting that was removed", () => {
    const doc = clone(selfHost.langs.en);
    for (const s of doc.sections) delete s.troubleshooting;
    expect(validate("mutant", "en", doc, null, { explainer: false })).toContain("mutant[en]: no troubleshooting");
  });

  it("notices a procedure demoted from an ordered list to bullets", () => {
    const doc = clone(selfHost.langs.en);
    for (const s of doc.sections) {
      if (s.steps) {
        s.bullets = [...(s.bullets || []), ...s.steps.map((x) => x.text)];
        delete s.steps;
      }
    }
    expect(validate("mutant", "en", doc, null, { explainer: false })).toContain("mutant[en]: no ordered procedure");
  });

  it("notices a step that types its own number", () => {
    const doc = clone(selfHost.langs.en);
    withSteps(doc)[0].steps[0].text = `1. ${withSteps(doc)[0].steps[0].text}`;
    expect(validate("mutant", "en", doc, null, { explainer: false }).join("\n")).toMatch(/types its own number/);
  });

  it("notices a troubleshooting check that is a sentence rather than a check", () => {
    const doc = clone(selfHost.langs.en);
    withTrouble(doc)[0].troubleshooting.items[0].code = ["check your network settings"];
    expect(validate("mutant", "en", doc, null, { explainer: false }).join("\n")).toMatch(/not actionable/);
  });

  it("notices markdown that would reach the page as punctuation", () => {
    const doc = clone(selfHost.langs.en);
    withSteps(doc)[0].steps[0].text = "Run `docker compose ps` and **look**";
    const out = validate("mutant", "en", doc, null, { explainer: false }).join("\n");
    expect(out).toMatch(/backticks in prose/);
    expect(out).toMatch(/\*\* in prose/);
  });

  it("notices a translated command", () => {
    const doc = clone(selfHost.langs.en);
    const target = withSteps(doc).find((s) => s.steps.some((x) => x.code?.length));
    target.steps.find((x) => x.code?.length).code[0] = "docker composer ps";
    expect(validate("mutant", "de", doc, selfHost.langs.en, { explainer: false }).join("\n")).toMatch(
      /a command or an expected output was translated/,
    );
  });

  it("notices an explainer check that is neither runnable nor lookable", () => {
    const doc = clone(whatIsP2p.langs.en);
    withTrouble(doc)[0].troubleshooting.items[0].code = ["think about your network"];
    expect(validate("mutant", "en", doc, null, { explainer: true }).join("\n")).toMatch(/not actionable/);
  });
});
