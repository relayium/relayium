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
// answers two questions; web.yml gates on only the first:
//
//   * `light`  — the non-Go jobs (`test`, `windows-temporary-downloader`).
//                Needed unless every changed path that selects the lane is a
//                server file those jobs do not read. These two jobs are gated.
//   * `server` — whether the Go-running jobs are needed: any change that
//                selects the lane. INFORMATIONAL ONLY: those jobs carry no
//                `if:` and always run when the lane is selected, because a
//                hosted gate that can be skipped is a gate whose green means
//                nothing (the C2 lesson web/e2e/go-server.test.mjs pins).
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
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileGlob, matchesFilter, readPushPaths } from "./select-lanes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultWorkflowsDir = resolve(repoRoot, ".github/workflows");

/** The Go-running jobs: never gated (no `if:`, no `needs: scope`). Every other job in web.yml is gated on `light`. */
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

// ── the billing document's server files, read at run time ────────────────────
//
// `web/scripts/pages/billing-doc-pointers.test.mjs` (in the light `test` job)
// opens every server file `docs/billing-transparency.md` points into, to check
// the pointer still lands on its symbol. Which files those are is decided by
// the DOCUMENT, so no hand-kept list can follow it: a server-only edit to
// `account/sqlite.go` moved 24 pointers on 2026-09-28 and, with that file
// missing from `LIGHT_SERVER_INPUTS`, would have skipped the only check that
// noticed. So the document is read here, every run, and every server file it
// cites is a light input.
//
// Deliberately WIDER than the test's own pattern: every backticked
// `path.{go,ts,mjs,svelte}` token, with or without `:line`, not only the
// `symbol` (`path:line`) pairs the test checks — over-selection costs minutes,
// under-selection is the defect. Paths resolve through the test's own roots;
// `scripts/test/ci-lane-closure-test.mjs` fails if these ROOTS stop matching
// the test's `const ROOTS`.

export const BILLING_DOC = "docs/billing-transparency.md";
export const BILLING_DOC_READER = "web/scripts/pages/billing-doc-pointers.test.mjs";
export const BILLING_DOC_ROOTS = ["server", "", "web", "server/account", "server/internal"];

/** Repository paths under server/ that the billing document cites. Throws ScopeAll when unreadable. */
export function billingDocServerInputs({ root = repoRoot } = {}) {
  let markdown;
  try {
    markdown = readFileSync(resolve(root, BILLING_DOC), "utf8");
  } catch (err) {
    throw new ScopeAll(`${BILLING_DOC} could not be read (${err.code ?? err.message}), so the server files `
      + `its pointer test opens are unknown`);
  }
  const inputs = new Set();
  let cited = 0;
  for (const match of markdown.matchAll(/`([A-Za-z0-9_/.-]+\.(?:go|ts|mjs|svelte))(?::\d+(?:-\d+)?)?`/g)) {
    cited += 1;
    for (const base of BILLING_DOC_ROOTS) {
      const path = base ? `${base}/${match[1]}` : match[1];
      if (existsSync(resolve(root, path))) {
        if (isServerPath(path)) inputs.add(path);
        break;
      }
    }
  }
  if (cited === 0) throw new ScopeAll(`${BILLING_DOC} cites no source files; refusing to treat that as "none"`);
  return inputs;
}

/**
 * `{ light, server }` for a list of changed paths.
 *
 * A path that does not select web.yml needs nothing here (the lane runs for
 * some other path, or not at all). One that does needs `server`, and also
 * `light` unless it is a server file outside `LIGHT_SERVER_INPUTS`.
 */
export function classify(paths, { workflowsDir = defaultWorkflowsDir, billingDocInputs, docRoot } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ScopeAll("no changed paths; an empty diff is not a change set this file can judge");
  }
  const cited = billingDocInputs ?? billingDocServerInputs(docRoot ? { root: docRoot } : {});
  const patterns = readPushPaths(readFileSync(resolve(workflowsDir, "web.yml"), "utf8"), "web.yml");
  const selecting = paths.filter((path) => matchesFilter(patterns, path));
  return {
    light: selecting.some((path) => !isServerPath(path) || lightServerInput(path) || cited.has(path)),
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
