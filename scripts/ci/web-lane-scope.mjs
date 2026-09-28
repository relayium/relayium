#!/usr/bin/env node
// scripts/ci/web-lane-scope.mjs — which JOBS inside `web.yml` one change set
// needs, once the merge gate has decided the lane runs at all.
//
// ## Why this exists
//
// `web.yml` watches `server/**` because three of its jobs build and run real Go
// code (`sealed-box-interop`, `device-inbox-e2e`, `mixed-link-e2e`) — see the
// header of that file and audit D-H2. But ~97 % of server commits touch nothing
// else, and on those the rest of the lane (`npm run check`, the full Vitest
// suite, the build, the accessibility scan, five browser journeys and a
// Windows-runner job) re-runs over bytes that did not change. This helper
// splits the lane in two:
//
//   * `server` — the Go-running jobs. Needed by ANY change that selects the lane.
//   * `light`  — everything else. Needed unless every changed path that selects
//                the lane is a server file those jobs do not read.
//
// "Do not read" is a closed list, `LIGHT_SERVER_INPUTS`: the server files the
// light jobs open as test input (router.test.ts ← handlers.go, …) or build
// input (the macOS release catalog). A server file on that list makes the
// change `light`. `scripts/test/ci-lane-closure-test.mjs` asserts every server
// read it finds in a light job is on it, so the list cannot silently fall
// behind the tests — the same failure D-H2 was about, one level down.
//
// ## Fail closed means RUN MORE
//
// Anything uncertain — an event this file does not diff (workflow_dispatch, a
// dispatched merge gate), an all-zero `before`, a fetch or diff that fails, an
// empty change list, an unreadable filter, any exception — answers
// `light=true server=true`. A skipped job inside a lane the gate selected
// reports SUCCESS to the gate, so under-selection here is a green gate over
// untested code; over-selection costs minutes.
//
// ## The change set
//
// pull_request: `git diff --no-renames <base.sha> <github.sha>`, where
// `github.sha` is the merge commit a pull_request run checks out, so the diff
// is exactly what merging would change. `--no-renames` reports both halves of a
// rename. push: `<before> <github.sha>`. Only the two trees are needed, so a
// depth-1 fetch of the base commit is enough.
//
// Dependency-free, like `select-lanes.mjs`, whose filter reader and matcher it
// reuses so "selects the lane" means one thing.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileGlob, matchesFilter, readPushPaths } from "./select-lanes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultWorkflowsDir = resolve(repoRoot, ".github/workflows");

/** The jobs gated on `server`. Every other job in web.yml is gated on `light`. */
export const SERVER_JOBS = ["sealed-box-interop", "device-inbox-e2e", "mixed-link-e2e"];

/**
 * Server files the LIGHT jobs read, as `select-lanes` globs. Each names its
 * reader; `ci-lane-closure-test.mjs` requires every light-job read under
 * `server/` to match one of these.
 */
export const LIGHT_SERVER_INPUTS = [
  "server/account/handlers.go",               // web/src/lib/router.test.ts
  "server/account/deletion.go",               // web/src/lib/AccountLifecycleLandings.test.ts
  "server/account/oauth.go",                  // AccountLifecycleLandings.test.ts (`${f}`)
  "server/account/apple_web.go",              // AccountLifecycleLandings.test.ts (`${f}`)
  "server/account/store.go",                  // MePage.browser-senders / i18n-browser-sender-identity tests
  "server/account/macos_release_catalog.json", // web/scripts/stage-macos-release.mjs (npm run build)
  "server/internal/signal/pair.go",           // web/src/lib/pair-code.test.ts
  "server/cmd/relayium/run.go",               // web/scripts/pages/cli-backup-integrity-recovery.test.mjs
  "server/internal/storecrypto/testdata/**",  // web/src/lib/store-crypto.interop.test.ts
];

export class ScopeAll extends Error {}

const isServerPath = (path) => path.startsWith("server/");
const lightServerInput = (path) =>
  LIGHT_SERVER_INPUTS.some((glob) => compileGlob(glob).test(path));

/**
 * `{ light, server }` for a list of changed paths.
 *
 * A path that does not select web.yml needs nothing here (the lane runs for
 * some other path, or not at all). One that does needs `server`, and also
 * `light` unless it is a server file outside `LIGHT_SERVER_INPUTS`.
 */
export function classify(paths, { workflowsDir = defaultWorkflowsDir } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ScopeAll("no changed paths; an empty diff is not a change set this file can judge");
  }
  const patterns = readPushPaths(readFileSync(resolve(workflowsDir, "web.yml"), "utf8"), "web.yml");
  const selecting = paths.filter((path) => matchesFilter(patterns, path));
  return {
    light: selecting.some((path) => !isServerPath(path) || lightServerInput(path)),
    server: selecting.length > 0,
  };
}

/** The changed paths of this run, from git, or a `ScopeAll`. */
export function changedPaths(env, git = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })) {
  const event = env.WEB_SCOPE_EVENT;
  const base = event === "pull_request" ? env.WEB_SCOPE_PR_BASE : event === "push" ? env.WEB_SCOPE_BEFORE : null;
  if (base === null) throw new ScopeAll(`event ${JSON.stringify(event ?? null)} is not diffed here`);
  const head = env.WEB_SCOPE_HEAD;
  for (const [name, sha] of [["base", base], ["head", head]]) {
    if (!/^[0-9a-f]{40}$/.test(sha ?? "") || /^0+$/.test(sha)) {
      throw new ScopeAll(`the ${name} commit ${JSON.stringify(sha ?? null)} is not a usable commit id`);
    }
  }
  const fetched = git(["fetch", "--no-tags", "--depth=1", "origin", base]);
  if (fetched.status !== 0) throw new ScopeAll(`git fetch of ${base} failed: ${(fetched.stderr ?? "").trim()}`);
  const diff = git(["diff", "--name-only", "--no-renames", "-z", base, head]);
  if (diff.status !== 0) throw new ScopeAll(`git diff ${base} ${head} failed: ${(diff.stderr ?? "").trim()}`);
  return diff.stdout.split("\0").filter(Boolean);
}

/** The two output lines for `$GITHUB_OUTPUT`, plus the reason on stderr. */
export function decide(env, options = {}) {
  try {
    const paths = (options.changedPaths ?? changedPaths)(env);
    const { light, server } = classify(paths, options);
    process.stderr.write(`web-lane-scope: ${paths.length} changed path(s) → light=${light} server=${server}\n`);
    return { light, server };
  } catch (err) {
    process.stderr.write(`web-lane-scope: running every web job: ${err instanceof ScopeAll ? err.message : err}\n`);
    return { light: true, server: true };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { light, server } = decide(process.env);
  process.stdout.write(`light=${light}\nserver=${server}\n`);
}
