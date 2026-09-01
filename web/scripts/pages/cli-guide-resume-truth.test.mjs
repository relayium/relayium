// web/scripts/pages/cli-guide-resume-truth.test.mjs — what the nine CLI guides
// may say about resume, and what a scheduled job in them may actually run.
//
// ── The defect this exists for ──────────────────────────────────────────────
// "Resumable" was written across this corpus as a property of the product. It is
// not a property of the product; it is a property of three specific modes, and
// two of the three are not what the guides were describing:
//
//   * `relayium sync` resumes ACROSS RUNS — server/internal/xfer/recv.go builds a
//     ResumeState from the bytes already on the receiver's disk, so an
//     interrupted run is continued by the next one (TestNoResumeForcesFullResend
//     is the other half of that contract).
//   * `relayium down` resumes WITHIN ONE RUN — server/internal/cloud/transfer.go's
//     Download loop reconnects up to five attempts and continues with
//     `Range: bytes=<consumed>-` from the last whole frame the Decryptor accepted
//     (TestDownloadResumesAfterMidStreamDrop). When those attempts are spent it
//     removes the partial output, so it does NOT survive the process exiting.
//   * `push` and `pull` never resume at all. The collision check refuses a
//     destination that already exists before any bytes are sent, so a partial
//     file cannot exist for them to continue from, and `--no-resume` is an
//     accepted no-op (server/cmd/relayium/push_resume_contract_test.go).
//
// That last one is not a wording problem, it is a broken instruction. Two guides
// told the reader to schedule `relayium push` nightly into one fixed directory.
// With relayium on the remote — the configuration the same guides recommend — the
// first night succeeds and every night after it is REFUSED, while the prose
// promised the interrupted run would "simply continue the next night".
//
// ── What is asserted, and in which languages ───────────────────────────────
// The claim rules are English-only, for the reason cli-tutorial-structure.mjs
// gives for VAGUE and its other tempered spans: a claim SHAPE in nine languages
// is nine guesses, and a guard that guesses gets suppressed. The SCHEDULING rule
// underneath them is mechanical and therefore runs in all nine, because a crontab
// line is the same bytes in every locale.
import { describe, it, expect } from "vitest";

import cliGettingStarted from "./content/articles/cli-getting-started.mjs";
import cliSendToSomeone from "./content/articles/cli-send-to-someone.mjs";
import cliServerToServer from "./content/articles/cli-server-to-server.mjs";
import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import cliCloudAsync from "./content/articles/cli-cloud-async.mjs";
import cliSyncLargeFolder from "./content/articles/cli-sync-large-folder.mjs";
import guidesReceiveFromCli from "./content/articles/guides-receive-from-cli.mjs";
import howtoAutomateBackups from "./content/articles/howto-automate-server-backups.mjs";
import guidesDeviceInboxServer from "./content/articles/guides-device-inbox-server.mjs";
import { LANGS } from "./shared.mjs";

/** The nine documents the /cli hub links to — content/cli-articles.mjs' set. */
const GUIDES = {
  "cli-getting-started": cliGettingStarted,
  "cli-backup-server-ssh": cliBackupSsh,
  "cli-send-to-someone": cliSendToSomeone,
  "cli-server-to-server": cliServerToServer,
  "cli-sync-large-folder": cliSyncLargeFolder,
  "cli-cloud-async": cliCloudAsync,
  "guides-receive-from-cli": guidesReceiveFromCli,
  "howto-automate-server-backups": howtoAutomateBackups,
  "guides-device-inbox-server": guidesDeviceInboxServer,
};

/** The two that frame themselves as backups, and so carry the extra rules. */
const BACKUP_GUIDES = ["cli-backup-server-ssh", "howto-automate-server-backups"];

const strings = (v) =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const text = (doc) => strings(doc).join("\n");

const sections = (doc) => doc.sections || [];
const codeBlocks = (doc) =>
  sections(doc).flatMap((s) => [
    ...(s.code || []),
    ...(s.steps || []).flatMap((st) => st.code || []),
    ...(s.success?.code || []),
    ...(s.troubleshooting?.items || []).flatMap((i) => i.code || []),
  ]);

// A crontab entry: five schedule fields, then the command. Comments are skipped,
// so a translated `#` line above the entry cannot satisfy or break this.
const CRON_LINE = /^\s*[\d*/,-]+(?:\s+[\d*/,-]+){4}\s+(.*)$/;

const cronCommands = (doc) =>
  codeBlocks(doc)
    .flatMap((b) => b.split("\n"))
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.match(CRON_LINE)?.[1])
    .filter(Boolean);

// ── The claim rules (English) ───────────────────────────────────────────────

// A span that reaches a resume word from `push`/`pull` without passing anything
// that scopes or denies it. Built like cli-tutorial-structure.mjs' ESTAB and ssh
// spans, with one addition they don't need: the negator can also sit just BEFORE
// the command rather than between it and the verb — "Neither push nor pull
// resumes" negates from the left, and reaches the verb from `pull` with nothing
// in between. So the lookbehind covers the preceding clause too. "push does not
// resume" and "Neither push nor pull resumes" both pass; "push … is resumable"
// does not. Sentence-bounded, because the next sentence is a different claim.
const NEGATOR = "not|never|no|nor|neither|nothing|cannot|without|refus\\w*";
const PUSH_RESUMES = new RegExp(
  `(?<!\\b(?:${NEGATOR})\\b[^.\\n]{0,24})` +
    "\\b(?:push|pull)\\b" +
    `(?:(?!\\b(?:${NEGATOR})\\b)[^.\\n])*?` +
    "\\bresum\\w*",
  "i",
);

// The other half: a blanket that never names a mode at all.
const BLANKET_RESUME = new RegExp(
  ["\\ban interrupted transfer resumes\\b", "\\bevery transfer\\b[^.\\n]*\\bresum\\w*"].join("|"),
  "i",
);

describe("no CLI guide credits push or pull with resume", () => {
  it("never lets a resume word attach to push or pull in the English guides", () => {
    const bad = [];
    for (const [name, article] of Object.entries(GUIDES)) {
      for (const s of strings(article.langs.en)) {
        if (PUSH_RESUMES.test(s)) bad.push(`${name}: ${JSON.stringify(s.slice(0, 110))}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("never states resume as a property of transfers in general", () => {
    const bad = [];
    for (const [name, article] of Object.entries(GUIDES)) {
      for (const s of strings(article.langs.en)) {
        if (BLANKET_RESUME.test(s)) bad.push(`${name}: ${JSON.stringify(s.slice(0, 110))}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("still says which modes DO resume, so the rules above are not satisfied by silence", () => {
    // A corpus that simply stopped mentioning resume would pass both rules above
    // and would be worse for the reader than the wrong version: the question
    // "will my interrupted transfer continue?" has an answer and it differs by
    // mode. Anchored on sync (across runs) and down (within one run).
    const corpus = Object.values(GUIDES).map((a) => text(a.langs.en)).join("\n");
    expect(corpus).toMatch(/relayium sync\b[^.\n]*\bcontinue|\bsync\b[^.\n]*\bresum\w*/i);
    expect(corpus, "the Cloud in-run reconnect is stated nowhere").toMatch(/HTTP Range/);
    expect(corpus, "the five-attempt bound is stated nowhere").toMatch(/five attempts/i);
  });

  // The span rule only sees a claim that NAMES the command, and most of the
  // shipped ones did not — "Both are per-file SHA-256 verified and resumable if
  // interrupted", "Resume needs relayium on the remote", "Files are verified …
  // and resume automatically if interrupted". Each sat inside a guide about
  // push, pull or daemon-direct, where the DOCUMENT supplied the mode and the
  // sentence supplied the promise.
  //
  // So the document is the second scope. Two of the nine are about a mode that
  // genuinely resumes and are exempt; in the other seven, an un-negated resume
  // word has to name the mode that actually does it. Naming it is the whole
  // point — "use sync where you need resume" is the sentence a reader can act
  // on, and "resumable" on its own is the one that cost them a night's backup.
  // cli-sync-large-folder and cli-cloud-async are about the two modes that do
  // resume, so "resumes" is the subject rather than an overclaim there — the
  // span rule still polices them. guides-device-inbox-server is exempt for a
  // different reason: its only "resume" is `relayium inbox resume`, the
  // receiver's pause/resume lifecycle, which moves no bytes and continues no
  // transfer. It is named here rather than pattern-matched so that a real
  // transfer claim appearing in it later would have to be exempted deliberately.
  const RESUMING_SUBJECT = new Set([
    "cli-sync-large-folder",
    "cli-cloud-async",
    "guides-device-inbox-server",
  ]);
  const NAMES_A_RESUMING_MODE = /\b(?:sync|down)\b/i;
  // Coarser than the span rule on purpose: at document scope a negator ANYWHERE
  // in the string clears it, because "…refuses a destination that already
  // exists rather than overwriting or resuming" negates from too far away for a
  // bounded lookbehind, and the span rule is the precise instrument. Bare "no"
  // is left out of this set — "no account" would clear half the corpus.
  const DOC_NEGATOR = /\b(?:not|never|nor|neither|nothing|cannot|without|refus\w*)\b/i;
  // `--no-resume` is a flag name, not a denial, and it is exactly what the
  // worst shipped sentence trailed ("…resume automatically … add --no-resume to
  // disable"). Left in, it would clear the sentence it exists to catch.
  const stripFlagName = (s) => s.replaceAll("--no-resume", "");
  // `relayium inbox pause|resume` is a different verb entirely — the receiver's
  // lifecycle, not a transfer continuing.
  const INBOX_LIFECYCLE = /\binbox\b/i;

  const unscopedResume = (name, doc) =>
    RESUMING_SUBJECT.has(name)
      ? []
      : strings(doc)
          .filter((raw) => {
            const s = stripFlagName(raw);
            return (
              /\bresum\w*/i.test(s) &&
              !DOC_NEGATOR.test(s) &&
              !NAMES_A_RESUMING_MODE.test(s) &&
              !INBOX_LIFECYCLE.test(s)
            );
          })
          .map((s) => `${name}: ${JSON.stringify(s.slice(0, 110))}`);

  it("never leaves an un-negated resume word without the mode that does it", () => {
    const bad = [];
    for (const [name, article] of Object.entries(GUIDES)) bad.push(...unscopedResume(name, article.langs.en));
    expect(bad).toEqual([]);
  });

  it("fails on the sentences this corpus actually shipped", () => {
    // Mutation proof. A guard nobody has watched fail is decoration, and each of
    // these is verbatim what one of the nine guides said before this pass. The
    // first names its command and is caught by the span rule; the rest name none
    // and are caught by the document rule.
    expect(
      PUSH_RESUMES.test(
        "If relayium is installed on the remote too, push uses the native protocol (resumable, per-file SHA-256).",
      ),
    ).toBe(true);

    const doc = { sections: [{ heading: "H", bullets: [] }] };
    for (const shipped of [
      "The same transfer engine as the other modes: resumable, with a per-file SHA-256 check.",
      "Both are per-file SHA-256 verified and resumable if interrupted.",
      "Resume needs relayium on the remote (the native protocol); the tar fallback always sends in full.",
      "Files are verified with a per-file SHA-256 check and resume automatically if interrupted (add --no-resume to disable).",
      "An interrupted run simply resumes or catches up on the next scheduled run.",
    ]) {
      doc.sections[0].bullets = [shipped];
      expect(unscopedResume("cli-getting-started", doc), `not caught: ${shipped}`).not.toEqual([]);
    }

    // …and the corrected forms must not trip either rule, or they are unusable.
    for (const corrected of [
      "Neither push nor pull resumes, in either protocol. Use sync for a directory you expect to be interrupted.",
      "push and pull do not resume: they refuse a destination that already exists.",
      "pull does not resume: it refuses a destination that already exists, up front and before anything is fetched.",
      "--no-resume is accepted by push and pull and does nothing there.",
      "Use relayium sync, which is the mode that continues a partial file on a later run.",
    ]) {
      expect(PUSH_RESUMES.test(corrected), `false positive (span): ${corrected}`).toBe(false);
      doc.sections[0].bullets = [corrected];
      expect(unscopedResume("cli-getting-started", doc), `false positive (document): ${corrected}`).toEqual([]);
    }
  });

  it("catches the blanket promise as it was written", () => {
    expect(
      BLANKET_RESUME.test(
        "Every transfer is encrypted end to end, every file is verified with a SHA-256 hash on arrival, and an interrupted transfer resumes from where it stopped instead of starting over.",
      ),
    ).toBe(true);
  });

  it("never says a later relayium down picks up where the last one stopped", () => {
    // The half a reader most wants to be true and which transfer.go explicitly
    // does not do: removePartials runs once the attempts are spent.
    const corpus = Object.values(GUIDES).map((a) => text(a.langs.en)).join("\n");
    expect(corpus).not.toMatch(/relayium down[^.\n]{0,80}\bresumes? on the next run\b/i);
    expect(corpus).not.toMatch(/\bdown\b[^.\n]{0,60}\bresumes? across runs\b/i);
  });
});

// ── The scheduling rule (all nine locales) ──────────────────────────────────

describe("a scheduled push never runs twice into the same destination", () => {
  it("gives every crontab push a fresh destination, in all nine locales", () => {
    // Mechanical, so it holds in Arabic and Japanese exactly as in English:
    // `push` into a fixed path is refused from the second run on, and the only
    // shape that survives repetition is a destination that differs per run.
    const bad = [];
    let seen = 0;
    for (const name of BACKUP_GUIDES) {
      for (const lang of LANGS) {
        for (const cmd of cronCommands(GUIDES[name].langs[lang])) {
          if (!/\brelayium\s+push\b/.test(cmd)) continue;
          seen++;
          if (!cmd.includes("$(date")) {
            bad.push(`${name}[${lang}]: scheduled push into a fixed destination — ${JSON.stringify(cmd)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // Guards the guard: no scheduled push at all would make the rule vacuous.
    expect(seen, "no crontab push left to check").toBeGreaterThan(0);
  });

  it("escapes the percent, or cron truncates the command at it", () => {
    // An unescaped % in a crontab ends the command and sends the rest to the
    // job's stdin, so `$(date +%F)` silently schedules a push with no
    // destination. The JS source needs \\% to emit the single backslash.
    for (const name of BACKUP_GUIDES) {
      for (const lang of LANGS) {
        for (const cmd of cronCommands(GUIDES[name].langs[lang])) {
          if (!cmd.includes("$(date")) continue;
          expect(cmd, `${name}[${lang}]: unescaped % in a crontab line`).toContain("+\\%F");
        }
      }
    }
  });

  it("fails when a scheduled push goes back to a fixed destination", () => {
    // Mutation proof, on the exact regression: the line these guides shipped.
    const mutated = JSON.parse(
      JSON.stringify(GUIDES["howto-automate-server-backups"].langs.en).replaceAll("/$(date +\\\\%F)/", "/"),
    );
    const pushes = cronCommands(mutated).filter((c) => /\brelayium\s+push\b/.test(c));
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((c) => c.includes("$(date"))).toBe(false);
  });
});

// ── The backup-framing rule (the two maintained languages) ──────────────────

describe("the backup guides say they make a copy, not a versioned backup", () => {
  // Both guides are found by a reader searching for "backup", and both produce
  // an off-host copy of the current state. A scheduled sync additionally carries
  // a deletion or an in-place corruption at the source across on its next run —
  // the one property that decides whether this is safe to rely on alone.
  const NOT_VERSIONED = /not a versioned backup|不是带版本历史的备份|不是有版本历史的备份/;
  const PROPAGATES = /propagat\w*|carr(?:y|ies|ied) (?:it )?over|带过去|同步过去/i;

  for (const name of BACKUP_GUIDES) {
    for (const lang of ["en", "zh"]) {
      it(`${name}[${lang}] states both halves`, () => {
        const t = text(GUIDES[name].langs[lang]);
        expect(t, "never says it is not a versioned backup").toMatch(NOT_VERSIONED);
        expect(t, "never says a deletion at the source is carried over").toMatch(PROPAGATES);
      });
    }
  }

  it("fails when the not-a-backup qualification is dropped", () => {
    const mutated = JSON.parse(
      JSON.stringify(GUIDES["cli-backup-server-ssh"].langs.en).replaceAll("not a versioned backup", "a backup"),
    );
    expect(NOT_VERSIONED.test(text(mutated))).toBe(false);
  });
});
