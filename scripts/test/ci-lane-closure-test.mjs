#!/usr/bin/env node
// scripts/test/ci-lane-closure-test.mjs — every file a lane READS must select
// that lane.
//
// ## The failure this exists for
//
// `scripts/ci/select-lanes.mjs` decides which lanes a pull request runs from
// the lanes' own `on: push: paths:` filters, and `ci-lane-selector-test.mjs`
// proves it reads those filters correctly. Neither can say whether a filter is
// COMPLETE. A lane whose tests read `../server/account/store.go`, or whose
// workflow runs `bash scripts/test/ios-app-store-candidate-test.sh`, but whose
// filter names neither, is a lane the merge gate skips on exactly the commit
// that breaks it. The board is green, the breakage surfaces later against an
// innocent commit, and nothing in between ever ran. W-N18 A08e was that shape
// (a fixture-only edit to `link-session-vectors.json` started no Web or Go
// suite), and audit D of 2026-09-28 found fourteen more.
//
// ## What this checks
//
// For each conditional lane, the set of repository files it demonstrably reads,
// gathered four ways, and then ONE assertion per read: changing that file
// selects that lane (through `selectLanes`, the function the gate runs — no
// second glob compiler here to disagree with it).
//
//   1. THE WORKFLOW. Every repository path token in the lane's own workflow,
//      outside its `on:` block and comments: `run:` commands, `with:` inputs
//      (`go-version-file: server/go.mod` is an input), `env:` command strings.
//      A token is resolved against the repository root and against every
//      `working-directory:` the workflow declares, and counts only when it
//      names a TRACKED FILE. `npm run <script>` / `npm test` are followed into
//      the `package.json` of the step's working directory.
//   2. WHAT THOSE COMMANDS RUN, transitively. A script the workflow invokes
//      (`.sh`, `.mjs`, `.js`, `.py`, `.ps1`) is scanned the same way, relative
//      to its own directory as well, until no new script appears. This is how
//      `apps/mac/scripts/test-release-readiness.sh`'s `"$repo_root/apps/…"`
//      evidence list reaches the macOS lane.
//   3. THE LANE'S TEST SOURCES, as declared in `scripts/ci/lane-external-inputs.json`
//      (`sources`): the test files a lane's test runner collects without any
//      command naming them. They are scanned for relative reads only —
//      `"../server/…"` literals and `resolve(import.meta.dirname, "..", "server", …)`
//      segment lists — because a bare `server/x.go` token inside a Vitest file
//      is prose, not a path its cwd would resolve.
//   4. DECLARED INPUTS. Reads no text scan can see: a Kotlin test that opens a
//      fixture through a Gradle system property, a template literal
//      (`Fixtures/${name}`). The JSON declares each with its reader, and this
//      file asserts the declaration is still true (the file exists) and that
//      every DYNAMIC read the scan finds is covered by one — so a new
//      `${…}` read cannot pass silently for want of a declaration.
//
// Plus one Gradle-specific closure, because the lane filter is only half of
// the W-N18 failure: every shared fixture an Android JVM test names must also
// be a declared `inputs.files` of `:protocol:test`, or a fixture-only edit
// starts the lane and the task still reports UP-TO-DATE.
//
// ## What this deliberately is not
//
// Not a full static closure. Swift tests reading through `#filePath`, Go
// `embed` directives, and paths assembled at run time from variables are not
// resolved; a lane whose only read is one of those is not protected by this
// file. The shape chosen is "scan the forms that are actually used here, and
// make the others declare themselves", and the declared forms are asserted as
// hard as the scanned ones.
//
// ## Accepted gaps are named, not muted
//
// `knownGaps` in the JSON lists (lane, glob) pairs that are real reads the
// filter deliberately does not watch, each with the reason and the revisit
// trigger. Every gap must still be HIT by at least one read, or it is stale and
// fails — an exception that outlives its reason is how a rule rots.
//
// ## Negative controls
//
// `CI_LANE_CLOSURE_WORKFLOWS_DIR` points the selector at another copy of the
// workflows. `--self-test` mutates copies of the real filters and requires each
// mutation to be reported by name.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CONTROL_FILES, LANES, selectLanes } from "../ci/select-lanes.mjs";
import {
  BILLING_DOC, BILLING_DOC_READER, BILLING_DOC_ROOTS, SERVER_JOBS, classify as classifyWebScope,
} from "../ci/web-lane-scope.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = "scripts/ci/lane-external-inputs.json";

// ── the repository, as git sees it ──────────────────────────────────────────

const tracked = new Set(
  // Untracked-but-not-ignored files count too, so a local run judges a new
  // script the same way CI will once it is committed.
  spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" }).stdout
    .split("\0").filter(Boolean),
);
if (tracked.size < 100) {
  console.error(`ci-lane-closure-test: git ls-files returned ${tracked.size} files; not a checkout?`);
  process.exit(2);
}
const trackedDirs = new Set();
for (const file of tracked) {
  let dir = posix.dirname(file);
  while (dir !== "." && !trackedDirs.has(dir)) { trackedDirs.add(dir); dir = posix.dirname(dir); }
}
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

/** `base`/`rel` as a repository-relative path, or null if it leaves the repository. */
function repoPath(base, rel) {
  const joined = posix.normalize(posix.join(base || ".", rel)).replace(/\/$/, "");
  if (joined.startsWith("../") || joined === ".." || joined.startsWith("/")) return null;
  return joined === "." ? "" : joined;
}

/** `**`-aware glob over repository paths: `**\/` spans zero or more directories. */
function globRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { source += "(?:[^/]+/)*"; i += 2; } else { source += ".*"; i += 1; }
    } else if (ch === "*") source += "[^/]*";
    else source += ch.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
const filesMatching = (glob) => {
  const re = globRegExp(glob);
  return [...tracked].filter((file) => re.test(file)).sort();
};

// ── comment stripping, per family ───────────────────────────────────────────

const HASH_FAMILY = /\.(sh|bash|py|ps1|yml|yaml|toml)$/;
/** Lines with comments removed; line numbers are preserved (blanked, not dropped). */
function codeLines(path, text) {
  const hash = HASH_FAMILY.test(path);
  const python = path.endsWith(".py");
  let inDoc = false;
  return text.split("\n").map((line) => {
    if (python) {
      // A docstring is prose. Blank it, opening and closing lines included.
      const quotes = (line.match(/"""|\'\'\'/g) ?? []).length;
      if (inDoc || quotes > 0) {
        if (quotes % 2 === 1) inDoc = !inDoc;
        return "";
      }
    }
    const trimmed = line.trimStart();
    if (hash) {
      if (trimmed.startsWith("#")) return "";
      return line.replace(/\s#\s.*$/, "");
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
    return line.replace(/\s\/\/\s.*$/, "");
  });
}

// ── what a piece of text reads ──────────────────────────────────────────────

const SCRIPT = /\.(sh|bash|mjs|js|cjs|ts|py|ps1)$/;
const JS = /\.(mjs|js|cjs|ts)$/;
const TOKEN = /[A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]*)+/g;

/**
 * Repository files named by path tokens in `lines`, resolved against `bases`.
 *
 * A token that follows a `$` has its first segment (the variable) dropped, so
 * `$repo_root/apps/mac/x.sh` and `"$script_dir/../lib/x.sh"` resolve; `${x}/a`
 * tokenises as `/a` and resolves from the base. Only TRACKED FILES count. A token that
 * ends in `/` directly before `${` is a dynamic read of that directory and is
 * returned separately, for the declarations to cover.
 */
function tokenReads(lines, bases) {
  const hits = [];
  const dynamic = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(TOKEN)) {
      const token = match[0].replace(/^\.\//, "");
      if (token.includes("://") || line.slice(Math.max(0, match.index - 3), match.index).endsWith(":/")) continue;
      const after = line.slice(match.index + match[0].length, match.index + match[0].length + 2);
      const segments = token.split("/");
      // `$repo_root/apps/x.sh` tokenises as `repo_root/apps/x.sh`: a leading
      // segment that is a shell VARIABLE is dropped, and only that one. Any
      // other prefix is part of the path — `$tmp/repo/README.md` must not be
      // read as the repository's README.
      const variable = line[match.index - 1] === "$";
      const starts = variable ? [1] : [0];
      let found = null;
      for (const start of starts) {
        const rel = segments.slice(start).join("/");
        if (rel === "") continue;
        for (const base of bases) {
          const path = repoPath(base, rel);
          if (path === null || path === "") continue;
          if (tracked.has(path)) { found = { path, kind: "file" }; break; }
          if (after === "${" && token.split("/").includes("..") && token.endsWith("/")
            && trackedDirs.has(path.replace(/\/$/, ""))) {
            found = { path: path.replace(/\/$/, ""), kind: "dynamic" };
            break;
          }
        }
        if (found) break;
      }
      if (found?.kind === "file") hits.push({ path: found.path, line: index + 1 });
      else if (found?.kind === "dynamic") dynamic.push({ dir: found.path, line: index + 1 });
    }
  });
  return { hits, dynamic };
}

/**
 * Reads in a JavaScript/TypeScript source, by the forms that are actually
 * used here and nothing looser: `"../x/y"` string literals (and `./x`
 * import specifiers, so the module graph is followed), and
 * `resolve|join(<base>, "seg", "seg", …)` calls whose segments climb out with
 * `..`. A bare `server/x.go` string in a JS file is NOT a read here — page
 * generators and tests carry such paths as prose, and a cwd-relative read
 * that is not spelled with `..` resolves inside the file's own tree.
 *
 * A `"../dir/${…}"` template is a DYNAMIC read of `dir`, returned separately.
 */
function jsReads(lines, bases) {
  const text = lines.join("\n");
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  const hits = [];
  const dynamic = [];
  for (const match of text.matchAll(/(["'`])(\.{1,2}\/[^"'`\n]*)\1?/g)) {
    const literal = match[2];
    const dollar = literal.indexOf("${");
    const stat = dollar === -1 ? literal : literal.slice(0, dollar);
    const climbs = stat.startsWith("../");
    for (const base of bases) {
      const path = repoPath(base, stat);
      if (path === null || path === "") continue;
      if (dollar === -1 && tracked.has(path)) { hits.push({ path, line: lineOf(match.index) }); break; }
      if (dollar === -1 && climbs && trackedDirs.has(path)) {
        // a whole directory handed to a reader (`testdata/`): every file in it is read
        hits.push({ path: `${path}/**`, line: lineOf(match.index) });
        break;
      }
      if (dollar === -1 && !/\.[A-Za-z0-9]+$/.test(path)) {
        // an extensionless import specifier: `./x` → `./x.ts` / `./x.js` / `./x/index.ts`
        const found = ["ts", "js", "mjs", "svelte.ts"].map((ext) => `${path}.${ext}`)
          .concat(["index.ts", "index.js"].map((name) => `${path}/${name}`))
          .find((candidate) => tracked.has(candidate));
        if (found) { hits.push({ path: found, line: lineOf(match.index) }); break; }
      }
      if (climbs && dollar !== -1 && stat.endsWith("/") && trackedDirs.has(path)) {
        dynamic.push({ dir: path, line: lineOf(match.index) });
        break;
      }
    }
  }
  const SEG = /(?:resolve|join)\(\s*([A-Za-z_.$()]+(?:\([^()]*\))?)\s*,((?:\s*(["'])[^"'`$\n]*\3\s*,?)+)\s*\)/g;
  for (const match of text.matchAll(SEG)) {
    const segments = [...match[2].matchAll(/(["'])([^"']*)\1/g)].map((m) => m[2]);
    const rel = segments.join("/");
    if (!rel.startsWith("..")) continue;
    for (const base of bases) {
      const path = repoPath(base, rel);
      if (path !== null && tracked.has(path)) { hits.push({ path, line: lineOf(match.index) }); break; }
    }
  }
  return { hits, dynamic };
}

/**
 * Where a relative path in a JS/TS file can be resolved from: the file's own
 * directory (`new URL("../x", import.meta.url)`, `join(here, "..")`) and its
 * package root, which is the cwd every `npm run`/Vitest invocation of it uses
 * (`readFileSync("../server/x.go")` in a web test). Not the workflow's other
 * working directories: a `../..` from one of those names a different place.
 */
function jsBases(file) {
  const bases = [posix.dirname(file)];
  for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) {
    if (tracked.has(`${dir}/package.json`)) { if (dir !== bases[0]) bases.push(dir); break; }
  }
  return bases;
}

// ── a workflow, reduced to what it runs ─────────────────────────────────────

/** The workflow's lines with the `on:` block and comments blanked. */
function workflowBody(text) {
  const lines = codeLines("x.yml", text);
  let inOn = false;
  return lines.map((line) => {
    if (/^on:\s*$/.test(line)) { inOn = true; return ""; }
    if (inOn && /^\S/.test(line)) inOn = false;
    return inOn ? "" : line;
  });
}

const workingDirsOf = (lines) => [...new Set(lines
  .map((line) => line.match(/working-directory:\s*['"]?([^'"\s]+)/)?.[1])
  .filter(Boolean)
  .map((dir) => (dir === "." ? "" : dir.replace(/\/$/, ""))))];

/** `npm run x` / `npm test` in `lines`, resolved to the command text in each candidate package.json. */
function npmScriptCommands(lines, dirs) {
  const commands = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\bnpm (?:run(?:-script)? ([A-Za-z0-9:_-]+)|(test)\b)/g)) {
      const name = match[1] ?? match[2];
      for (const dir of dirs) {
        const pkgPath = dir ? `${dir}/package.json` : "package.json";
        if (!tracked.has(pkgPath)) continue;
        const command = JSON.parse(read(pkgPath)).scripts?.[name];
        if (command) commands.push({ pkgPath, dir, name, command, line: index + 1 });
      }
    }
  });
  return commands;
}

// ── collect every read, per lane ────────────────────────────────────────────

const manifest = JSON.parse(read(MANIFEST));

/** @returns {Map<string, {path:string, why:string}[]>} lane id → reads */
/** For each line of a workflow body, the job it belongs to (or null outside `jobs:`). */
function jobOfLines(body) {
  let inJobs = false;
  let job = null;
  return body.map((line) => {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; job = null; return null; }
    if (/^\S/.test(line) && line.trim() !== "") { inJobs = false; job = null; return null; }
    const head = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (head) job = head[1];
    return inJobs ? job : null;
  });
}

/**
 * Every read of every lane, as `{ path, why, jobs }`. `jobs` is the set of the
 * lane's own jobs through which the read happens (null when unknown, e.g. a
 * workflow token outside `jobs:`); a test source is attributed to the jobs its
 * `sources` entry names, `["test"]` by default for web.
 */
export function collectReads() {
  const reads = new Map(LANES.map((lane) => [lane.id, []]));
  const dynamicReads = [];
  const ignored = (manifest.ignoredReads ?? []).map((entry) => ({ ...entry, hit: false }));
  for (const lane of LANES) {
    const add = (path, why, jobs) => {
      const source = why.split(":")[0];
      const skip = ignored.find((entry) => entry.lane === lane.id && entry.path === path && entry.source === source);
      if (skip) { skip.hit = true; return; }
      reads.get(lane.id).push({ path, why, jobs });
    };
    const wfPath = `.github/workflows/${lane.workflow}`;
    const body = workflowBody(read(wfPath));
    const jobOf = jobOfLines(body);
    const dirs = ["", ...workingDirsOf(body)];

    const queue = [];
    const scriptJobs = new Map();
    const enqueue = (path, why, jobs) => {
      add(path, why, jobs);
      if (!SCRIPT.test(path)) return;
      const known = scriptJobs.get(path);
      if (known === undefined) {
        scriptJobs.set(path, jobs === null ? null : new Set(jobs));
        queue.push(path);
      } else if (known !== null) {
        const before = known.size;
        if (jobs === null) { scriptJobs.set(path, null); queue.push(path); return; }
        for (const job of jobs) known.add(job);
        if (known.size !== before) queue.push(path);
      }
    };
    const jobsAt = (line) => (jobOf[line - 1] ? new Set([jobOf[line - 1]]) : null);

    // 1. the workflow itself
    for (const { path, line } of tokenReads(body, dirs).hits) enqueue(path, `${wfPath}:${line}`, jobsAt(line));
    for (const { pkgPath, dir, name, command, line } of npmScriptCommands(body, dirs)) {
      add(pkgPath, `${wfPath}:${line} (npm ${name})`, jobsAt(line));
      for (const { path } of tokenReads([command], [dir]).hits) {
        enqueue(path, `${wfPath}:${line} → ${pkgPath} "${name}"`, jobsAt(line));
      }
    }
    // 2. what those commands run, transitively (re-scanned when a new job reaches a script)
    while (queue.length > 0) {
      const script = queue.shift();
      const jobs = scriptJobs.get(script);
      const lines = codeLines(script, read(script));
      const { hits, dynamic } = JS.test(script)
        ? jsReads(lines, jsBases(script))
        : tokenReads(lines, [posix.dirname(script), ...dirs]);
      for (const { path, line } of hits) enqueue(path, `${script}:${line}`, jobs);
      for (const { dir, line } of dynamic) dynamicReads.push({ lane: lane.id, file: script, dir, line });
      for (const { pkgPath, dir, name, command, line } of npmScriptCommands(lines, dirs)) {
        add(pkgPath, `${script}:${line} (npm ${name})`, jobs);
        for (const { path } of tokenReads([command], [dir]).hits) enqueue(path, `${script}:${line} → ${pkgPath} "${name}"`, jobs);
      }
    }
    // 3. the lane's test sources
    for (const spec of manifest.sources[lane.id] ?? []) {
      for (const file of filesMatching(spec.glob)) {
        const only = (manifest.sourceJobs?.[lane.id] ?? []).find((entry) => entry.source === file);
        const jobs = new Set(only ? only.jobs : (spec.jobs ?? []));
        const lines = codeLines(file, read(file));
        const { hits, dynamic } = jsReads(lines, jsBases(file));
        for (const { path, line } of hits) add(path, `${file}:${line}`, jobs.size ? jobs : null);
        for (const { dir, line } of dynamic) dynamicReads.push({ lane: lane.id, file, dir, line });
      }
    }
    // 4. declared inputs
    for (const input of manifest.declared[lane.id] ?? []) {
      add(input.path, `declared: ${input.reader}`, input.jobs ? new Set(input.jobs) : null);
    }
  }
  for (const entry of ignored) {
    if (!entry.hit) dynamicReads.push({ staleIgnore: entry });
  }
  return { reads, dynamicReads };
}

/** Shared-fixture names an Android JVM test opens, e.g. `"crypto-vectors.json"`. */
function androidFixtureNames() {
  const names = new Map();
  for (const file of filesMatching("apps/android/**/src/test/**/*.kt")) {
    codeLines(file, read(file)).forEach((line, index) => {
      for (const match of line.matchAll(/"([A-Za-z0-9_.-]+\.json)"/g)) {
        if (tracked.has(`apps/RelayiumKit/Tests/Fixtures/${match[1]}`) && !names.has(match[1])) {
          names.set(match[1], `${file}:${index + 1}`);
        }
      }
    });
  }
  return names;
}

// ── the assertions ──────────────────────────────────────────────────────────

export function closureFailures({ workflowsDir } = {}) {
  const failures = [];
  const { reads, dynamicReads } = collectReads();
  const gaps = (manifest.knownGaps ?? []).map((gap) => ({
    ...gap, re: globRegExp(gap.glob), hit: false, excused: new Set(),
  }));
  const compatText = codeLines("compat.yml", read(".github/workflows/compat.yml")).join("\n");
  const selectedBy = new Map();
  const lanesFor = (path) => {
    // A control file selects every lane through `decide()`'s fail-closed rule.
    if (!selectedBy.has(path)) {
      selectedBy.set(path, CONTROL_FILES.includes(path)
        ? new Set(LANES.map((lane) => lane.id))
        : selectLanes([path], { workflowsDir }));
    }
    return selectedBy.get(path);
  };

  let checked = 0;
  for (const [lane, list] of reads) {
    const byPath = new Map();
    for (const { path, why } of list) if (!byPath.has(path)) byPath.set(path, why);
    for (const [path, why] of byPath) {
      checked += 1;
      // A directory read (`…/testdata/**`) is every tracked file below it.
      const files = path.endsWith("/**")
        ? [...tracked].filter((file) => file.startsWith(path.slice(0, -2))).sort()
        : [path];
      if (files.length === 0 || (!path.endsWith("/**") && !tracked.has(path))) {
        failures.push(`${lane}: input ${path} does not exist (${why})`);
        continue;
      }
      const unselected = [];
      for (const file of files) {
        if (lanesFor(file).has(lane)) continue;
        const gap = gaps.find((g) => g.lane === lane && g.re.test(file));
        if (gap) { gap.hit = true; gap.excused.add(file); continue; }
        unselected.push(file);
      }
      if (unselected.length === 0) continue;
      failures.push(`${lane} reads ${unselected[0]}${unselected.length > 1
        ? ` and ${unselected.length - 1} more file(s) under ${path}` : ""} (${why}) but a change to it `
        + `does not select ${lane}`);
    }
  }
  // The Gradle half of W-N18: a fixture an Android JVM test opens must start
  // the lane AND be a declared input of the task, or the task stays UP-TO-DATE.
  const gradle = read("apps/android/protocol/build.gradle.kts");
  const gradleCode = codeLines("x.kts", gradle).join("\n");
  const fixtures = androidFixtureNames();
  for (const [name, where] of fixtures) {
    const path = `apps/RelayiumKit/Tests/Fixtures/${name}`;
    checked += 1;
    const gap = gaps.find((g) => g.lane === "android" && g.re.test(path));
    if (gap) { gap.hit = true; gap.excused.add(path); }
    else if (!lanesFor(path).has("android")) {
      failures.push(`android reads ${path} (${where}) but a change to it does not select android`);
    }
    if (!gradleCode.includes(`sharedFixtures.file("${name}")`)) {
      failures.push(`${where} opens ${name}, which apps/android/protocol/build.gradle.kts does not `
        + `declare in \`inputs.files(...)\`; a fixture-only edit leaves :protocol:test UP-TO-DATE`);
    }
  }
  for (const gap of gaps) {
    if (!gap.hit) failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob} is hit by no read any more; remove it`);
    // A gap that claims another lane runs the same thing must be true: every
    // tracked file it excuses has to select that lane. `compat` is the one
    // UNCONDITIONAL lane the gate requires on every pull request: it has no
    // path filter, so the claim to verify is that it has none and that it
    // really runs the named command.
    if (gap.coveredBy === "compat") {
      if (/^\s+paths(?:-ignore)?:/m.test(compatText)) {
        failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob} relies on compat.yml running on every change, but compat.yml now has a path filter`);
      }
      if (!gap.compatRuns || !compatText.includes(gap.compatRuns)) {
        failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob} claims compat.yml runs ${JSON.stringify(gap.compatRuns ?? null)}, which no compat.yml command contains`);
      }
    } else if (gap.coveredBy) {
      const loose = [...tracked].filter((file) => gap.re.test(file) && !lanesFor(file).has(gap.coveredBy));
      if (loose.length > 0) {
        failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob} claims coverage by ${gap.coveredBy}, `
          + `but ${loose[0]}${loose.length > 1 ? ` and ${loose.length - 1} more` : ""} does not select it`);
      }
    }
  }

  // A gap that is covered because the file cannot change alone: every file it
  // excuses must be named by `derivedFrom` (a checker in the unconditional
  // lane that fails when the file drifts from its generator), and that checker
  // must itself select the lane.
  for (const gap of gaps) {
    if (!gap.derivedFrom) continue;
    const checker = read(gap.derivedFrom);
    for (const file of gap.excused) {
      if (!checker.includes(file)) {
        failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob}: ${file} is not held to its generator by ${gap.derivedFrom}`);
      }
    }
    if (!lanesFor(gap.derivedFrom).has(gap.lane)) {
      failures.push(`knownGaps entry ${gap.lane} ← ${gap.glob}: ${gap.derivedFrom} does not select ${gap.lane}, so a generator change would not re-run it`);
    }
  }

  // An ignored read that no scan produces any more is stale.
  for (const { staleIgnore } of dynamicReads.filter((entry) => entry.staleIgnore)) {
    failures.push(`ignoredReads entry ${staleIgnore.lane} ${staleIgnore.source} → ${staleIgnore.path} matches no read any more; remove it`);
  }

  // Inside web.yml, a server-only change runs only SERVER_JOBS (the `scope`
  // job and scripts/ci/web-lane-scope.mjs). So every server file a NON-server
  // job of that lane reads must classify as `light`, or a change to it alone
  // skips its only reader — D-H2 again, one level down.
  const webWorkflows = workflowsDir ?? resolve(repoRoot, ".github/workflows");
  const lightSeen = new Set();
  for (const { path, why, jobs } of reads.get("web") ?? []) {
    if (!path.startsWith("server/")) continue;
    if (lightSeen.has(path)) continue;
    const light = jobs === null || [...jobs].some((job) => !SERVER_JOBS.includes(job));
    if (!light) continue;
    lightSeen.add(path);
    checked += 1;
    const files = path.endsWith("/**")
      ? [...tracked].filter((file) => file.startsWith(path.slice(0, -2)))
      : [path];
    const missed = files.filter((file) => !classifyWebScope([file], { workflowsDir: webWorkflows }).light);
    if (missed.length > 0) {
      failures.push(`web job(s) [${jobs === null ? "unknown" : [...jobs].join(", ")}] read ${missed[0]}`
        + `${missed.length > 1 ? ` and ${missed.length - 1} more` : ""} (${why}), but a change to it alone `
        + `classifies light=false in scripts/ci/web-lane-scope.mjs, so those jobs would be skipped; add it `
        + `to LIGHT_SERVER_INPUTS`);
    }
  }

  // Declared DYNAMIC READERS: tests whose inputs are named by a document at run
  // time, so no scan of the test's source can see them. Each entry's document
  // is read here with the reader's own ROOTS (parsed out of the reader, so a
  // changed root list cannot drift), and every file it cites must select the
  // lane — and, in the web lane, classify `light` so the job that runs the
  // reader is not skipped. Anything unreadable fails.
  for (const entry of manifest.dynamicReaders ?? []) {
    const label = `dynamicReaders ${entry.lane} ${entry.reader}`;
    let readerText;
    let markdown;
    try { readerText = read(entry.reader); } catch (err) { failures.push(`${label}: reader unreadable (${err.code ?? err.message})`); continue; }
    try { markdown = read(entry.document); } catch (err) { failures.push(`${label}: document ${entry.document} unreadable (${err.code ?? err.message})`); continue; }
    const rootsSource = /const ROOTS = (\[[^\]]*\]);/.exec(readerText)?.[1];
    let roots = null;
    try { roots = rootsSource ? JSON.parse(rootsSource) : null; } catch { roots = null; }
    if (!Array.isArray(roots) || roots.length === 0) {
      failures.push(`${label}: no parseable \`const ROOTS = [...]\` in the reader, so the files it opens are unknown`);
      continue;
    }
    if (entry.lane === "web") {
      if (entry.reader !== BILLING_DOC_READER || entry.document !== BILLING_DOC) {
        failures.push(`${label}: scripts/ci/web-lane-scope.mjs scans ${BILLING_DOC} for ${BILLING_DOC_READER}; the two declarations disagree`);
      }
      if (JSON.stringify(roots) !== JSON.stringify(BILLING_DOC_ROOTS)) {
        failures.push(`${label}: the reader's ROOTS ${JSON.stringify(roots)} differ from web-lane-scope.mjs BILLING_DOC_ROOTS ${JSON.stringify(BILLING_DOC_ROOTS)}`);
      }
    }
    const cited = new Set();
    for (const match of markdown.matchAll(/`([A-Za-z0-9_/.-]+\.(?:go|ts|mjs|svelte))(?::\d+(?:-\d+)?)?`/g)) {
      const path = roots.map((root) => (root ? `${root}/${match[1]}` : match[1])).find((c) => tracked.has(c));
      if (path) cited.add(path);
    }
    if (cited.size === 0) { failures.push(`${label}: ${entry.document} resolves to no files at all`); continue; }
    for (const path of [...cited].sort()) {
      checked += 1;
      if (!lanesFor(path).has(entry.lane)) {
        failures.push(`${entry.lane} reads ${path} (${entry.reader} via ${entry.document}) but a change to it does not select ${entry.lane}`);
        continue;
      }
      if (entry.lane === "web" && path.startsWith("server/")
        && !classifyWebScope([path], { workflowsDir: webWorkflows }).light) {
        failures.push(`web job(s) [${entry.jobs.join(", ")}] read ${path} (${entry.reader} via ${entry.document}), but a `
          + `change to it alone classifies light=false in scripts/ci/web-lane-scope.mjs, so those jobs would be skipped`);
      }
    }
  }

  // Every dynamic read is covered: either the whole directory already selects
  // the lane, or a declaration names that reader and the concrete files. In
  // the web lane a dynamic server read always needs its declaration, because
  // selecting the LANE is not enough there (see above).
  for (const { lane, file, dir, line } of dynamicReads.filter((entry) => !entry.staleIgnore)) {
    const under = [...tracked].filter((path) => path.startsWith(`${dir}/`));
    const lightWeb = lane === "web" && dir.startsWith("server/");
    if (!lightWeb && under.length > 0 && under.every((path) => lanesFor(path).has(lane))) continue;
    const covered = (manifest.declared[lane] ?? []).some((input) =>
      input.reader.startsWith(file) && input.path.startsWith(`${dir}/`));
    if (!covered) {
      failures.push(`${lane}: ${file}:${line} reads ${dir}/\${…}, which no scan can resolve; declare `
        + `each concrete file it reads under declared.${lane} in ${MANIFEST} with reader "${file}"`);
    }
  }

  return { failures, checked, lanes: reads.size, fixtures: fixtures.size, gaps: gaps.length };
}

// ── self-test: each property must be observed failing ───────────────────────

function withEntries(text, transform) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^ {4}paths:/.test(line));
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^ {6}/.test(lines[end]))) end += 1;
  const entries = lines.slice(at + 1, end).filter((line) => /^ {6}- /.test(line));
  return [...lines.slice(0, at + 1), ...transform(entries), ...lines.slice(end)].join("\n");
}

function selfTest() {
  const problems = [];
  const cases = [
    ["web.yml", "'server/**'", /web reads server\/account\/store\.go/],
    ["ios-transfer-interop.yml", "'server/**'",
      /ios-transfer-interop reads server\//],
    ["ios.yml", "'scripts/test/ios-app-store-candidate-test.sh'",
      /ios reads scripts\/test\/ios-app-store-candidate-test\.sh/],
    ["swift-package.yml", "'scripts/ci/assert-swift-named-execution.mjs'",
      /swift-package reads scripts\/ci\/assert-swift-named-execution\.mjs/],
  ];
  for (const [workflow, entry, expect] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "relayium-lane-closure-"));
    try {
      cpSync(resolve(repoRoot, ".github/workflows"), dir, { recursive: true });
      const text = readFileSync(join(dir, workflow), "utf8");
      const mutated = withEntries(text, (entries) => entries.filter((line) => !line.includes(entry)));
      if (mutated === text) { problems.push(`self-test: ${workflow} has no entry ${entry} to remove`); continue; }
      writeFileSync(join(dir, workflow), mutated);
      const { failures } = closureFailures({ workflowsDir: dir });
      if (!failures.some((f) => expect.test(f))) {
        problems.push(`self-test: removing ${entry} from ${workflow} was not reported (want ${expect})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return problems;
}

// ── the command ─────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const override = process.env.CI_LANE_CLOSURE_WORKFLOWS_DIR;
  const listReads = process.argv.includes("--list");
  if (listReads) {
    const { reads } = collectReads();
    for (const [lane, list] of reads) {
      const byPath = new Map();
      for (const { path, why } of list) if (!byPath.has(path)) byPath.set(path, why);
      for (const [path, why] of [...byPath].sort()) console.log(`${lane}\t${path}\t${why}`);
    }
    process.exit(0);
  }
  const result = closureFailures({ workflowsDir: override ? resolve(override) : undefined });
  const problems = [...result.failures, ...(override ? [] : selfTest())];
  if (problems.length > 0) {
    console.error(`ci-lane-closure-test: ${problems.length} failure(s)\n`);
    for (const message of problems) console.error(`  ✗ ${message}`);
    process.exit(1);
  }
  console.log(`ci-lane-closure-test: OK (${result.checked} lane reads across ${result.lanes} lanes each `
    + `select their lane; ${result.fixtures} Android shared fixtures are Gradle inputs; `
    + `${result.gaps} named known gap(s), each still hit; 4 filter-removal mutations each reported)`);
}
