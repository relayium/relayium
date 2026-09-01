// web/scripts/pages/cli-mode-chooser.test.mjs — the two things the CLI-page
// batch changed in the articles, and could only half-finish.
//
// ── 1. Dates that track the rewrite that actually happened ──────────────────
// Six of the nine CLI documents were factually rewritten in that batch: the
// receiver guide, the SSH copy guide, the cron guide, the Cloud async guide, the
// server-to-server guide and this getting-started guide. Their `updated` did not
// move with them, so every one of those pages told a reader — and told Google's
// `dateModified` — that its corrected claims were a month old. The other three
// CLI guides were NOT touched, and pinning all nine to one date would have been
// the same lie in the other direction. So the set is enumerated, both halves are
// asserted, and the generated HTML is checked too: a source date that never
// reaches `public/` is a date nobody reads.
//
// ── 2. A chooser that listed three of seven modes ───────────────────────────
// "The three ways it moves files" predates Cloud, Device Inbox, `text` and
// `sync` being page-level modes. A reader who came to the guide to decide got a
// list that could not answer their question and did not say so — and it sat one
// section above a "Free, and private by design" paragraph that counted "the
// three direct ways above", so the contradiction was inside the article as well
// as against the product.
//
// The rule below is exact coverage, not "mentions seven things": the maintained
// chooser is exactly seven bullets, one per mode, in the accepted order. Not
// "seven mode bullets plus something else" — a chooser is a list you count, and
// an eighth bullet is an eighth thing to choose between whatever its text says.
// The shared direct-only boundary (content/realtime-facts.mjs' cliDirectFacts)
// used to sit here as that eighth bullet; it is now the tail of the
// send / receive bullet, verbatim, which is one of the two modes it is about.
// Order matters because /cli presents the same seven in that order — a reader
// moving between the two surfaces is reading one list.
//
// English and Simplified Chinese only. The seven archived translations keep
// their prose under the language freeze (PROJECT-GOVERNANCE.md), which is
// asserted here rather than assumed: a later batch that "refreshes" them has to
// do it deliberately.
import { describe, it, expect } from "vitest";

import cliGettingStarted from "./content/articles/cli-getting-started.mjs";
import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import cliCloudAsync from "./content/articles/cli-cloud-async.mjs";
import cliServerToServer from "./content/articles/cli-server-to-server.mjs";
import guidesReceiveFromCli from "./content/articles/guides-receive-from-cli.mjs";
import howtoAutomateBackups from "./content/articles/howto-automate-server-backups.mjs";
import cliSendToSomeone from "./content/articles/cli-send-to-someone.mjs";
import cliSyncLargeFolder from "./content/articles/cli-sync-large-folder.mjs";
import guidesDeviceInboxServer from "./content/articles/guides-device-inbox-server.mjs";
import { cliDirectFacts } from "./content/realtime-facts.mjs";
import { buildArticlePages } from "./build-pages.mjs";
import { LANGS, MAINTAINED_LANGS, FROZEN_LANGS } from "./shared.mjs";

const REWRITTEN_ON = "2026-09-01";

/** The six documents this batch factually rewrote, and nothing else. */
const REWRITTEN = {
  "cli-getting-started": cliGettingStarted,
  "cli-backup-server-ssh": cliBackupSsh,
  "cli-cloud-async": cliCloudAsync,
  "cli-server-to-server": cliServerToServer,
  "guides-receive-from-cli": guidesReceiveFromCli,
  "howto-automate-server-backups": howtoAutomateBackups,
};

/** The other three CLI guides. Untouched, so their own dates stand. */
const UNTOUCHED = {
  "cli-send-to-someone": cliSendToSomeone,
  "cli-sync-large-folder": cliSyncLargeFolder,
  "guides-device-inbox-server": guidesDeviceInboxServer,
};

/**
 * The date each rewritten document carried before this batch. Written down so
 * the generated-output rule can assert the old value is gone rather than only
 * that the new one is present — a template that printed both would otherwise
 * pass.
 */
const STALE_BEFORE = {
  "cli-getting-started": "2026-08-07",
  "cli-backup-server-ssh": "2026-08-05",
  "cli-cloud-async": "2026-08-05",
  "cli-server-to-server": "2026-08-05",
  "guides-receive-from-cli": "2026-08-06",
  "howto-automate-server-backups": "2026-08-06",
};

describe("the rewritten CLI guides carry the date of their rewrite", () => {
  it("dates exactly the six documents this batch rewrote", () => {
    expect(Object.keys(REWRITTEN)).toHaveLength(6);
    for (const [name, article] of Object.entries(REWRITTEN)) {
      expect(article.updated, name).toBe(REWRITTEN_ON);
    }
  });

  it("leaves the CLI guides it did not touch on their earlier dates", () => {
    // The guard that gives the rule above its teeth. Without it, "set every CLI
    // article to today" passes the first test and republishes three documents as
    // freshly reviewed when nobody read them.
    expect(Object.keys(UNTOUCHED)).toHaveLength(3);
    for (const [name, article] of Object.entries(UNTOUCHED)) {
      expect(article.updated, `${name} was re-dated without being rewritten`).not.toBe(
        REWRITTEN_ON,
      );
      expect(article.updated < REWRITTEN_ON, `${name} is dated after the rewrite`).toBe(true);
    }
  });

  it("publishes the new date into every generated page, and drops the old one", () => {
    // `updated` reaches the reader twice per page — the visible "Last updated"
    // line and JSON-LD's dateModified — and reaches search engines a third time
    // through the sitemap's <lastmod>. A source date that was never regenerated
    // is a date nobody reads.
    const stale = new Map(
      Object.entries(REWRITTEN).map(([name, a]) => [name, STALE_BEFORE[name]]),
    );
    for (const [name, article] of Object.entries(REWRITTEN)) {
      const pages = buildArticlePages([article]);
      expect(pages, name).toHaveLength(LANGS.length);
      for (const page of pages) {
        expect(page.html, `${name}: ${page.path} dateModified`).toContain(
          `"dateModified":"${REWRITTEN_ON}"`,
        );
        expect(page.html, `${name}: ${page.path} visible date`).toContain(
          `<bdi>${REWRITTEN_ON}</bdi>`,
        );
        expect(page.html, `${name}: ${page.path} still shows ${stale.get(name)}`).not.toContain(
          stale.get(name),
        );
      }
    }
  });
});

// ── The seven-mode chooser ──────────────────────────────────────────────────

/**
 * The seven modes in /cli's accepted order, keyed by the label the bullet opens
 * with. The labels are identical in English and Chinese because they are command
 * surfaces — a translated command is a command that does not run — and that is
 * exactly why one table can police both languages. `Device Inbox` is the one
 * named in prose rather than by a command, because the CLI has no command that
 * sends into one.
 */
const MODES = [
  { key: "cloud", label: "relayium up / relayium down" },
  { key: "inbox", label: "Device Inbox" },
  { key: "text", label: "relayium text" },
  { key: "sendReceive", label: "relayium send / relayium receive" },
  { key: "pushPull", label: "relayium push / relayium pull" },
  { key: "serve", label: "relayium serve + relayium push relayium://" },
  { key: "sync", label: "relayium sync" },
];

/** The chooser section: the one whose bullets enumerate the modes. */
const chooser = (lang) => cliGettingStarted.langs[lang].sections[1];

/**
 * The mode a bullet opens with, or null when it is not a mode bullet.
 *
 * A mode bullet is "<label><gloss?> — <what it is>", with the em dash spaced in
 * English and unspaced in Chinese, and an optional parenthesised gloss on the
 * two labels a reader would not recognise from the command alone ("(Cloud)",
 * "（daemon 直连）"). Everything up to that dash, minus the gloss, is the label —
 * so the rule reads the same structure in both languages instead of two tables
 * of prose.
 */
const modeOf = (bullet) => {
  const head = bullet
    .split(/\s—\s|——/)[0]
    .replace(/\s*[（(][^）)]*[）)]\s*$/, "")
    .trim();
  return MODES.find((m) => m.label === head)?.key ?? null;
};

describe("the getting-started chooser covers all seven modes", () => {
  for (const lang of MAINTAINED_LANGS) {
    it(`${lang}: names exactly the seven modes, in the accepted order`, () => {
      const listed = chooser(lang)
        .bullets.map((b) => modeOf(b))
        .filter(Boolean);
      expect(listed).toEqual(MODES.map((m) => m.key));
    });

    it(`${lang}: is seven bullets and seven modes — there is no eighth of anything`, () => {
      // Not "at least seven": a chooser is a list the reader counts, so an extra
      // bullet is an extra option no matter what its text says. The one that used
      // to be here was the shared direct-only boundary, which is a property of two
      // of the modes rather than a mode — so it moved into the bullet it qualifies.
      const bullets = chooser(lang).bullets;
      expect(bullets).toHaveLength(MODES.length);
      expect(bullets.filter((b) => !modeOf(b))).toEqual([]);
    });

    it(`${lang}: keeps the shared direct-only fact verbatim, on the send/receive bullet`, () => {
      // Folded, not rewritten: realtime-facts.test.mjs owns the sentence itself
      // and counts its references, so a paraphrase here would be a second,
      // drifting copy of a boundary that has exactly one authority.
      const sendReceive = chooser(lang).bullets.find((b) => modeOf(b) === "sendReceive");
      expect(sendReceive).toContain(cliDirectFacts[lang]);
      // And nowhere else in the section: two copies of it is the eighth bullet
      // again, wearing a different hat.
      const carriers = chooser(lang).bullets.filter((b) => b.includes(cliDirectFacts[lang]));
      expect(carriers).toHaveLength(1);
    });

    it(`${lang}: says the lost link costs the key, not the stored file`, () => {
      // "losing the link loses the file" reads as "the file is gone". It is not:
      // Relayium still holds the ciphertext until retention expires, and what the
      // link carried was the only key that opens it. The difference matters to a
      // reader deciding whether to also keep the file somewhere else, and to one
      // who has already lost a link and is deciding whether to ask support to
      // recover it — nobody can, and the reason is the key, not the storage.
      const cloud = chooser(lang).bullets.find((b) => modeOf(b) === "cloud");
      expect(cloud, `${lang} has no Cloud bullet`).toBeTruthy();
      expect(cloud).not.toMatch(
        lang === "en" ? /los(?:ing|es|t) the link loses the file/i : /链接丢了文件也就丢了|文件就(?:丢|没)了/,
      );
      expect(cloud).toMatch(lang === "en" ? /key that can decrypt it/i : /能解密它的唯一密钥/);
      expect(cloud).toMatch(lang === "en" ? /stays stored/i : /会一直存到/);
    });

    it(`${lang}: says Device Inbox is the receive side only`, () => {
      // The mode most likely to be half-stated: its sender is a browser or a
      // native app, and a reader who takes it for a CLI mode goes looking for a
      // `relayium inbox send` that does not exist.
      const inbox = chooser(lang).bullets.find((b) => modeOf(b) === "inbox");
      expect(inbox, `${lang} has no Device Inbox bullet`).toBeTruthy();
      expect(inbox).toMatch(lang === "en" ? /RECEIVE side only/ : /只有接收侧/);
      expect(inbox).toMatch(
        lang === "en" ? /no CLI command that sends into an inbox/i : /没有任何命令能往收件箱里发送/,
      );
    });

    it(`${lang}: no longer counts the modes as three, anywhere in the document`, () => {
      // The heading was one half of it; "the three direct ways above", one
      // section below, was the other. Correcting only the first leaves the
      // article contradicting itself.
      const all = JSON.stringify(cliGettingStarted.langs[lang]);
      expect(all).not.toMatch(lang === "en" ? /\bthree (?:ways|direct ways|modes)\b/i : /三种(?:方式|传输方式|直连方式)|三者之中/);
    });

    it(`${lang}: adds no blanket verification or resume promise`, () => {
      // What the old chooser opened with: "they share one transfer engine, which
      // verifies each file it moves with a SHA-256 hash". The tar fallback
      // verifies nothing per file, so that sentence was untrue for the very mode
      // the section recommended most.
      const section = JSON.stringify(chooser(lang));
      expect(section).not.toMatch(/one transfer engine|同一个传输引擎/);
      expect(section).not.toMatch(
        lang === "en" ? /verifies each file it moves/i : /对自己搬运的每个文件做/,
      );
    });
  }

  it("leaves the seven archived translations exactly as they were", () => {
    // The language freeze: frozen locales take language-neutral safety and
    // command corrections, not a prose refresh. Their chooser still carries the
    // four bullets it shipped with, and this is what makes changing that a
    // deliberate act rather than a side effect.
    expect(FROZEN_LANGS).toHaveLength(7);
    for (const lang of FROZEN_LANGS) {
      expect(chooser(lang).bullets, lang).toHaveLength(4);
    }
    for (const lang of MAINTAINED_LANGS) {
      expect(chooser(lang).bullets, lang).toHaveLength(MODES.length);
    }
  });
});
