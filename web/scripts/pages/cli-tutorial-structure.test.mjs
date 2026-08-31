// web/scripts/pages/cli-tutorial-structure.test.mjs — the six CLI guides are
// runnable tutorials, not essays, in all nine locales.
//
// Before this file the CLI guides were prose plus bullet lists. A reader could
// finish one without ever learning what they needed BEFORE step 1, what order to
// do things in, what a working run looks like on their own screen, or what to do
// when it didn't work. Four structured fields now carry those four things
// (article-template.mjs: prereqs / steps / success / troubleshooting), and this
// file is what stops them from decaying back into bullets.
//
// ── WHAT IS ASSERTED, AND WHY EACH RULE HAS TEETH ───────────────────────────
//  1. Presence, per article per locale. Not "somewhere in the corpus" — every
//     one of the 54 documents carries all four concepts.
//  2. Semantics in the OUTPUT, not just the data. A procedure has to reach the
//     page as a real <ol>: numbering that survives a reordered step, a screen
//     reader, and reader-mode extraction. "1." typed into a bullet string
//     survives none of those, so numerals at the head of a step or bullet are
//     rejected outright.
//  3. Locale alignment against English, structurally AND on every command: the
//     nine locales must agree on how many steps there are and on the literal
//     text of every code block, because a translated flag or a translated
//     expected output is a command that does not run.
//  4. A mechanical contract on troubleshooting: every entry must carry a check
//     that is EXECUTABLE (a command line whose first token is a real program)
//     and a fix that names something concrete (a flag, a path, a command, a
//     port). "Check your network" cannot pass that.
//  5. Fixture-level rendering rules — escaping, RTL-safe logical CSS, one <main>,
//     a well-formed <dl>, style gating — checked against renderArticlePage
//     directly so a template regression fails here rather than in a browser.
//  6. Mutation proofs at the bottom: the same validator, run over a document
//     with its troubleshooting removed and over one whose steps were demoted to
//     bullets, must FAIL. A guard nobody has watched fail is not a guard.
import { describe, it, expect } from "vitest";

import cliGettingStarted from "./content/articles/cli-getting-started.mjs";
import cliSendToSomeone from "./content/articles/cli-send-to-someone.mjs";
import cliServerToServer from "./content/articles/cli-server-to-server.mjs";
import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import cliCloudAsync from "./content/articles/cli-cloud-async.mjs";
import cliSyncLargeFolder from "./content/articles/cli-sync-large-folder.mjs";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import { buildArticlePages } from "./build-pages.mjs";
import { renderArticlePage } from "./article-template.mjs";
import { LANGS } from "./shared.mjs";

// The exact six this batch covers. Named rather than globbed: `cli-*` would also
// sweep in a future file that is deliberately not a tutorial, and the point of
// the list is that someone has to decide.
const TUTORIALS = {
  "cli-getting-started": cliGettingStarted,
  "cli-send-to-someone": cliSendToSomeone,
  "cli-server-to-server": cliServerToServer,
  "cli-backup-server-ssh": cliBackupSsh,
  "cli-cloud-async": cliCloudAsync,
  "cli-sync-large-folder": cliSyncLargeFolder,
};

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
 * Programs a troubleshooting check may invoke. The allowlist is the whole point
 * of the rule: a "check" that is a sentence rather than something you can run
 * has no first token in it, so it fails. Extend it deliberately — every entry
 * here is a program that appears in one of these six guides today.
 */
const RUNNABLE = new Set([
  "relayium", "ssh", "scp", "curl", "command", "echo", "grep", "ls", "cat",
  "ss", "pgrep", "kill", "rm", "sudo", "systemctl", "df", "du", "tmux", "until",
  "chmod", "crontab", "mkdir", "nohup", "find", "test",
]);

/** The first runnable line of a code block, or null when there isn't one. */
function runnableLine(block) {
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // a comment is not a check
    const first = line.split(/\s+/)[0];
    if (RUNNABLE.has(first)) return line;
  }
  return null;
}

// A fix has to name something you can act on. Any ONE of: a long flag, an
// absolute or home-relative path, a `relayium <subcommand>` invocation, or a
// number of at least two digits (a port, a retention window, a byte count).
// This is script-independent, so it holds for Arabic and Japanese exactly as it
// does for English.
//
// A bare program name from RUNNABLE is deliberately NOT enough: half that list
// is ordinary English (`command`, `test`, `find`, `echo`, `until`), so allowing
// it would let "run the command again" pass as concrete advice.
const CONCRETE = new RegExp(
  ["--[a-z][a-z-]{2,}", "[~/][\\w./-]{3,}", "relayium\\s+[a-z]{2,}", "\\b\\d{2,}\\b"].join("|"),
);

/**
 * Latin-script tokens of 4+ characters inside a check, comments included.
 *
 * A fix also counts as concrete when it names something the check itself
 * printed — ESTAB, SYN-SENT, known_hosts, authorized_fingerprints. Those are
 * exactly the precise observations a good troubleshooting entry turns on, and
 * they are not flags, paths or numbers, so the pattern above cannot see them.
 * Latin-only and 4+ characters on purpose: it must not match a translated word
 * from a `#` comment, which would make the rule trivially satisfiable.
 */
const checkTokens = (blocks) =>
  [...new Set((blocks || []).join("\n").match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || [])];

// Hand-waving that shipped in tutorials elsewhere and must never reach these.
// English-only on purpose: the rule that carries every locale is CONCRETE
// above, and a nine-language phrase table of vagueness would be a table of
// guesses rather than of things that actually shipped.
const VAGUE = [
  /check your (?:network|internet|connection)\b/i,
  /make sure everything (?:is|looks) (?:ok|okay|correct|fine)/i,
  /try again later/i,
  /contact support/i,
  /something went wrong/i,
];

// A step or bullet that begins with a numeral is fake numbering: the reader sees
// "1." but the machine sees a paragraph, and inserting a step in the middle
// renumbers nothing. Covers the Latin, CJK and Arabic separators the corpus uses.
const TYPED_NUMBER = /^\s*[(（]?\d+\s*[.)．、）:：]/;

/**
 * The structural contract, as a list of complaints. Returned rather than
 * asserted so the mutation tests at the bottom can run it over a broken
 * document and demand that it speaks up.
 */
function validate(name, lang, doc, enDoc) {
  const bad = [];
  const at = `${name}[${lang}]`;

  const pre = withPrereqs(doc);
  if (pre.length !== 1) bad.push(`${at}: wants exactly one prerequisites block, found ${pre.length}`);
  for (const s of pre) {
    if (!s.prereqs.label?.trim()) bad.push(`${at}: prerequisites block has no label`);
    if (!(s.prereqs.items?.length >= 3)) bad.push(`${at}: prerequisites lists fewer than 3 items`);
    for (const i of s.prereqs.items || []) {
      if (i.trim().length < 20) bad.push(`${at}: prerequisite too short to be a condition: "${i}"`);
    }
  }

  const steps = withSteps(doc);
  if (steps.length < 1) bad.push(`${at}: has no numbered procedure`);
  for (const s of steps) {
    if (s.steps.length < 3) bad.push(`${at}: procedure "${s.heading}" has fewer than 3 steps`);
    for (const step of s.steps) {
      if (!step.text?.trim()) bad.push(`${at}: a step has no text`);
      if (TYPED_NUMBER.test(step.text || "")) bad.push(`${at}: step types its own number: "${step.text}"`);
      for (const b of step.code || []) if (!b.trim()) bad.push(`${at}: a step has an empty code block`);
    }
    if (!s.steps.some((step) => step.code?.length)) {
      bad.push(`${at}: procedure "${s.heading}" carries no command at all`);
    }
  }
  // Numerals typed into a bullet are the same defect one field over.
  for (const s of sections(doc))
    for (const b of s.bullets || [])
      if (TYPED_NUMBER.test(b)) bad.push(`${at}: bullet types its own number: "${b}"`);

  const ok = withSuccess(doc);
  if (ok.length < 1) bad.push(`${at}: never says what a successful run looks like`);
  for (const s of ok) {
    if (!s.success.label?.trim()) bad.push(`${at}: success block has no label`);
    if (!s.success.code?.length) bad.push(`${at}: success block shows no expected output`);
  }

  const fix = withTrouble(doc);
  if (fix.length !== 1) bad.push(`${at}: wants exactly one troubleshooting block, found ${fix.length}`);
  for (const s of fix) {
    if (!s.troubleshooting.label?.trim()) bad.push(`${at}: troubleshooting block has no label`);
    const items = s.troubleshooting.items || [];
    if (items.length < 3) bad.push(`${at}: troubleshooting lists fewer than 3 entries`);
    for (const i of items) {
      if (!i.symptom?.trim()) bad.push(`${at}: a troubleshooting entry has no symptom`);
      if (!i.code?.length) bad.push(`${at}: "${i.symptom}" has no check to run`);
      for (const block of i.code || []) {
        if (!runnableLine(block)) bad.push(`${at}: "${i.symptom}" check is not executable: ${JSON.stringify(block)}`);
      }
      const f = (i.fix || "").trim();
      if (f.length < 40) bad.push(`${at}: fix for "${i.symptom}" is too short to be a fix`);
      if (!CONCRETE.test(f) && !checkTokens(i.code).some((t) => f.includes(t))) {
        bad.push(`${at}: fix for "${i.symptom}" names nothing concrete`);
      }
      if (lang === "en") for (const v of VAGUE) if (v.test(f)) bad.push(`${at}: vague fix for "${i.symptom}"`);
    }
  }

  // Locale alignment. Structure first, then the commands themselves.
  if (enDoc) {
    const shape = (d) => ({
      sections: sections(d).length,
      prereqItems: withPrereqs(d).flatMap((s) => s.prereqs.items).length,
      steps: withSteps(d).map((s) => s.steps.length).join(","),
      success: withSuccess(d).length,
      troubles: withTrouble(d).flatMap((s) => s.troubleshooting.items).length,
    });
    const mine = JSON.stringify(shape(doc));
    const theirs = JSON.stringify(shape(enDoc));
    if (mine !== theirs) bad.push(`${at}: structure diverges from en — ${mine} vs ${theirs}`);

    // Commands and expected output are the same bytes in every language; only
    // the `#` comments inside them are translated (content/GLOSSARY.md). So
    // strip the comments — a whole line, or a trailing one — and compare what is
    // left, which is exactly the half a reader pastes into a shell. The trailing
    // pattern requires whitespace on BOTH sides of the `#` so that the `#k=`
    // fragment of a share link, which carries the decryption key, survives.
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

describe("the six CLI guides are runnable tutorials in all nine locales", () => {
  it("carries prerequisites, an ordered procedure, a success signal and troubleshooting", () => {
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS))
      for (const lang of LANGS)
        bad.push(...validate(name, lang, article.langs[lang], lang === "en" ? null : article.langs.en));
    expect(bad).toEqual([]);
  });

  it("covers all six articles and all nine locales, not a subset", () => {
    // Guards the guard: a renamed import or a shrunken LANGS would otherwise
    // turn every assertion above green by checking nothing.
    expect(Object.keys(TUTORIALS)).toHaveLength(6);
    expect(LANGS).toHaveLength(9);
    for (const article of Object.values(TUTORIALS))
      for (const lang of LANGS) expect(article.langs[lang]?.sections?.length ?? 0).toBeGreaterThan(3);
  });
});

// ── EIGHT FACT-LEVEL CONTRACTS ──────────────────────────────────────────────
// The rules above police shape. These eight police claims that were wrong in a
// way no shape check could see: an example that gave one machine two identities,
// a cleanup command that could kill a bystander, a socket state sold as proof of
// something it does not prove, a mirror sold as hash-verified when half of it was
// never hashed, an ssh login sold as a working push, a firewall rule that opened
// the listener to the whole internet while the sentence above it said "to the
// sender", a mode credited with exactly two failure modes, and a signal promised
// to be incapable of hitting anything else. Each is a list of complaints for the
// same reason `validate` is — the mutation tests at the bottom run them over a
// deliberately broken document and demand they speak up.

const codeText = (doc) => sections(doc).flatMap(sectionCode).join("\n");

/**
 * Every string in the document, joined with real newlines.
 *
 * Deliberately NOT JSON.stringify: that turns a newline into a literal
 * backslash-n, which both destroys the word boundary in front of a command at
 * the start of a code line and lets a line-bounded span run across lines. The
 * first of those hid a `pkill` from this file's own guard until a mutation test
 * caught it.
 */
const docStrings = (v) =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(docStrings) : [];
const docText = (doc) => docStrings(doc).join("\n");

const FP = "[0-9a-f]{8}";

/**
 * The daemon-direct walkthrough has exactly two machines in it. Pull each
 * fingerprint out of the place the example prints it, so the roles can be
 * compared instead of trusted.
 */
function daemonIdentities(doc) {
  const t = codeText(doc);
  const one = (re) => t.match(re)?.[1] ?? null;
  return {
    // What the RECEIVER's own `serve` reports about itself.
    listener: one(new RegExp(`listening on [^\\n]*\\(fingerprint (${FP})…\\)`)),
    // What the SENDER pins for that listener on first contact.
    learned: one(new RegExp(`^learned \\S+ (${FP})… \\(added to known_hosts\\)`, "m")),
    // …and the four places the SENDER's own identity shows up.
    authorized: one(new RegExp(`^authorized (${FP})… \\(added to`, "m")),
    received: one(new RegExp(`bytes from (${FP})…`)),
    prompt: one(new RegExp(`^\\s+fingerprint: (${FP})…`, "m")),
    id: one(new RegExp(`relayium id\\n#\\s*(${FP})…`)),
    // The runnable form carries the listener's own --config-dir (guarded
    // separately below), so the fingerprint is not the next token.
    authorize: [...t.matchAll(new RegExp(`relayium authorize (?:--config-dir \\S+ )?(${FP})`, "g"))].map((m) => m[1]),
  };
}

function identityComplaints(at, doc) {
  const bad = [];
  const i = daemonIdentities(doc);
  for (const [k, v] of Object.entries(i)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) {
      bad.push(`${at}: no ${k} fingerprint in the examples — the role check would pass vacuously`);
    }
  }
  if (bad.length) return bad; // nothing to compare; say so rather than assert on nulls

  // The listener prints its own fingerprint, and that is precisely the one the
  // sender learns and pins. If those two differ, the reader is being shown one
  // machine wearing two identities.
  if (i.listener !== i.learned) {
    bad.push(`${at}: serve reports fingerprint ${i.listener}… but the sender learns ${i.learned}…`);
  }
  // The prompt, the allow-list line, the received-from line, relayium id and
  // every authorize argument all name the SAME machine: the pusher.
  const sender = [...new Set([i.authorized, i.received, i.prompt, i.id, ...i.authorize])];
  if (sender.length !== 1) bad.push(`${at}: the sender is not one identity — ${sender.join(", ")}`);
  else if (sender[0] === i.listener) bad.push(`${at}: sender and receiver share fingerprint ${i.listener}…`);
  return bad;
}

// Lifecycle ownership. `pkill -f 'relayium serve'` is a substring match over
// whole command lines, so it signals every serve on the box; `pkill -f 'relayium
// sync'` kills a child the surrounding until loop restarts ten seconds later.
// The guide therefore has to stop what it started: the PID it recorded, and the
// tmux session that owns the loop.
const OWNED_LIFECYCLE = [
  "echo $! > ~/relayium-serve.pid",
  'kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid',
  "tmux kill-session -t xfer",
];

function lifecycleComplaints(at, doc, { owns = false } = {}) {
  const bad = [];
  // Prose too, not only code: a fix line that recommends pkill is a command the
  // reader will paste just as readily as one inside a <pre>.
  if (/\bpkill\b/.test(docText(doc))) bad.push(`${at}: prescribes pkill, which matches by substring`);
  if (!owns) return bad;
  const t = codeText(doc);
  for (const cmd of OWNED_LIFECYCLE) {
    if (!t.includes(cmd)) bad.push(`${at}: never shows the owned-lifecycle command ${JSON.stringify(cmd)}`);
  }
  // `rm` must be gated on the kill succeeding, never an unconditional cleanup.
  if (/rm\s+~\/relayium-serve\.pid/.test(t) && !t.includes('&& rm ~/relayium-serve.pid')) {
    bad.push(`${at}: removes the PID file without requiring the signal to succeed`);
  }
  return bad;
}

// TCP ESTABLISHED means the handshake completed. It does not mean a byte has
// moved since, and an idle or stalled socket sits in ESTAB indefinitely. The
// tempered span below is the whole point: a movement claim about ESTAB is only
// allowed when a negator comes FIRST, so "ESTAB means bytes are moving" fails
// while "ESTAB is not proof that bytes are moving" passes.
const ESTAB_AS_PROGRESS = /ESTAB(?:(?!\b(?:not|never|nothing|no)\b)[^.\n])*?\b(?:transferring|moving)\b/i;

function estabComplaints(at, doc, { english = false } = {}) {
  const bad = [];
  const t = docText(doc);
  if (!t.includes("ESTAB")) bad.push(`${at}: lost the ESTAB observation entirely`);
  if (!t.includes("SYN-SENT")) bad.push(`${at}: lost SYN-SENT as the not-reached case`);
  if (!t.includes("ss -tinp")) bad.push(`${at}: the check no longer asks ss for per-socket info`);
  if (!t.includes("bytes_acked")) bad.push(`${at}: names no byte counter to compare between runs`);
  if (!english) return bad;
  if (ESTAB_AS_PROGRESS.test(t)) bad.push(`${at}: still equates ESTAB with bytes moving`);
  if (!/ESTAB[^.\n]*reachability/i.test(t)) bad.push(`${at}: never says ESTAB proves reachability only`);
  if (!/twice/i.test(t)) bad.push(`${at}: never tells the reader to run the check twice`);
  return bad;
}

// ── What the sync guide's SHA-256 actually covers ───────────────────────────
// server/internal/xfer/recv.go: syncStateFor skips a manifest file whose on-disk
// copy matches by size AND modification time. A skipped file is never read, so
// it is never hashed — the article cannot know its contents. Everything the
// transfer DOES send, a resumed file included, is checked on arrival against the
// sender's SHA-256 and a mismatch is recorded as a failure, so that half of the
// guarantee is real and must not be watered down. `du -sh` sits between the two:
// equal totals are a completeness sanity check over bytes on disk, never proof
// that a skipped file's contents still match.
//
// The cross-locale rule is a CO-OCCURRENCE, not a phrase table: wherever this
// article says SHA-256, in any language, the same string must also name `mtime`
// — the input to the skip decision the hash does not cover. All three anchors
// below are Latin technical tokens the corpus leaves untranslated in all nine
// locales, so the rule bites in Arabic and Japanese exactly as in English, and
// no unqualified "every file is verified" sentence can satisfy it anywhere.
const HASH = "SHA-256";
const SKIP_INPUTS = "mtime";
const TOTALS = "du -sh";

/** The section that checks the finished mirror: the one whose procedure runs du -sh. */
const verifySection = (doc) =>
  sections(doc).find((s) =>
    (s.steps || []).some((st) => (st.code || []).some((c) => c.includes("du -sh /root/workspace"))),
  );

// English-only, for the reason VAGUE is: a tempered span is a claim SHAPE, and
// nine translations of one would be nine guesses. The quantifier may reach a
// hash word only if the span never crosses a word that scopes it to what moved
// — so "every file it transfers is checked with SHA-256" passes and "every file
// is checked with SHA-256" does not.
const HASHED_WITHOUT_SCOPE = new RegExp(
  "\\b(?:every|all|each)\\s+files?\\b" +
    "(?:(?!\\b(?:transferred|transfers|transfer|sent|sends|send|arrives|arriving|moved)\\b)[^.\\n])*?" +
    "\\b(?:SHA-256|hashed|hash-verified|verified|checked)\\b",
  "i",
);

// The other half of the same overclaim — the mirror, or the copy, as a whole
// declared sound. Both word orders, because the sentence this replaced put the
// adjective last ("means an intact copy") and the bullet put it first.
const WHOLE_MIRROR_INTACT = new RegExp(
  ["\\b(?:mirror|copy)\\b(?:(?!\\b(?:not|never|transferred|sent|skipped)\\b)[^.\\n])*?\\bintact\\b",
   "\\bintact\\b(?:(?!\\b(?:not|never|transferred|sent|skipped)\\b)[^.\\n])*?\\b(?:mirror|copy)\\b"].join("|"),
  "i",
);

function hashScopeComplaints(at, doc, { english = false } = {}) {
  const bad = [];

  // 1. Hashing is never claimed without the skip rule the hash does not cover.
  const hashed = docStrings(doc).filter((s) => s.includes(HASH));
  if (hashed.length < 2) {
    bad.push(`${at}: only ${hashed.length} ${HASH} claim(s) left to scope — the rule would pass near-vacuously`);
  }
  for (const s of hashed) {
    if (!s.includes(SKIP_INPUTS)) {
      bad.push(`${at}: claims ${HASH} without naming the ${SKIP_INPUTS} skip: ${JSON.stringify(s.slice(0, 72))}`);
    }
  }

  // 2. The du -sh conclusion is qualified in the box and the notes that draw it,
  //    not merely somewhere else in the article the reader may never reach.
  const v = verifySection(doc);
  if (!v) return [...bad, `${at}: no ${TOTALS} verification step — the totals rule would pass vacuously`];
  const box = (v.success?.body || []).join("\n");
  const notes = (v.bullets || []).join("\n");
  if (!box.includes(TOTALS)) bad.push(`${at}: the finished-mirror box no longer reads ${TOTALS}`);
  if (!box.includes(SKIP_INPUTS)) {
    bad.push(`${at}: reads ${TOTALS} totals without saying sync skipped by size+${SKIP_INPUTS}`);
  }
  for (const token of [HASH, SKIP_INPUTS, TOTALS]) {
    if (!notes.includes(token)) bad.push(`${at}: the verify notes never mention ${token}`);
  }

  if (!english) return bad;
  const t = docText(doc);
  if (HASHED_WITHOUT_SCOPE.test(t)) bad.push(`${at}: claims every/all/each file is hash-verified, unscoped`);
  if (WHOLE_MIRROR_INTACT.test(t)) bad.push(`${at}: declares the whole mirror or copy intact`);
  if (!/\b(?:coarse|sanity check|rather than proof|not proof)\b/i.test(`${box}\n${notes}`)) {
    bad.push(`${at}: never calls matching ${TOTALS} totals coarse rather than proof`);
  }
  return bad;
}

// ── What a working ssh proves in the getting-started guide ──────────────────
// `ssh user@your-server true` exercises reachability and authentication, and
// push does reuse exactly that access — so a clean ssh settles the CONNECTION
// prerequisite and nothing more. The transfer can still fail on the destination:
// no write permission under the target directory, no free space, an error
// mid-stream. "if ssh works, push works" promised the second from the first.
//
// Cross-locale, the step must name `ssh`, name `push`, and name the destination
// whose writability the ssh check never touches — three untranslated tokens
// again, so a locale cannot quietly keep the shorter, wrong sentence.
const SSH_CHECK = "ssh user@your-server true";
const PUSH_DEST = "user@your-server:backups/";

const sshCheckStep = (doc) =>
  sections(doc)
    .flatMap((s) => s.steps || [])
    .find((st) => (st.code || []).some((c) => c.includes(SSH_CHECK)));

// English-only tempered span, built like ESTAB_AS_PROGRESS: ssh reaching a
// "push works" only counts as the overclaim when nothing scopes it first.
const SSH_PROVES_PUSH = new RegExp(
  "\\bssh\\b(?:(?!\\b(?:not|never|only|still|cannot)\\b)[^.\\n])*?" +
    "\\bpush\\s+(?:works|will work|succeeds|will succeed|is fine)\\b",
  "i",
);

function sshPrereqComplaints(at, doc, { english = false } = {}) {
  const step = sshCheckStep(doc);
  if (!step) return [`${at}: no "${SSH_CHECK}" step — the prerequisite rule would pass vacuously`];
  const t = step.text || "";
  const bad = [];
  if (!/\bssh\b/.test(t)) bad.push(`${at}: the ssh step never names ssh`);
  if (!/\bpush\b/.test(t)) bad.push(`${at}: the ssh step never says which command the check is for`);
  if (!t.includes(PUSH_DEST)) {
    bad.push(`${at}: never names ${PUSH_DEST}, the destination a working ssh says nothing about`);
  }
  if (!english) return bad;
  if (SSH_PROVES_PUSH.test(t)) bad.push(`${at}: sells a working ssh as a working push`);
  if (!/\b(?:does not promise|does not prove|not a promise|still needs|can still fail)\b/i.test(t)) {
    bad.push(`${at}: never says push can still fail after a clean ssh`);
  }
  return bad;
}

// ── Who the firewall rule actually lets in ──────────────────────────────────
// `sudo ufw allow 9031/tcp` opens the listener to every source on the internet
// while the sentence above it says "to the sender". UFW's source form is the
// same one line of work, so both guides hand over the scoped rule and say which
// address belongs in it. The example IP differs per article because each one
// already has a sender in it: the address its own approval prompt prints.
const SENDER_IP = {
  "cli-server-to-server": "203.0.113.7",
  "cli-sync-large-folder": "203.0.113.9",
};
const scopedUfw = (ip) => `sudo ufw allow from ${ip} to any port 9031 proto tcp`;

// Any ufw rule that reaches 9031 without naming a real source. Deliberately
// wider than the string that shipped: `9031/tcp`, `9031/udp`, a `to any port
// 9031` with no `from` in front of it, and `from any` — which is the syntax of
// a scoped rule with the scope left out — are all the same open door.
const UNSCOPED_UFW = /ufw\s+allow\s+(?:(?!from\b)|from\s+any\b)[^\n]*9031/i;

/** The code blocks of a document, so prose can be told from what a reader pastes. */
const codeBlockSet = (doc) => new Set(sections(doc).flatMap(sectionCode));
const proseStrings = (doc) => {
  const code = codeBlockSet(doc);
  return docStrings(doc).filter((s) => !code.has(s));
};

function firewallComplaints(at, doc, ip, { english = false } = {}) {
  const bad = [];
  const open = docText(doc).match(UNSCOPED_UFW);
  if (open) bad.push(`${at}: opens 9031 to every source — ${JSON.stringify(open[0])}`);
  if (!codeText(doc).includes(scopedUfw(ip))) {
    bad.push(`${at}: never shows the source-scoped rule ${JSON.stringify(scopedUfw(ip))}`);
  }
  // The address in the rule is an example from TEST-NET-3. Prose has to say so,
  // or a reader pastes it and has allowed a host that is not their sender.
  const told = proseStrings(doc).filter((s) => s.includes(ip));
  if (!told.length) {
    bad.push(`${at}: ${ip} appears only inside the command — nothing says to substitute their own`);
  }
  if (!english) return bad;
  const t = told.join("\n");
  // A ufw rule is half the door on a cloud host, and which address to use is
  // not obvious when the two servers might be on one private network.
  if (!/\bsecurity group\b/i.test(t)) bad.push(`${at}: never says the cloud security group needs the same source`);
  if (!/\bpublic\b/i.test(t) || !/\bprivate\b/i.test(t)) {
    bad.push(`${at}: never says which of the sender's addresses belongs in the rule`);
  }
  return bad;
}

// ── Daemon direct does not have exactly two failure modes ───────────────────
// The server-to-server troubleshooting intro claimed "exactly two things that
// can go wrong: reachability and trust", each "settled by one command". Neither
// half survives contact with the receiver: it can be out of disk, its inbox can
// be unwritable by the service user, a transferred file can fail its integrity
// check — and the box's own first entry runs three commands. Reachability
// and trust are the right FIRST checks, which is all the intro may now claim.
//
// That integrity class carries its own honesty rule: the receiver hashes while
// it receives, but only knows the SHA-256 mismatch once the stream has ended, so
// the intro may not date the detection to the middle of the transfer.
//
// Cross-locale the intro still has to guide the reader to both of them, anchored
// on the command that settles each. Commands stay English in every language
// (content/GLOSSARY.md), so `ss -tinp` and `relayium authorize` bite in Arabic
// and Japanese exactly as in English, where a phrase table for "reachability"
// would be nine guesses.
const REACH_CHECK = "ss -tinp";
const TRUST_CHECK = "relayium authorize";

/** The prose that introduces the troubleshooting box, in any locale. */
const troubleIntro = (doc) => (withTrouble(doc)[0]?.body || []).join("\n");

const EXHAUSTIVE_FAILURES = new RegExp(
  [
    "\\b(?:exactly|only|just)\\s+two\\b[^.\\n]*\\b(?:wrong|fail)",
    "\\btwo\\s+things?\\b[^.\\n]*\\bcan\\s+go\\s+wrong\\b",
    "\\bcan\\s+go\\s+wrong\\b[^.\\n]*\\b(?:exactly|only|just)\\s+two\\b",
  ].join("|"),
  "i",
);
// "Each of the four below is settled by one command" — a promise about how much
// work a case takes, made before anyone knows which case it is.
const ONE_COMMAND_PER_CASE = new RegExp(
  "\\b(?:each|every|any)\\b(?:(?!\\b(?:not|never|more)\\b)[^.\\n])*?\\b(?:one|a single)\\s+command\\b",
  "i",
);
const NOT_EXHAUSTIVE = /\b(?:not the only|not the whole story|more (?:can|could) go wrong|other (?:ways|failures))\b/i;
// "fails its integrity check mid-stream" — a detection time the receiver cannot
// claim. Either order of the two words, within one sentence.
const MIDSTREAM_INTEGRITY = new RegExp(
  ["\\bmid-?stream\\b[^.\\n]*\\bintegrity\\b", "\\bintegrity\\b[^.\\n]*\\bmid-?stream\\b"].join("|"),
  "i",
);

function failureClassComplaints(at, doc, { english = false } = {}) {
  const intro = troubleIntro(doc);
  if (!intro.trim()) {
    return [`${at}: the troubleshooting box lost its intro — the honesty rule would pass vacuously`];
  }
  const bad = [];
  for (const anchor of [REACH_CHECK, TRUST_CHECK]) {
    if (!intro.includes(anchor)) bad.push(`${at}: the troubleshooting intro no longer points at ${anchor}`);
  }
  if (!english) return bad;
  if (EXHAUSTIVE_FAILURES.test(intro)) bad.push(`${at}: still says only two things can go wrong`);
  if (ONE_COMMAND_PER_CASE.test(intro)) bad.push(`${at}: still promises one command settles each case`);
  if (!NOT_EXHAUSTIVE.test(intro)) bad.push(`${at}: never says these are not the only ways a push can fail`);
  if (MIDSTREAM_INTEGRITY.test(intro)) bad.push(`${at}: dates the integrity failure to mid-stream`);
  return bad;
}

// ── What signalling the recorded PID actually guarantees ────────────────────
// Recording the PID and signalling exactly that PID is the right approach, and
// `kill … && rm` still gates the cleanup on the signal landing — none of that
// changes here. What was not true is the certainty wrapped around it: a PID file
// outlives the process it names and the kernel reuses PIDs, so a file left by an
// earlier run can point at somebody else's process. The guide now says what it
// targets — the recorded PID rather than a substring match over every relayium
// command on the box — and hands the reader the command that resolves the doubt.
const PID_INSPECT = 'ps -p "$(cat ~/relayium-serve.pid)" -o command=';

const PID_ABSOLUTE = new RegExp(
  [
    "\\bno other process\\b(?:(?!\\b(?:stale|reused|unless)\\b)[^.\\n])*?\\b(?:caught|killed|hit|signal(?:l?ed)?|match(?:ed|es)?)\\b",
    "\\b(?:this|that) listener\\b[^.\\n]*\\bnothing else\\b",
    "\\bnothing else\\b[^.\\n]*\\b(?:listener|process|PID)\\b",
  ].join("|"),
  "i",
);

function pidCertaintyComplaints(at, doc, { english = false } = {}) {
  const bad = [];
  if (!codeText(doc).includes(PID_INSPECT)) {
    bad.push(`${at}: never shows how to check what the recorded PID is now — ${PID_INSPECT}`);
  }
  if (!english) return bad;
  const t = docText(doc);
  if (PID_ABSOLUTE.test(t)) bad.push(`${at}: claims the signal cannot reach anything but the listener`);
  if (!/\breus\w*\b/i.test(t)) {
    bad.push(`${at}: never warns that a leftover PID file can name a PID the system reused`);
  }
  return bad;
}

describe("the daemon-direct walkthrough keeps its two machines apart", () => {
  it("gives the listener one fingerprint and the pusher another, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS) bad.push(...identityComplaints(`cli-server-to-server[${lang}]`, cliServerToServer.langs[lang]));
    expect(bad).toEqual([]);
  });

  it("shows the same two identities in every locale, not merely two per locale", () => {
    // Cross-locale, because a locale could be internally consistent on a pair
    // of fingerprints nobody else uses and still contradict the English page.
    const seen = new Set(
      LANGS.map((l) => {
        const i = daemonIdentities(cliServerToServer.langs[l]);
        return `${i.listener}/${i.authorized}`;
      }),
    );
    expect([...seen]).toHaveLength(1);
  });
});

// ── A pasted `authorize` has to write the directory the service reads ───────
// The guide's prose says to give `authorize` the same `--config-dir` the
// listener runs with, but its two runnable blocks used to show a bare
// `relayium authorize <fp>`. A reader pastes the command, not the paragraph:
// the bare form writes ~/.config/relayium/authorized_fingerprints while a
// service started with --config-dir /etc/relayium keeps reading its own file,
// so the push goes on being rejected with the fingerprint apparently added.
// The prefix is asserted literally — the flag alone is not enough, because a
// different directory is the same failure.
const AUTHORIZE_LINE = /^\s*relayium\s+authorize\b.*$/gm;
const AUTHORIZE_SAFE = /^relayium authorize --config-dir \/etc\/relayium [0-9a-f]{8}/;

function authorizeCommandComplaints(at, doc) {
  const bad = [];
  const lines = (codeText(doc).match(AUTHORIZE_LINE) || []).map((l) => l.trim());
  // Both blocks, every locale: the pre-authorize step and the troubleshooting
  // recovery. A count check keeps a locale from quietly losing one of them.
  if (lines.length !== 2) bad.push(`${at}: expected 2 runnable authorize commands, found ${lines.length}`);
  for (const line of lines) {
    if (!AUTHORIZE_SAFE.test(line)) {
      bad.push(`${at}: authorize command does not write the service's trust directory — ${JSON.stringify(line)}`);
    }
  }
  return bad;
}

describe("the runnable authorize command targets the listener's own config dir", () => {
  it("shows --config-dir /etc/relayium in both server-to-server blocks, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(...authorizeCommandComplaints(`cli-server-to-server[${lang}]`, cliServerToServer.langs[lang]));
    expect(bad).toEqual([]);
  });

  it("fails when a locale falls back to a bare authorize", () => {
    // Mutation proof: the guard is only worth its line count if it has been
    // watched to fail on exactly the regression it exists for.
    const mutated = JSON.parse(
      JSON.stringify(cliServerToServer.langs.en).replaceAll("relayium authorize --config-dir /etc/relayium ", "relayium authorize "),
    );
    expect(authorizeCommandComplaints("mutated", mutated)).not.toEqual([]);
  });

  it("fails when a locale points authorize at some other directory", () => {
    const mutated = JSON.parse(
      JSON.stringify(cliServerToServer.langs.en).replaceAll("--config-dir /etc/relayium", "--config-dir /tmp/relayium"),
    );
    expect(authorizeCommandComplaints("mutated", mutated)).not.toEqual([]);
  });

  it("fails when a locale drops one of the two blocks", () => {
    const mutated = JSON.parse(JSON.stringify(cliServerToServer.langs.en));
    const first = mutated.sections.find((s) => (s.code || []).some((c) => c.includes("relayium authorize")));
    first.code = first.code.filter((c) => !c.includes("relayium authorize"));
    expect(authorizeCommandComplaints("mutated", mutated)).not.toEqual([]);
  });
});

describe("process cleanup is owned, never pattern-matched", () => {
  it("never prescribes pkill in any of the six tutorials, in any locale", () => {
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS))
      for (const lang of LANGS) bad.push(...lifecycleComplaints(`${name}[${lang}]`, article.langs[lang]));
    expect(bad).toEqual([]);
  });

  it("stops the listener by recorded PID and the retry loop by its own tmux session", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(...lifecycleComplaints(`cli-sync-large-folder[${lang}]`, cliSyncLargeFolder.langs[lang], { owns: true }));
    expect(bad).toEqual([]);
  });

  it("carries the owned-lifecycle commands through to the rendered page", () => {
    for (const page of buildArticlePages([cliSyncLargeFolder])) {
      expect(page.html, `${page.path}: pkill reached the page`).not.toMatch(/\bpkill\b/);
      expect(page.html, page.path).toContain("tmux kill-session -t xfer");
      // Escaped, because the command carries quotes the template must not emit raw.
      expect(page.html, page.path).toContain("kill &quot;$(cat ~/relayium-serve.pid)&quot; &amp;&amp; rm ~/relayium-serve.pid");
    }
  });
});

describe("ESTAB is reported as reachability, not as progress", () => {
  const ESTAB_ARTICLES = {
    "cli-server-to-server": cliServerToServer,
    "cli-sync-large-folder": cliSyncLargeFolder,
  };

  it("keeps the check precise and names a counter to compare, in all nine locales", () => {
    const bad = [];
    for (const [name, article] of Object.entries(ESTAB_ARTICLES))
      for (const lang of LANGS)
        bad.push(...estabComplaints(`${name}[${lang}]`, article.langs[lang], { english: lang === "en" }));
    expect(bad).toEqual([]);
  });

  it("never equates ESTAB with transferring on the English page as rendered", () => {
    for (const article of Object.values(ESTAB_ARTICLES)) {
      const page = buildArticlePages([article]).find((p) => p.path.startsWith("guides/"));
      expect(page, "the English page must exist to be checked").toBeTruthy();
      expect(page.html, `${page.path}: ESTAB sold as proof of transfer`).not.toMatch(ESTAB_AS_PROGRESS);
      expect(page.html, `${page.path}: ESTAB must be framed as reachability`).toMatch(/ESTAB[^.\n]*reachability/i);
      expect(page.html, `${page.path}: no counter to compare between runs`).toContain("bytes_acked");
      expect(page.html, `${page.path}: SYN-SENT is still the not-reached case`).toContain("SYN-SENT");
    }
  });
});

describe("the sync guide scopes SHA-256 to what it actually sent", () => {
  it("names the size+mtime skip wherever it claims a hash, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(
        ...hashScopeComplaints(`cli-sync-large-folder[${lang}]`, cliSyncLargeFolder.langs[lang], {
          english: lang === "en",
        }),
      );
    expect(bad).toEqual([]);
  });

  it("carries the qualification onto every rendered page, not just into the data", () => {
    const pages = buildArticlePages([cliSyncLargeFolder]);
    expect(pages).toHaveLength(9);
    for (const page of pages) {
      expect(page.html, `${page.path}: the skip rule never reaches the reader`).toContain(SKIP_INPUTS);
      expect(page.html, `${page.path}: the hash guarantee is gone`).toContain(HASH);
    }
    const en = pages.find((p) => p.path.startsWith("guides/"));
    expect(en, "the English page must exist to be checked").toBeTruthy();
    expect(en.html, `${en.path}: unscoped every-file hashing`).not.toMatch(HASHED_WITHOUT_SCOPE);
    expect(en.html, `${en.path}: the whole mirror declared intact`).not.toMatch(WHOLE_MIRROR_INTACT);
  });
});

describe("a working ssh is a prerequisite, not a promise that push will succeed", () => {
  it("scopes the ssh check to connection and authentication, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(
        ...sshPrereqComplaints(`cli-getting-started[${lang}]`, cliGettingStarted.langs[lang], {
          english: lang === "en",
        }),
      );
    expect(bad).toEqual([]);
  });

  it("never tells the English page that a working ssh is a working push", () => {
    const page = buildArticlePages([cliGettingStarted]).find((p) => p.path.startsWith("guides/"));
    expect(page, "the English page must exist to be checked").toBeTruthy();
    expect(page.html, `${page.path}: ssh success sold as push success`).not.toMatch(SSH_PROVES_PUSH);
    expect(page.html, `${page.path}: the destination is never named`).toContain(PUSH_DEST);
  });
});

describe("the firewall rule opens 9031 to the sender, not to the internet", () => {
  const FIREWALL_ARTICLES = {
    "cli-server-to-server": cliServerToServer,
    "cli-sync-large-folder": cliSyncLargeFolder,
  };

  it("shows a source-scoped rule and never a bare port rule, in all nine locales", () => {
    const bad = [];
    for (const [name, article] of Object.entries(FIREWALL_ARTICLES))
      for (const lang of LANGS)
        bad.push(
          ...firewallComplaints(`${name}[${lang}]`, article.langs[lang], SENDER_IP[name], {
            english: lang === "en",
          }),
        );
    expect(bad).toEqual([]);
  });

  it("puts the scoped rule, and only the scoped rule, on every rendered page", () => {
    for (const [name, article] of Object.entries(FIREWALL_ARTICLES)) {
      const pages = buildArticlePages([article]);
      expect(pages).toHaveLength(9);
      for (const page of pages) {
        expect(page.html, `${page.path}: 9031 opened to every source`).not.toMatch(UNSCOPED_UFW);
        expect(page.html, `${page.path}: the scoped rule never reaches the reader`).toContain(
          scopedUfw(SENDER_IP[name]),
        );
      }
    }
  });
});

describe("reachability and trust are first checks, not the only failures", () => {
  it("keeps the intro pointing at both checks, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(
        ...failureClassComplaints(`cli-server-to-server[${lang}]`, cliServerToServer.langs[lang], {
          english: lang === "en",
        }),
      );
    expect(bad).toEqual([]);
  });

  it("never claims two failure classes, or one command each, on the English page", () => {
    const page = buildArticlePages([cliServerToServer]).find((p) => p.path.startsWith("guides/"));
    expect(page, "the English page must exist to be checked").toBeTruthy();
    expect(page.html, `${page.path}: two failure classes sold as all of them`).not.toMatch(EXHAUSTIVE_FAILURES);
    expect(page.html, `${page.path}: one command per case, promised in advance`).not.toMatch(ONE_COMMAND_PER_CASE);
    expect(page.html, `${page.path}: the reachability check never reaches the reader`).toContain(REACH_CHECK);
    expect(page.html, `${page.path}: the trust check never reaches the reader`).toContain(TRUST_CHECK);
  });
});

describe("the listener is stopped by recorded PID, without pretending a PID cannot be stale", () => {
  it("carries the inspection command in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS)
      bad.push(
        ...pidCertaintyComplaints(`cli-sync-large-folder[${lang}]`, cliSyncLargeFolder.langs[lang], {
          english: lang === "en",
        }),
      );
    expect(bad).toEqual([]);
  });

  it("renders the inspection command escaped, and no absolute claim in English", () => {
    const pages = buildArticlePages([cliSyncLargeFolder]);
    expect(pages).toHaveLength(9);
    for (const page of pages) {
      // Escaped, because the command carries the quotes of a command substitution.
      expect(page.html, `${page.path}: no way to see what the recorded PID is now`).toContain(
        "ps -p &quot;$(cat ~/relayium-serve.pid)&quot; -o command=",
      );
    }
    const en = pages.find((p) => p.path.startsWith("guides/"));
    expect(en, "the English page must exist to be checked").toBeTruthy();
    expect(en.html, `${en.path}: the signal sold as unable to hit anything else`).not.toMatch(PID_ABSOLUTE);
  });
});

describe("the tutorial blocks reach the page with the right semantics", () => {
  const pages = Object.values(TUTORIALS).flatMap((a) => buildArticlePages([a]));

  it("renders the procedure as an <ol>, never a <ul> and never typed numerals", () => {
    for (const page of pages) {
      expect(page.html, page.path).toContain('<ol class="steps" data-block="steps">');
      const ol = page.html.slice(page.html.indexOf('<ol class="steps"'));
      const body = ol.slice(0, ol.indexOf("</ol>"));
      expect(body, `${page.path}: a procedure must not be an unordered list`).not.toContain("<ul");
      // Each step is a real list item holding a paragraph, so a screen reader
      // announces "item 2 of 5" rather than reading a numeral out of prose.
      expect(body, `${page.path}: steps must be <li><p>…`).toContain("<li><p>");
      expect(body, `${page.path}: a step must not print its own number`).not.toMatch(/<li><p>\s*\d+[.)]/);
    }
  });

  it("labels the prerequisites, success and troubleshooting blocks distinctly", () => {
    for (const page of pages) {
      for (const kind of ["prereqs", "success", "troubleshooting"]) {
        expect(page.html, `${page.path}: missing ${kind}`).toContain(`data-block="${kind}"`);
      }
      // Every box carries a visible label element, so the three are told apart
      // by text and not only by a border colour.
      const boxes = page.html.match(/<div class="cbox [^"]+" data-block="[a-z]+"><p class="cbox-t">/g) || [];
      expect(boxes.length, `${page.path}: every cbox needs a label`).toBeGreaterThanOrEqual(3);
      // Troubleshooting is a description list: the symptom is the term, the
      // check and the fix are its description.
      const fix = page.html.slice(page.html.indexOf('data-block="troubleshooting"'));
      const dl = fix.slice(fix.indexOf("<dl>"), fix.indexOf("</dl>"));
      expect((dl.match(/<dt>/g) || []).length, `${page.path}: dt count`).toBeGreaterThanOrEqual(3);
      expect((dl.match(/<dt>/g) || []).length).toBe((dl.match(/<dd>/g) || []).length);
      expect(dl, `${page.path}: every check needs a <pre>`).toContain("<pre><code>");
    }
  });

  it("emits the block stylesheet only on pages that use a block", () => {
    for (const page of pages) expect(page.html, page.path).toContain("ol.steps{");
    const plain = buildArticlePages([compareSnapdrop])[0].html;
    expect(plain, "a prose article must stay byte-for-byte free of the block CSS").not.toContain("ol.steps{");
    expect(plain).not.toContain(".cbox{");
    expect(plain).not.toContain('data-block="');
  });

  it("keeps the RTL page on logical properties and one main landmark", () => {
    const ar = pages.filter((p) => p.path.startsWith("ar/"));
    expect(ar.length).toBe(6);
    for (const page of ar) {
      expect(page.html).toContain('dir="rtl"');
      expect(page.html.split("<main>").length - 1).toBe(1);
      expect(page.html.split("</main>").length - 1).toBe(1);
    }
    // The block CSS itself, isolated from the rest of the page: any physical
    // side in it would pin the accent rule and the list indent to the left even
    // on an Arabic page.
    const css = ar[0].html.slice(ar[0].html.indexOf(".cbox{"), ar[0].html.indexOf("</style>", ar[0].html.indexOf(".cbox{")));
    expect(css).toContain("border-inline-start");
    expect(css).toContain("padding-inline-start");
    expect(css).not.toMatch(/(?:margin|padding|border)-(?:left|right)\s*:/);
    expect(css).not.toMatch(/text-align\s*:\s*(?:left|right)/);
    // Colours come from the existing tokens, which already have a dark-scheme
    // value — so the blocks follow the page into dark mode with no second query.
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

// A fixture rather than real content: escaping and structure have to hold for
// whatever a future author writes, including the characters that would break the
// page if they reached it raw.
describe("article-template renders tutorial blocks safely", () => {
  const HOSTILE = '</code></pre><script>alert("x")</script> & "quoted" <b>';
  const doc = {
    title: "Fixture",
    description: "Fixture",
    updatedLabel: "Last updated",
    lead: ["Lead."],
    sections: [
      {
        heading: "Do the thing",
        prereqs: { label: `Need ${HOSTILE}`, items: [`item ${HOSTILE}`] },
        body: ["Body."],
        steps: [
          { text: `step ${HOSTILE}`, code: [`echo ${HOSTILE}`] },
          { text: "step without code" },
        ],
        success: { label: `Worked ${HOSTILE}`, body: [`saw ${HOSTILE}`], code: [`out ${HOSTILE}`] },
        bullets: [`note ${HOSTILE}`],
        troubleshooting: {
          label: `If ${HOSTILE}`,
          items: [{ symptom: `sym ${HOSTILE}`, code: [`ls ${HOSTILE}`], fix: `fix ${HOSTILE}` }],
        },
      },
    ],
    cta: { text: "cta", button: "go", href: "/cli" },
    relatedHeading: "More",
  };
  const html = renderArticlePage({ slug: "guides/fixture", lang: "ar", doc, updated: "2026-08-05" });

  it("escapes every hostile string in every block", () => {
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('alert("x")');
    // One occurrence per field that carried the fixture string: 1 prereq label
    // + 1 prereq item + 1 step + 1 step code + 1 success label + 1 success body
    // + 1 success code + 1 bullet + 1 troubleshooting label + 1 symptom
    // + 1 check + 1 fix = 12.
    expect((html.match(/&lt;\/code&gt;&lt;\/pre&gt;&lt;script&gt;/g) || []).length).toBe(12);
    expect(html).toContain("&amp; &quot;quoted&quot; &lt;b&gt;");
  });

  it("keeps the ordered list ordered and the description list well formed", () => {
    const ol = html.slice(html.indexOf("<ol class=\"steps\""), html.indexOf("</ol>") + 5);
    expect(ol.startsWith('<ol class="steps" data-block="steps">')).toBe(true);
    expect((ol.match(/<li>/g) || []).length).toBe(2);
    expect(ol).not.toContain("<ul");
    // A step without a command still renders as a step, not as a dangling <pre>.
    expect(ol).toContain("<li><p>step without code</p></li>");

    const dl = html.slice(html.indexOf("<dl>"), html.indexOf("</dl>") + 5);
    expect((dl.match(/<dt>/g) || []).length).toBe(1);
    expect((dl.match(/<dd>/g) || []).length).toBe(1);
    expect(dl.indexOf("<dt>")).toBeLessThan(dl.indexOf("<dd>"));
  });

  it("stays inside one main landmark and ships the gated block CSS once", () => {
    expect(html.split("<main>").length - 1).toBe(1);
    expect((html.match(/\.cbox\{/g) || []).length).toBe(1);
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  it("omits the block CSS entirely for a doc that uses no block", () => {
    const plain = { ...doc, sections: [{ heading: "H", body: ["B"], bullets: ["b"] }] };
    const out = renderArticlePage({ slug: "guides/fixture", lang: "en", doc: plain, updated: "2026-08-05" });
    expect(out).not.toContain(".cbox{");
    expect(out).not.toContain("data-block=");
  });
});

// The point of the file. Each mutation below is a real way this work could rot;
// if the rules above shrugged at any of them they would be decoration.
describe("the structural guard fails when a tutorial regresses", () => {
  const en = cliSyncLargeFolder.langs.en;
  const clone = () => JSON.parse(JSON.stringify(en));

  it("catches a removed troubleshooting block", () => {
    const doc = clone();
    for (const s of doc.sections) delete s.troubleshooting;
    expect(validate("x", "en", doc, null).join("\n")).toMatch(/exactly one troubleshooting block, found 0/);
  });

  it("catches a procedure demoted to a bullet list", () => {
    const doc = clone();
    for (const s of doc.sections) {
      if (!s.steps) continue;
      s.bullets = [...(s.bullets || []), ...s.steps.map((step, i) => `${i + 1}. ${step.text}`)];
      delete s.steps;
    }
    const bad = validate("x", "en", doc, null).join("\n");
    expect(bad).toMatch(/has no numbered procedure/);
    expect(bad).toMatch(/bullet types its own number/);

    // And the rendered page loses the <ol> the semantics test demands.
    const html = renderArticlePage({ slug: "guides/x", lang: "en", doc, updated: "2026-08-05" });
    expect(html).not.toContain('data-block="steps"');
  });

  it("catches a troubleshooting check that is prose instead of a command", () => {
    const doc = clone();
    const t = doc.sections.find((s) => s.troubleshooting).troubleshooting;
    t.items[0].code = ["check your network settings and try again"];
    expect(validate("x", "en", doc, null).join("\n")).toMatch(/check is not executable/);
  });

  it("catches a vague fix and a fix that names nothing concrete", () => {
    const doc = clone();
    const t = doc.sections.find((s) => s.troubleshooting).troubleshooting;
    t.items[0].fix = "Check your network and make sure everything is correct on both ends.";
    t.items[1].fix = "Have another look at it and then try the whole thing once more, slowly.";
    const bad = validate("x", "en", doc, null).join("\n");
    expect(bad).toMatch(/vague fix/);
    expect(bad).toMatch(/names nothing concrete/);
  });

  it("catches a locale that translated a command", () => {
    const doc = JSON.parse(JSON.stringify(cliSyncLargeFolder.langs.de));
    const s = doc.sections.find((x) => x.steps?.some((st) => st.code?.length));
    const st = s.steps.find((x) => x.code?.length);
    st.code[0] = st.code[0].replace("tmux new -s xfer", "tmux neu -s xfer");
    expect(validate("x", "de", doc, en).join("\n")).toMatch(/a command or an expected output was translated/);
  });

  it("catches a locale that dropped a step", () => {
    const doc = JSON.parse(JSON.stringify(cliSyncLargeFolder.langs.ja));
    doc.sections.find((s) => s.steps?.length).steps.pop();
    expect(validate("x", "ja", doc, en).join("\n")).toMatch(/structure diverges from en/);
  });

  // ── and the three fact-level guards ───────────────────────────────────────
  const s2s = () => JSON.parse(JSON.stringify(cliServerToServer.langs.en));
  const sync = () => JSON.parse(JSON.stringify(cliSyncLargeFolder.langs.en));

  it("catches the listener printing the pusher's fingerprint", () => {
    // Exactly the defect this batch shipped with: `serve` announced 74318e3b…,
    // the fingerprint the rest of the guide uses for the machine pushing to it.
    const doc = s2s();
    const s = doc.sections.find((x) => x.success?.code?.some((c) => c.includes("listening on")));
    s.success.code = s.success.code.map((c) => c.replace(/\(fingerprint \w+…\)/, "(fingerprint 74318e3b…)"));
    expect(identityComplaints("x", doc).join("\n")).toMatch(/sender and receiver share fingerprint/);
  });

  it("catches the sender's identity drifting between the prompt and the allow-list", () => {
    const doc = s2s();
    const s = doc.sections.find((x) => x.code?.some((c) => c.includes("Accept and remember this peer?")));
    s.code = s.code.map((c) => c.replace(/fingerprint: \w+…/, "fingerprint: 0badc0de…"));
    expect(identityComplaints("x", doc).join("\n")).toMatch(/the sender is not one identity/);
  });

  it("notices when there is no fingerprint left to compare", () => {
    // A guard that silently finds nothing is worse than no guard, so an example
    // stripped of its output has to complain rather than pass.
    const doc = s2s();
    for (const s of doc.sections) if (s.success) delete s.success.code;
    expect(identityComplaints("x", doc).join("\n")).toMatch(/pass vacuously/);
  });

  /** Rewrite every code block in a document, wherever a section can hold one. */
  const mapCode = (doc, f) => {
    for (const s of doc.sections) {
      if (s.code) s.code = s.code.map(f);
      for (const st of s.steps || []) if (st.code) st.code = st.code.map(f);
      if (s.success?.code) s.success.code = s.success.code.map(f);
      for (const i of s.troubleshooting?.items || []) if (i.code) i.code = i.code.map(f);
    }
    return doc;
  };

  it("catches cleanup that goes back to killing by pattern", () => {
    const doc = mapCode(sync(), (c) => c.replace(/kill "\$\(cat ~\/relayium-serve\.pid\)".*/g, "pkill -f 'relayium serve'"));
    const bad = lifecycleComplaints("x", doc, { owns: true }).join("\n");
    // Both halves matter: the dangerous command is back, AND the owned one is gone.
    expect(bad).toMatch(/prescribes pkill/);
    expect(bad).toMatch(/never shows the owned-lifecycle command/);
  });

  it("sees a pkill that starts a line, not only one preceded by a space", () => {
    // The first draft of this guard tested JSON.stringify(doc), where a leading
    // newline becomes a literal "\\n" and \b stops matching. It found nothing.
    const doc = sync();
    const s = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    s.items[0].code = ["pgrep -af relayium\npkill -f 'relayium sync'"];
    expect(lifecycleComplaints("x", doc).join("\n")).toMatch(/prescribes pkill/);
  });

  it("catches a fix that only recommends pkill in prose", () => {
    const doc = sync();
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    t.items[0].fix = `${t.items[0].fix} If in doubt, pkill -f relayium.`;
    expect(lifecycleComplaints("x", doc).join("\n")).toMatch(/prescribes pkill/);
  });

  it("catches an unconditional rm of the PID file", () => {
    const doc = mapCode(sync(), (c) => c.replace(/&& rm ~\/relayium-serve\.pid/g, "; rm ~/relayium-serve.pid"));
    expect(lifecycleComplaints("x", doc, { owns: true }).join("\n")).toMatch(/without requiring the signal to succeed/);
  });

  it("catches ESTAB relabelled as proof of transfer, in a comment or in a fix", () => {
    const viaComment = sync();
    const c = viaComment.sections.find((x) => x.troubleshooting).troubleshooting.items[0];
    c.code = c.code.map((b) => b.replace(/# ESTAB.*/, "# ESTAB    connected and transferring"));
    expect(estabComplaints("x", viaComment, { english: true }).join("\n")).toMatch(/equates ESTAB with bytes moving/);

    // The prose form the article actually shipped, whose trailing "not
    // established" must not be allowed to launder the claim in front of it.
    const viaFix = sync();
    const f = viaFix.sections.find((x) => x.troubleshooting).troubleshooting.items[0];
    f.fix = "ESTAB means bytes are moving; treat quiet as a stall only when the socket is not established.";
    expect(estabComplaints("x", viaFix, { english: true }).join("\n")).toMatch(/equates ESTAB with bytes moving/);
  });

  // ── and the verification-scope guard ──────────────────────────────────────
  const gs = () => JSON.parse(JSON.stringify(cliGettingStarted.langs.en));
  const hashBullets = (doc) => doc.sections.find((s) => (s.bullets || []).some((b) => b.includes(HASH)));

  it("catches the every-file verification claim coming back", () => {
    // Verbatim what this batch shipped with, in the bullet that introduces sync.
    const doc = sync();
    const s = hashBullets(doc);
    s.bullets = s.bullets.map((b) =>
      b.includes(HASH)
        ? "Verifies every file: each file is checked with SHA-256 end to end, so a completed mirror is known to be intact."
        : b,
    );
    const bad = hashScopeComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/claims SHA-256 without naming the mtime skip/);
    expect(bad).toMatch(/every\/all\/each file is hash-verified, unscoped/);
    expect(bad).toMatch(/declares the whole mirror or copy intact/);
  });

  it("catches the same overclaim in a locale no English phrase table would see", () => {
    // The cross-locale half has to have teeth of its own. This is the zh bullet
    // exactly as it shipped; the co-occurrence rule is what notices it.
    const doc = JSON.parse(JSON.stringify(cliSyncLargeFolder.langs.zh));
    const s = hashBullets(doc);
    s.bullets = s.bullets.map((b) =>
      b.includes(HASH) ? "校验每个文件：每个文件都做端到端的 SHA-256 校验，因此完成的镜像可以确认是完整的。" : b,
    );
    expect(hashScopeComplaints("x", doc).join("\n")).toMatch(/claims SHA-256 without naming the mtime skip/);
  });

  it("catches du -sh totals going back to standing in for integrity", () => {
    const doc = sync();
    const v = verifySection(doc);
    v.success.body = [
      "du -sh reports the same total on both servers, and the until loop has returned you to an ordinary shell prompt rather than retrying again.",
    ];
    v.bullets = ["Every file was SHA-256 checked on arrival, so matching sizes plus a clean exit means an intact copy."];
    const bad = hashScopeComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/reads du -sh totals without saying sync skipped by size\+mtime/);
    expect(bad).toMatch(/the verify notes never mention mtime/);
    expect(bad).toMatch(/never calls matching du -sh totals coarse rather than proof/);
  });

  it("notices when there is no SHA-256 claim left to scope", () => {
    // A rule about how hashing is worded passes trivially once nothing mentions
    // hashing, so the absence has to be a complaint of its own.
    const doc = sync();
    for (const s of doc.sections) s.bullets = (s.bullets || []).filter((b) => !b.includes(HASH));
    doc.faq.items = doc.faq.items.filter((i) => !i.a.includes(HASH));
    expect(hashScopeComplaints("x", doc).join("\n")).toMatch(/SHA-256 claim\(s\) left to scope/);
  });

  // ── and the ssh-prerequisite guard ────────────────────────────────────────
  it("catches the ssh check going back to promising a working push", () => {
    const doc = gs();
    sshCheckStep(doc).text =
      "Check you can already reach the server the ordinary way. push reuses exactly this access, so if ssh works, push works.";
    const bad = sshPrereqComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/sells a working ssh as a working push/);
    expect(bad).toMatch(/never names user@your-server:backups\//);
    expect(bad).toMatch(/never says push can still fail/);
  });

  it("catches a locale that kept the short, wrong version of that step", () => {
    const doc = JSON.parse(JSON.stringify(cliGettingStarted.langs.de));
    sshCheckStep(doc).text =
      "Prüf, ob du den Server auf dem gewohnten Weg schon erreichst. push nutzt genau diesen Zugang wieder: klappt ssh, klappt push.";
    expect(sshPrereqComplaints("x", doc).join("\n")).toMatch(/never names user@your-server:backups\//);
  });

  // ── and the firewall, failure-class and PID-certainty guards ──────────────
  it("catches the firewall rule going back to opening 9031 to the world", () => {
    const doc = mapCode(sync(), (c) => c.replace(scopedUfw("203.0.113.9"), "sudo ufw allow 9031/tcp"));
    const bad = firewallComplaints("x", doc, "203.0.113.9").join("\n");
    // Both halves matter: the open door is back, AND the scoped rule is gone.
    expect(bad).toMatch(/opens 9031 to every source/);
    expect(bad).toMatch(/never shows the source-scoped rule/);
  });

  it("catches a rule that keeps the scoped syntax but leaves the scope out", () => {
    // `from any` looks like the fix and is the defect: it allows the internet
    // through a rule shaped exactly like the one the guide asks for.
    const doc = mapCode(sync(), (c) =>
      c.replace(scopedUfw("203.0.113.9"), "sudo ufw allow from any to any port 9031 proto tcp"),
    );
    expect(firewallComplaints("x", doc, "203.0.113.9").join("\n")).toMatch(/opens 9031 to every source/);
  });

  it("catches a scoped rule whose example address the prose never tells you to replace", () => {
    // 203.0.113.9 is TEST-NET-3. A reader who pastes the rule unchanged has
    // allowed a host that is not their sender, so the command is not the fix.
    const doc = sync();
    const item = doc.sections
      .flatMap((s) => s.troubleshooting?.items || [])
      .find((i) => (i.code || []).some((c) => c.includes("ufw")));
    item.fix =
      "The port is blocked. Open it in the receiver's firewall and its cloud security group, then confirm serve is really listening on 9031.";
    const bad = firewallComplaints("x", doc, "203.0.113.9", { english: true }).join("\n");
    expect(bad).toMatch(/appears only inside the command/);
    expect(bad).toMatch(/never says which of the sender's addresses/);
  });

  it("catches daemon direct going back to exactly two failure classes", () => {
    // Verbatim what this batch shipped with, both halves of it.
    const doc = s2s();
    doc.sections.find((s) => s.troubleshooting).body = [
      "Daemon direct has exactly two things that can go wrong: reachability and trust. Each of the four below is settled by one command, on the machine named next to it.",
    ];
    const bad = failureClassComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/still says only two things can go wrong/);
    expect(bad).toMatch(/still promises one command settles each case/);
    expect(bad).toMatch(/never says these are not the only ways a push can fail/);
    expect(bad).toMatch(/no longer points at ss -tinp/);
  });

  it("catches the integrity failure being dated to mid-stream again", () => {
    // The wording this batch shipped: the check is real, the timing is not.
    const doc = s2s();
    const section = doc.sections.find((s) => s.troubleshooting);
    section.body = section.body.map((b) =>
      b.replace("a transferred file whose integrity check fails", "a file that fails its integrity check mid-stream"),
    );
    const bad = failureClassComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/dates the integrity failure to mid-stream/);
  });

  it("catches a locale whose troubleshooting intro dropped both first checks", () => {
    const doc = JSON.parse(JSON.stringify(cliServerToServer.langs.ja));
    doc.sections.find((s) => s.troubleshooting).body = ["プッシュが通らないときは、下の4つを順に見てください。"];
    const bad = failureClassComplaints("x", doc).join("\n");
    expect(bad).toMatch(/no longer points at ss -tinp/);
    expect(bad).toMatch(/no longer points at relayium authorize/);
  });

  it("notices when there is no troubleshooting intro left to judge", () => {
    const doc = s2s();
    delete doc.sections.find((s) => s.troubleshooting).body;
    expect(failureClassComplaints("x", doc, { english: true }).join("\n")).toMatch(/pass vacuously/);
  });

  it("catches the absolute claim about what a signal to the recorded PID can reach", () => {
    // The sentence this batch shipped, in the step that stops the listener.
    const doc = sync();
    const step = verifySection(doc).steps.find((st) => (st.code || []).some((c) => c.includes("kill ")));
    step.text =
      "Stop the listener on the receiver once the totals match. It signals the one PID you recorded when you launched it, so no other process on the machine can be caught by it, and the PID file is removed only if that signal succeeded.";
    expect(pidCertaintyComplaints("x", doc, { english: true }).join("\n")).toMatch(
      /cannot reach anything but the listener/,
    );
  });

  it("catches the same absolute claim in the paragraph that records the PID", () => {
    const doc = sync();
    const s = doc.sections.find((x) => (x.body || []).some((b) => b.includes("relayium-serve.pid")));
    s.body = s.body.map((b) =>
      b.includes("relayium-serve.pid")
        ? "The same line records the new process's PID in ~/relayium-serve.pid, which is how the last step of this guide stops exactly this listener and nothing else:"
        : b,
    );
    expect(pidCertaintyComplaints("x", doc, { english: true }).join("\n")).toMatch(
      /cannot reach anything but the listener/,
    );
  });

  it("catches the PID inspection command disappearing from the guide", () => {
    const doc = mapCode(sync(), (c) =>
      c
        .split("\n")
        .filter((l) => !l.startsWith("ps -p"))
        .join("\n"),
    );
    expect(pidCertaintyComplaints("x", doc, { english: true }).join("\n")).toMatch(
      /never shows how to check what the recorded PID is now/,
    );
  });

  it("catches a check that stops printing byte counters at all", () => {
    const doc = sync();
    for (const s of doc.sections)
      for (const i of s.troubleshooting?.items || [])
        i.code = (i.code || []).map((b) => b.replace("ss -tinp dst :9031", "ss -tnp | grep 9031"));
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting.items[0];
    t.fix = t.fix.replace("bytes_acked", "byte");
    const bad = estabComplaints("x", doc, { english: true }).join("\n");
    expect(bad).toMatch(/no longer asks ss for per-socket info/);
    expect(bad).toMatch(/names no byte counter/);
  });
});
