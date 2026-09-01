#!/usr/bin/env node
// scripts/test/dependabot-policy-test.mjs — the layer-3 half of
// docs/DEPENDENCY-POLICY.md, checked the same way layer 1 is: as a pure function
// over an in-memory copy of `.github/dependabot.yml`, with the mutations that
// prove each rule can still fail running in the same invocation.
//
// What makes this worth a job of its own is that NOTHING else in this repository
// can see any of it. `.github/dependabot.yml` is read by GitHub, never by a
// build: the file stays valid YAML when a third ecosystem appears, when both
// ecosystems collapse onto the same weekday and the same hour, when
// `open-pull-requests-limit` grows to 10, when `update-types` quietly starts
// including `major`, or when `insecure-external-code-execution` is added. Every
// lane stays green, and the next signal is an unreviewed dependency change
// reaching the lanes that sign the CLI and notarize the macOS app.
//
// ## What it enforces
//
//   1. Exactly two ecosystems — `gomod` at /server and `npm` at /web. Every
//      other ecosystem, `github-actions` and `swift` above all, is named as
//      deliberately unconfigured (item 1 deferred; item 5 trigger reached, its
//      evaluation not yet run) rather than tolerated.
//   2. Weekly, staggered. Different weekdays AND different explicit HH:MM times,
//      both off-hour, both in Asia/Dubai — so the two ecosystems never land in
//      one batch and never open mid-workday.
//   3. `open-pull-requests-limit: 3` on each: a bound on review load.
//   4. Grouping restricted to `minor` + `patch`, exactly. A major folded into a
//      grouped "chore(deps)" pull request is a major nobody read, so `major` in
//      an `update-types` list is a failure — and so is an ABSENT `update-types`,
//      which groups everything.
//   5. No `ignore:` anywhere. Majors are not suppressed; they open on their own.
//   6. No `registries`, `reviewers`, `assignees`, `target-branch` or
//      `insecure-external-code-execution`, and no unknown key at all.
//   7. Distinct commit-message prefixes, so the two queues are separable.
//
// ## Why the YAML parser is written here and fails closed
//
// `web/` is the only Node project in this tree and this must run with nothing
// installed — the same constraint as `macos-publish-order-test.mjs`. So the
// parser below covers exactly the block subset this file uses and REFUSES
// everything else: tabs, duplicate keys, a key with no value, flow collections,
// anchors, aliases, block scalars, a line it cannot attribute to an open block.
// A policy parser that guesses is worse than none, because the thing it guesses
// wrong about is the thing an attacker or an accident put there.
//
// ## What it does NOT prove
//
// Whether Dependabot is switched ON. Alerts, security updates and version
// updates are live repository settings, not tracked files; this gate cannot see
// them, and neither can any other check here. docs/DEPENDENCY-POLICY.md records
// that state and who owns it. It also proves nothing about whether an opened
// pull request is any good — that is the review this arrangement exists to
// preserve.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = ".github/dependabot.yml";

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

// ---------------------------------------------------------------------------
// 1. A fail-closed parser for the block-YAML subset this file may use
// ---------------------------------------------------------------------------

class YamlError extends Error {}
function yamlFail(line, what) {
  throw new YamlError(`line ${line}: ${what}`);
}

const KEY = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

function tokenize(text) {
  const tokens = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n += 1) {
    const raw = lines[n].replace(/\s+$/, "");
    if (raw === "" || /^\s*#/.test(raw)) continue;
    if (raw.includes("\t")) yamlFail(n + 1, "contains a tab; YAML indentation must be spaces");
    const indent = raw.length - raw.trimStart().length;
    const content = raw.slice(indent);
    if (content === "-") yamlFail(n + 1, "a sequence dash with nothing after it is not supported here");
    if (content.startsWith("- ")) {
      const after = content.slice(1);
      const gap = after.length - after.trimStart().length;
      tokens.push({ line: n + 1, indent, seq: true });
      tokens.push({ line: n + 1, indent: indent + 1 + gap, content: after.trimStart() });
    } else {
      tokens.push({ line: n + 1, indent, content });
    }
  }
  return tokens;
}

function scalar(raw, line) {
  if (/^[[{&*!|>]/.test(raw)) yamlFail(line, `unsupported YAML construct in value "${raw}"`);
  const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(raw);
  if (quoted) return quoted[1] ?? quoted[2];
  if (raw.includes(" #")) yamlFail(line, `unsupported trailing comment in value "${raw}"`);
  if (raw.includes('"') || raw.includes("'")) yamlFail(line, `unbalanced quoting in value "${raw}"`);
  return raw;
}

function parseBlock(tokens, i, indent) {
  return tokens[i].seq ? parseSeq(tokens, i, indent) : parseMap(tokens, i, indent);
}

function parseSeq(tokens, i, indent) {
  const out = [];
  while (i < tokens.length && tokens[i].indent === indent && tokens[i].seq) {
    const marker = tokens[i];
    i += 1;
    if (i >= tokens.length || tokens[i].indent <= indent) yamlFail(marker.line, "sequence item has no value");
    const first = tokens[i];
    if (!first.seq && !KEY.test(first.content)) {
      out.push(scalar(first.content, first.line));
      i += 1;
    } else {
      const [value, next] = parseBlock(tokens, i, first.indent);
      out.push(value);
      i = next;
    }
  }
  return [out, i];
}

function parseMap(tokens, i, indent) {
  const out = new Map();
  while (i < tokens.length && tokens[i].indent === indent && !tokens[i].seq) {
    const token = tokens[i];
    const matched = KEY.exec(token.content);
    if (!matched) yamlFail(token.line, `"${token.content}" is not "key: value"`);
    const key = matched[1];
    const rest = (matched[2] ?? "").trim();
    if (out.has(key)) yamlFail(token.line, `duplicate key "${key}"`);
    i += 1;
    if (rest === "") {
      if (i >= tokens.length || tokens[i].indent <= indent) {
        yamlFail(token.line, `key "${key}" has no value and no indented block`);
      }
      const [value, next] = parseBlock(tokens, i, tokens[i].indent);
      out.set(key, value);
      i = next;
    } else {
      out.set(key, scalar(rest, token.line));
    }
  }
  return [out, i];
}

function parseYaml(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) throw new YamlError("the file has no content");
  if (tokens[0].indent !== 0) yamlFail(tokens[0].line, "the document does not start at column 0");
  const [doc, next] = parseBlock(tokens, 0, 0);
  if (next < tokens.length) {
    yamlFail(
      tokens[next].line,
      `could not attribute this line to any open block (indent ${tokens[next].indent}`
      + " matches no enclosing level)",
    );
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 2. The policy, as data
// ---------------------------------------------------------------------------

const TOP_ALLOWED = ["version", "updates"];
const TOP_FORBIDDEN = ["registries", "enable-beta-ecosystems"];

const ENTRY_REQUIRED = [
  "package-ecosystem", "directory", "schedule", "open-pull-requests-limit",
  "commit-message", "groups",
];
// Named individually so the diagnostic says WHY, not just "unknown key".
const ENTRY_FORBIDDEN = {
  "ignore": "majors and unwanted updates are declined in review, never suppressed here",
  "registries": "no credentialed private registry is configured for this repository",
  "reviewers": "review assignment is not encoded in the update bot",
  "assignees": "review assignment is not encoded in the update bot",
  "target-branch": "updates open against the default branch only",
  "insecure-external-code-execution": "never enabled",
  "pull-request-branch-name": "not configured in this wave",
};
const SCHEDULE_KEYS = ["interval", "day", "time", "timezone"];
const TIMEZONE = "Asia/Dubai";
const LIMIT = "3";
const UPDATE_TYPES = ["minor", "patch"];
const PATTERNS = ["*"];

const EXPECTED = [
  {
    ecosystem: "gomod",
    directory: "/server",
    day: "monday",
    // Go has no production/development split in go.mod, so one group is the
    // whole module graph and a dependency-type filter would mean nothing.
    groups: new Map([["go-minor-and-patch", null]]),
  },
  {
    ecosystem: "npm",
    directory: "/web",
    day: "wednesday",
    groups: new Map([
      ["web-production-minor-and-patch", "production"],
      ["web-development-minor-and-patch", "development"],
    ]),
  },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREFIX = /^chore\(deps\/[a-z]+\)$/;
// Asia/Dubai working hours. 22:00-05:59 is the window an update pull request may
// open in without landing in the middle of somebody's day.
const OFF_HOUR = (hour) => hour >= 22 || hour <= 5;

const listOf = (values) => `[${values.join(", ")}]`;
const isMap = (value) => value instanceof Map;
const str = (value) => (typeof value === "string" ? value : null);

// ---------------------------------------------------------------------------
// 3. The policy, as one pure function of the file text
// ---------------------------------------------------------------------------

function policyFailures(text) {
  const out = [];
  const say = (message) => out.push(`${CONFIG}: ${message}`);

  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    if (!(err instanceof YamlError)) throw err;
    say(err.message);
    return out; // Fail closed: an unparseable policy file is not a passing one.
  }
  if (!isMap(doc)) {
    say("the document is not a mapping");
    return out;
  }

  for (const key of doc.keys()) {
    if (TOP_FORBIDDEN.includes(key)) say(`top-level key "${key}" is forbidden here`);
    else if (!TOP_ALLOWED.includes(key)) say(`unknown top-level key "${key}"`);
  }
  for (const key of TOP_ALLOWED) {
    if (!doc.has(key)) say(`missing required top-level key "${key}"`);
  }
  if (doc.has("version") && str(doc.get("version")) !== "2") {
    say(`version is "${doc.get("version")}"; Dependabot version updates require exactly 2`);
  }

  const updates = doc.get("updates");
  if (!Array.isArray(updates)) {
    say("updates is not a sequence");
    return out;
  }
  if (updates.length !== EXPECTED.length) {
    say(`updates has ${updates.length} entry/entries; expected exactly ${EXPECTED.length}`);
  }

  const seen = [];
  let groupsChecked = 0;

  updates.forEach((entry, index) => {
    const where = `updates[${index}]`;
    if (!isMap(entry)) {
      say(`${where} is not a mapping`);
      return;
    }
    for (const key of entry.keys()) {
      if (key in ENTRY_FORBIDDEN) say(`${where}: key "${key}" is forbidden — ${ENTRY_FORBIDDEN[key]}`);
      else if (!ENTRY_REQUIRED.includes(key)) say(`${where}: unknown key "${key}"`);
    }
    for (const key of ENTRY_REQUIRED) {
      if (!entry.has(key)) say(`${where}: missing required key "${key}"`);
    }

    const ecosystem = str(entry.get("package-ecosystem"));
    const directory = str(entry.get("directory"));
    const wanted = EXPECTED.find((e) => e.ecosystem === ecosystem && e.directory === directory);
    if (ecosystem !== null && !EXPECTED.some((e) => e.ecosystem === ecosystem)) {
      say(
        `${where}: package-ecosystem "${ecosystem}" is deliberately unconfigured; see the`
        + " ecosystem policy items in docs/DEPENDENCY-POLICY.md",
      );
    }
    if (ecosystem !== null && directory !== null) {
      const id = `${ecosystem}:${directory}`;
      if (seen.includes(id)) say(`${where}: ${id} is configured twice`);
      seen.push(id);
    }

    // --- schedule ---
    const schedule = entry.get("schedule");
    if (schedule !== undefined && !isMap(schedule)) say(`${where}: schedule is not a mapping`);
    else if (isMap(schedule)) {
      for (const key of schedule.keys()) {
        if (!SCHEDULE_KEYS.includes(key)) say(`${where}: unknown schedule key "${key}"`);
      }
      for (const key of SCHEDULE_KEYS) {
        if (!schedule.has(key)) say(`${where}: schedule is missing required key "${key}"`);
      }
      const interval = str(schedule.get("interval"));
      if (schedule.has("interval") && interval !== "weekly") {
        say(`${where}: schedule.interval is "${interval}"; expected "weekly"`);
      }
      const timezone = str(schedule.get("timezone"));
      if (schedule.has("timezone") && timezone !== TIMEZONE) {
        say(`${where}: schedule.timezone is "${timezone}"; expected "${TIMEZONE}"`);
      }
      const day = str(schedule.get("day"));
      if (wanted && day !== wanted.day) {
        say(`${where}: schedule.day is "${day}"; expected "${wanted.day}" for ${wanted.ecosystem}`);
      }
      const time = str(schedule.get("time"));
      if (schedule.has("time")) {
        if (time === null || !HHMM.test(time)) {
          say(`${where}: schedule.time "${time}" is not an explicit 24-hour HH:MM value`);
        } else if (!OFF_HOUR(Number(time.slice(0, 2)))) {
          say(
            `${where}: schedule.time "${time}" is inside 06:00-21:59 ${TIMEZONE}; expected an`
            + " off-hour time",
          );
        }
      }
    }

    // --- bound and prefix ---
    const limit = str(entry.get("open-pull-requests-limit"));
    if (entry.has("open-pull-requests-limit") && limit !== LIMIT) {
      say(`${where}: open-pull-requests-limit is "${limit}"; expected exactly ${LIMIT}`);
    }
    const commit = entry.get("commit-message");
    if (commit !== undefined && !isMap(commit)) say(`${where}: commit-message is not a mapping`);
    else if (isMap(commit)) {
      for (const key of commit.keys()) {
        if (key !== "prefix") say(`${where}: unknown commit-message key "${key}"`);
      }
      const prefix = str(commit.get("prefix"));
      if (prefix === null || !PREFIX.test(prefix)) {
        say(`${where}: commit-message.prefix "${prefix}" does not match chore(deps/<name>)`);
      }
    }

    // --- groups ---
    const groups = entry.get("groups");
    if (groups !== undefined && !isMap(groups)) say(`${where}: groups is not a mapping`);
    else if (isMap(groups) && wanted) {
      const names = [...groups.keys()].sort();
      const expectedNames = [...wanted.groups.keys()].sort();
      if (names.join(",") !== expectedNames.join(",")) {
        say(`${where}: groups are ${listOf(names)}; expected exactly ${listOf(expectedNames)}`);
      }
      for (const [name, group] of groups) {
        const at = `${where}: group "${name}"`;
        if (!isMap(group)) {
          say(`${at} is not a mapping`);
          continue;
        }
        groupsChecked += 1;
        const wantedType = wanted.groups.get(name);
        for (const key of group.keys()) {
          if (!["patterns", "update-types", "dependency-type"].includes(key)) {
            say(`${at}: unknown key "${key}"`);
          }
        }
        for (const key of ["patterns", "update-types"]) {
          if (!group.has(key)) say(`${at}: missing required key "${key}"`);
        }
        if (wanted.groups.has(name)) {
          const type = group.has("dependency-type") ? str(group.get("dependency-type")) : null;
          if (wantedType === null && group.has("dependency-type")) {
            say(`${at}: dependency-type is not applicable to ${wanted.ecosystem}`);
          } else if (wantedType !== null && type !== wantedType) {
            say(`${at}: dependency-type is "${type}"; expected "${wantedType}"`);
          }
        }
        const patterns = group.get("patterns");
        if (group.has("patterns")) {
          if (!Array.isArray(patterns) || patterns.join(",") !== PATTERNS.join(",")) {
            say(`${at}: patterns is ${listOf([patterns].flat())}; expected exactly ${listOf(PATTERNS)}`);
          }
        }
        const types = group.get("update-types");
        if (group.has("update-types")) {
          if (!Array.isArray(types)) {
            say(`${at}: update-types is not a sequence`);
          } else if (types.includes("major")) {
            say(
              `${at}: update-types includes "major", which folds a major update into a grouped`
              + " pull request nobody reads separately",
            );
          } else if ([...types].sort().join(",") !== [...UPDATE_TYPES].sort().join(",")) {
            say(`${at}: update-types is ${listOf(types)}; expected exactly ${listOf(UPDATE_TYPES)}`);
          }
        }
      }
    }
  });

  // --- the set, and the stagger, across entries ---
  const wantedIds = EXPECTED.map((e) => `${e.ecosystem}:${e.directory}`);
  if ([...seen].sort().join(",") !== [...wantedIds].sort().join(",")) {
    say(`configured ecosystems are ${listOf(seen)}; expected exactly ${listOf(wantedIds)}`);
  }

  const scheduled = updates.filter(isMap).map((e) => e.get("schedule")).filter(isMap);
  const field = (name) => scheduled.map((s) => str(s.get(name))).filter((v) => v !== null);
  for (const [name, label] of [["day", "weekday"], ["time", "time"]]) {
    const values = field(name);
    const unique = new Set(values);
    if (values.length === scheduled.length && scheduled.length > 1 && unique.size !== values.length) {
      say(`both ecosystems are scheduled at the same ${label} "${values[0]}"; the stagger is the point`);
    }
  }
  const prefixes = updates
    .filter(isMap)
    .map((e) => (isMap(e.get("commit-message")) ? str(e.get("commit-message").get("prefix")) : null))
    .filter((v) => v !== null);
  if (prefixes.length > 1 && new Set(prefixes).size !== prefixes.length) {
    say(`both ecosystems use the same commit-message prefix "${prefixes[0]}"`);
  }

  // Coverage: a policy that checked nothing must not report green.
  if (groupsChecked < 3) {
    say(`only ${groupsChecked} group(s) were checked; expected 3 (1 gomod + 2 npm)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. The real file
// ---------------------------------------------------------------------------

const real = await readFile(resolve(repoRoot, CONFIG), "utf8");
for (const message of policyFailures(real)) check(false, message);

// ---------------------------------------------------------------------------
// 5. The mutations — every rule class, against in-memory copies
// ---------------------------------------------------------------------------

/** Replace the FIRST occurrence, or throw: a stale anchor is a broken harness. */
function sub(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0) throw new Error(`the anchor ${JSON.stringify(from)} is no longer in ${CONFIG}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
const GO_DIR = '    directory: "/server"\n';
const GO_TYPES = '        update-types:\n          - "minor"\n          - "patch"\n';

const MUTATIONS = [
  // --- the parser itself ---
  { name: "indentation becomes a tab", mutate: (t) => sub(t, GO_DIR, '\tdirectory: "/server"\n'),
    expect: /contains a tab/ },
  { name: "a key is repeated in one mapping", mutate: (t) => sub(t, GO_DIR, GO_DIR + GO_DIR),
    expect: /duplicate key "directory"/ },
  { name: "a line dedents to a column no open block is at",
    mutate: (t) => sub(t, "    open-pull-requests-limit: 3", "   open-pull-requests-limit: 3"),
    expect: /could not attribute this line/ },
  { name: "a line stops being key: value", mutate: (t) => sub(t, "version: 2", "version 2"),
    expect: /"version 2" is not "key: value"/ },
  { name: "a value becomes a flow sequence",
    mutate: (t) => sub(t, '        patterns:\n          - "*"\n', '        patterns: ["*"]\n'),
    expect: /unsupported YAML construct/ },
  { name: "a key is left with no value at all",
    mutate: (t) => sub(t, GO_DIR, "    directory:\n"), expect: /has no value and no indented block/ },

  // --- the ecosystem set ---
  ...["github-actions", "swift", "docker"].map((eco) => ({
    name: `the Go entry becomes ${eco}`,
    mutate: (t) => sub(t, '- package-ecosystem: "gomod"', `- package-ecosystem: "${eco}"`),
    expect: new RegExp(`package-ecosystem "${eco}" is deliberately unconfigured`),
  })),
  { name: "the Go entry watches the repository root instead of /server",
    mutate: (t) => sub(t, GO_DIR, '    directory: "/"\n'),
    expect: /expected exactly \[gomod:\/server, npm:\/web\]/ },
  { name: "the npm entry disappears",
    mutate: (t) => t.slice(0, t.indexOf('  - package-ecosystem: "npm"')),
    expect: /expected exactly \[gomod:\/server, npm:\/web\]/ },
  { name: "one ecosystem is configured twice",
    mutate: (t) => sub(sub(t, '- package-ecosystem: "npm"', '- package-ecosystem: "gomod"'),
      '    directory: "/web"\n', GO_DIR),
    expect: /gomod:\/server is configured twice/ },

  // --- cadence and stagger ---
  { name: "the cadence drops to monthly",
    mutate: (t) => sub(t, 'interval: "weekly"', 'interval: "monthly"'),
    expect: /schedule\.interval is "monthly"/ },
  { name: "both ecosystems land on the same weekday",
    mutate: (t) => sub(t, 'day: "wednesday"', 'day: "monday"'),
    expect: /same weekday "monday"/ },
  { name: "both ecosystems land at the same time",
    mutate: (t) => sub(t, 'time: "05:00"', 'time: "04:00"'),
    expect: /same time "04:00"/ },
  { name: "an update batch is scheduled mid-workday",
    mutate: (t) => sub(t, 'time: "04:00"', 'time: "09:00"'),
    expect: /"09:00" is inside 06:00-21:59 Asia\/Dubai/ },
  { name: "the time stops being an explicit HH:MM",
    mutate: (t) => sub(t, 'time: "04:00"', 'time: "4am"'),
    expect: /"4am" is not an explicit 24-hour HH:MM/ },
  { name: "one ecosystem's schedule moves to another timezone",
    mutate: (t) => sub(t, 'timezone: "Asia/Dubai"', 'timezone: "UTC"'),
    expect: /schedule\.timezone is "UTC"/ },
  { name: "a schedule loses its timezone",
    mutate: (t) => sub(t, '      timezone: "Asia/Dubai"\n', ""),
    expect: /schedule is missing required key "timezone"/ },

  // --- the review bound ---
  // Anchored on the indented line: the bare string also occurs in the file's
  // own header comment, and a mutation that edits prose proves nothing.
  { name: "the open pull request cap grows to 10",
    mutate: (t) => sub(t, "\n    open-pull-requests-limit: 3\n", "\n    open-pull-requests-limit: 10\n"),
    expect: /open-pull-requests-limit is "10"; expected exactly 3/ },

  // --- grouping ---
  { name: "a group starts absorbing majors",
    mutate: (t) => sub(t, '          - "patch"\n', '          - "patch"\n          - "major"\n'),
    expect: /update-types includes "major"/ },
  { name: "a group narrows to patch only",
    mutate: (t) => sub(t, '          - "minor"\n          - "patch"\n', '          - "patch"\n'),
    expect: /update-types is \[patch\]; expected exactly \[minor, patch\]/ },
  { name: "a group loses update-types entirely, which groups everything",
    mutate: (t) => sub(t, GO_TYPES, ""), expect: /missing required key "update-types"/ },
  { name: "a group's patterns stop covering the whole graph",
    mutate: (t) => sub(t, '          - "*"\n', '          - "golang.org/x/*"\n'),
    expect: /patterns is \[golang\.org\/x\/\*\]; expected exactly \[\*\]/ },
  { name: "the web development group is renamed",
    mutate: (t) => sub(t, "      web-development-minor-and-patch:", "      web-dev:"),
    expect: /groups are \[web-dev, web-production-minor-and-patch\]/ },
  { name: "a web group loses its production/development split",
    mutate: (t) => sub(t, '        dependency-type: "production"\n', ""),
    expect: /dependency-type is "null"; expected "production"/ },
  { name: "the Go group gains a dependency-type go.mod does not have",
    mutate: (t) => sub(t, "        patterns:", '        dependency-type: "production"\n        patterns:'),
    expect: /dependency-type is not applicable to gomod/ },

  // --- forbidden and unknown keys ---
  ...Object.keys(ENTRY_FORBIDDEN).map((key) => ({
    name: `${key} is added to an entry`,
    mutate: (t) => sub(t, GO_DIR, `${GO_DIR}    ${key}: "x"\n`),
    expect: new RegExp(`key "${key}" is forbidden`),
  })),
  { name: "an unrecognised key is added to an entry",
    mutate: (t) => sub(t, GO_DIR, `${GO_DIR}    milestone: "4"\n`),
    expect: /unknown key "milestone"/ },
  { name: "a top-level key that is not version/updates appears",
    mutate: (t) => sub(t, "version: 2\n", "version: 2\nenable-beta-ecosystems: true\n"),
    expect: /top-level key "enable-beta-ecosystems" is forbidden/ },
  { name: "the config declares a Dependabot version other than 2",
    mutate: (t) => sub(t, "version: 2", "version: 1"), expect: /version is "1"/ },

  // --- commit-message prefixes ---
  { name: "both queues share one commit-message prefix",
    mutate: (t) => sub(t, 'prefix: "chore(deps/web)"', 'prefix: "chore(deps/go)"'),
    expect: /same commit-message prefix "chore\(deps\/go\)"/ },
  { name: "an entry loses its commit-message block",
    mutate: (t) => sub(t, '    commit-message:\n      prefix: "chore(deps/go)"\n', ""),
    expect: /missing required key "commit-message"/ },

  // --- legitimate shapes that must NOT be complained about ---
  { name: "keys are reordered within an entry — legitimate",
    mutate: (t) => sub(sub(t, "    open-pull-requests-limit: 3\n", ""),
      GO_DIR, `${GO_DIR}    open-pull-requests-limit: 3\n`),
    refute: /./ },
  { name: "a comment and a blank line are inserted — legitimate",
    mutate: (t) => sub(t, GO_DIR, `${GO_DIR}\n    # why /server and not the repository root.\n`),
    refute: /./ },
  { name: "the two off-hour times move but stay distinct and off-hour — legitimate",
    mutate: (t) => sub(sub(t, 'time: "04:00"', 'time: "23:30"'), 'time: "05:00"', 'time: "02:15"'),
    refute: /./ },
];

// The positive control. If copying or slicing the text corrupted it, every
// `expect` below would still pass — for the wrong reason.
{
  const control = policyFailures(real);
  check(
    control.length === 0,
    `the positive control failed: the real ${CONFIG} produced ${control.length} complaint(s):\n    `
    + `${control.join("\n    ")}\n  Either the file violates the policy or this harness is broken,`
    + " and in the second case every mutation result below is meaningless.",
  );
}

let asserted = 0;
for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    got = policyFailures(mutate(real));
  } catch (err) {
    check(false, `the dependabot-policy mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  asserted += 1;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the Dependabot policy did NOT complain about "${name}". Expected a message matching ${expect};`
      + ` got ${rendered}. A rule that cannot fail for the reason it was written would report green`
      + " while unreviewed dependency pull requests open against this repository.",
    );
  } else if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the Dependabot policy complained about "${name}", which is a legitimate shape. Expected NO`
      + ` message matching ${refute}; got ${rendered}. False complaints are what get a gate widened`
      + " until it says nothing.",
    );
  } else {
    check(false, `the mutation "${name}" asserts neither expect nor refute`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} dependabot-policy assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: ${CONFIG} configures exactly ${EXPECTED.length} ecosystems (gomod:/server, npm:/web),`
  + ` weekly on distinct off-hour ${TIMEZONE} slots, capped at ${LIMIT} open pull request(s) each,`
  + " with 3 minor+patch groups, no ignore rules, no forbidden settings and distinct commit"
  + ` prefixes — and ${asserted} mutation assertion(s) prove each of those can fail\n`,
);
