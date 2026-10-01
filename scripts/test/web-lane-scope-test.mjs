#!/usr/bin/env node
// scripts/test/web-lane-scope-test.mjs — the job split inside web.yml, judged
// against fixed change sets, against the workflow that consumes it, and by
// breaking it.
//
// 1. Rows: a change set → { light, server } from `scripts/ci/web-lane-scope.mjs`.
// 2. Fail closed: every uncertainty answers light=true server=true.
// 3. Wiring: web.yml has a `scope` job, with no `if:`, running the helper.
//    Every LIGHT job (anything not in SERVER_JOBS) has `needs: scope` and
//    `if: needs.scope.outputs.light != 'false'`, so a missing output runs it.
//    Every Go-running job (SERVER_JOBS) has NO `if:` and NO `needs: scope`: it
//    runs whenever the lane is selected, because a hosted gate that can be
//    skipped is a gate whose green means nothing (the C2 lesson
//    web/e2e/go-server.test.mjs pins for mixed-link-e2e). The helper's
//    `server` output is informational only; no job reads it.
// 4. Mutations: a broken classifier, a removed light gate, and a GATED
//    Go-running job must each be reported.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  BILLING_DOC, LIGHT_SERVER_INPUTS, SERVER_JOBS, billingDocServerInputs, classify, decide,
} from "../ci/web-lane-scope.mjs";
import { fullPathOf } from "../ci/ci-evidence-view.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// ── 1. rows ─────────────────────────────────────────────────────────────────

export const ROWS = [
  [["server/internal/xfer/endpoint.go"], { light: false, server: true }, "server-only → the light jobs skip; the Go-running jobs always run"],
  [["server/go.mod", "server/internal/xfer/stream.go"], { light: false, server: true }, "several server files, none a light input"],
  [["web/src/lib/pair.ts"], { light: true, server: true }, "web-only → every job"],
  [["server/internal/xfer/endpoint.go", "web/src/lib/pair.ts"], { light: true, server: true }, "both → every job"],
  [["docs/self-hosting.md"], { light: false, server: false }, "docs-only → none (the lane would not be selected)"],
  [["docs/self-hosting.md", "server/internal/xfer/endpoint.go"], { light: false, server: true }, "a non-lane path does not widen a server-only change"],
  [["server/account/handlers.go"], { light: true, server: true }, "a server file router.test.ts reads is a light input"],
  [["server/internal/storecrypto/testdata/vector.json"], { light: true, server: true }, "store-crypto interop testdata is a light input"],
  [["server/cmd/relayium/run.go"], { light: true, server: true }, "the CLI failure line the SSH guide quotes"],
  [["docs/billing-transparency.md"], { light: true, server: true }, "a non-server lane input is light"],
  [[".github/workflows/web.yml"], { light: true, server: true }, "the lane's own definition runs everything"],
  [["scripts/ci/web-lane-scope.mjs"], { light: true, server: true }, "this helper's own edit runs everything"],
  [["server/account/plan_enforce.go"], { light: true, server: true },
    "a server file docs/billing-transparency.md cites is read by billing-doc-pointers.test.mjs in `test`: all jobs"],
  [["server/account/sqlite.go"], { light: true, server: true },
    "the file whose server-only edits moved 24 billing-doc pointers on 2026-09-28"],
];

function judge(rows, classifier) {
  const out = [];
  for (const [paths, want, why] of rows) {
    let got;
    try { got = classifier(paths); } catch (err) { got = { error: String(err) }; }
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      out.push(`${JSON.stringify(paths)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)} (${why})`);
    }
  }
  return out;
}
for (const problem of judge(ROWS, (paths) => classify(paths))) check(false, problem);

// ── 2. fail closed ──────────────────────────────────────────────────────────

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const ALL = JSON.stringify({ light: true, server: true });
const gitOk = (paths) => (args) => (args[0] === "fetch" ? { status: 0 } : { status: 0, stdout: paths.join("\0") });
const silent = (fn) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = write; }
};
for (const [why, env, changed] of [
  ["workflow_dispatch", { WEB_SCOPE_EVENT: "workflow_dispatch", WEB_SCOPE_HEAD: SHA }, undefined],
  ["no event", { WEB_SCOPE_HEAD: SHA }, undefined],
  ["an all-zero push before", { WEB_SCOPE_EVENT: "push", WEB_SCOPE_BEFORE: "0".repeat(40), WEB_SCOPE_HEAD: SHA }, undefined],
  ["a malformed base", { WEB_SCOPE_EVENT: "pull_request", WEB_SCOPE_PR_BASE: "main", WEB_SCOPE_HEAD: SHA }, undefined],
  ["a missing head", { WEB_SCOPE_EVENT: "pull_request", WEB_SCOPE_PR_BASE: SHA }, undefined],
  ["a failed fetch", { WEB_SCOPE_EVENT: "pull_request", WEB_SCOPE_PR_BASE: SHA, WEB_SCOPE_HEAD: OTHER },
    () => { throw new Error("unused"); }],
  ["an empty diff", { WEB_SCOPE_EVENT: "push", WEB_SCOPE_BEFORE: SHA, WEB_SCOPE_HEAD: OTHER }, () => []],
]) {
  const options = changed ? { changedPaths: changed } : {};
  const got = JSON.stringify(silent(() => decide(env, options)));
  check(got === ALL, `${why} did not fail closed: ${got}`);
}
{
  // The real git path, with a git that refuses the fetch.
  const env = { WEB_SCOPE_EVENT: "pull_request", WEB_SCOPE_PR_BASE: SHA, WEB_SCOPE_HEAD: OTHER };
  const { changedPaths } = await import("../ci/web-lane-scope.mjs");
  let threw = false;
  try { changedPaths(env, () => ({ status: 128, stderr: "no such commit" })); } catch { threw = true; }
  check(threw, "a failed git fetch did not throw");
  const paths = changedPaths(env, gitOk(["server/a.go", "web/b.ts"]));
  check(JSON.stringify(paths) === JSON.stringify(["server/a.go", "web/b.ts"]), `the diff parse returned ${JSON.stringify(paths)}`);
  const server = silent(() => decide(env, { changedPaths: () => ["server/internal/xfer/endpoint.go"] }));
  check(JSON.stringify(server) === JSON.stringify({ light: false, server: true }),
    `a server-only pull request decided ${JSON.stringify(server)}`);
}

// ── 3. wiring in web.yml ────────────────────────────────────────────────────

/** job name → { if, needs, text } for web.yml's jobs (2-space keys under `jobs:`). */
export function webJobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) { current = { if: undefined, needs: undefined, text: "" }; jobs.set(head[1], current); continue; }
    if (/^\S/.test(line)) break;
    if (!current) continue;
    current.text += `${line}\n`;
    const key = /^ {4}(if|needs):\s*(.*)$/.exec(line);
    if (key) current[key[1]] = key[2].trim();
  }
  return jobs;
}

export function wiringProblems(text) {
  const problems = [];
  const jobs = webJobs(text);
  const scope = jobs.get("scope");
  if (!scope) return ["web.yml has no `scope` job"];
  if (scope.if !== undefined) problems.push("the `scope` job has an `if:`; it must always run");
  if (!/run: node scripts\/ci\/web-lane-scope\.mjs >> "\$GITHUB_OUTPUT"/.test(scope.text)) {
    problems.push("the `scope` job does not run `node scripts/ci/web-lane-scope.mjs >> \"$GITHUB_OUTPUT\"`");
  }
  for (const output of ["light", "server"]) {
    if (!new RegExp(`${output}: \\$\\{\\{ steps\\.scope\\.outputs\\.${output} \\}\\}`).test(scope.text)) {
      problems.push(`the \`scope\` job does not publish its \`${output}\` output`);
    }
  }
  for (const job of SERVER_JOBS) if (!jobs.has(job)) problems.push(`SERVER_JOBS names ${job}, which web.yml no longer declares`);
  const lightGate = "needs.scope.outputs.light != 'false'";
  for (const [name, job] of jobs) {
    if (name === "scope") continue;
    if (SERVER_JOBS.includes(name)) {
      if (job.if !== undefined) {
        problems.push(`web.yml/${name}: \`if: ${job.if}\` on a Go-running job; it must run whenever the lane `
          + `is selected — a hosted gate that can be skipped is a gate whose green means nothing`);
      }
      if (job.needs !== undefined && /\bscope\b/.test(job.needs)) {
        problems.push(`web.yml/${name}: \`needs: ${job.needs}\` ties a Go-running job to the scope job; it must not depend on it`);
      }
      continue;
    }
    if (job.if !== lightGate) {
      problems.push(`web.yml/${name}: \`if: ${job.if ?? "(none)"}\`; want \`if: ${lightGate}\` — an ungated `
        + `light job re-runs the whole web suite on every server-only change`);
    }
    if (job.needs !== "scope") problems.push(`web.yml/${name}: \`needs: ${job.needs ?? "(none)"}\`; want \`needs: scope\``);
  }
  return problems;
}

const webYml = fullPathOf("web.yml", readFileSync(resolve(repoRoot, ".github/workflows/web.yml"), "utf8"));
for (const problem of wiringProblems(webYml)) check(false, problem);

// ── 4. mutations ────────────────────────────────────────────────────────────

let mutations = 0;
{
  // A classifier that ignores LIGHT_SERVER_INPUTS: a handlers.go-only change
  // would skip router.test.ts.
  mutations += 1;
  const broken = (paths) => ({ light: paths.some((p) => !p.startsWith("server/")), server: paths.length > 0 && !paths.every((p) => p.startsWith("docs/")) });
  check(judge(ROWS, broken).some((p) => p.includes("server/account/handlers.go")),
    "a classifier that ignores the light server inputs was not caught by the rows");
  // The document scan bypassed (an empty cited set): the plan_enforce.go row
  // must catch it — that is the hole a hand-kept list left open.
  mutations += 1;
  check(judge(ROWS, (paths) => classify(paths, { billingDocInputs: new Set() }))
    .some((p) => p.includes("server/account/plan_enforce.go")),
    "bypassing the billing-document scan was not caught by the rows");
  // An unreadable document must fail closed, never read as "cites nothing".
  mutations += 1;
  {
    let threw = null;
    try { billingDocServerInputs({ root: "/nonexistent-relayium-root" }); } catch (err) { threw = err; }
    check(threw !== null && threw.message.includes(BILLING_DOC), `an unreadable ${BILLING_DOC} did not throw: ${threw}`);
    const env = { WEB_SCOPE_EVENT: "push", WEB_SCOPE_BEFORE: SHA, WEB_SCOPE_HEAD: OTHER };
    const got = JSON.stringify(silent(() => decide(env, {
      changedPaths: () => ["server/internal/xfer/endpoint.go"],
      docRoot: "/nonexistent-relayium-root",
    })));
    check(got === ALL, `an unreadable billing document did not fail closed in decide(): ${got}`);
  }
  // A classifier that always runs everything: the server-only row must catch it.
  mutations += 1;
  check(judge(ROWS, () => ({ light: true, server: true })).some((p) => p.includes("endpoint.go")),
    "a classifier that never saves anything was not caught by the rows");
  // A removed gate on a light job, and a gate or dependency on a Go-running job.
  for (const [name, from, to, expect] of [
    ["the test job's gate removed", "    needs: scope\n    if: needs.scope.outputs.light != 'false'\n    runs-on: ubuntu-latest\n    timeout-minutes: 15",
      "    needs: scope\n    runs-on: ubuntu-latest\n    timeout-minutes: 15", /web\.yml\/test: `if: \(none\)`/],
    ["mixed-link-e2e gated on server", "  mixed-link-e2e:\n    runs-on: ubuntu-latest",
      "  mixed-link-e2e:\n    needs: scope\n    if: needs.scope.outputs.server != 'false'\n    runs-on: ubuntu-latest",
      /web\.yml\/mixed-link-e2e: `if: needs\.scope\.outputs\.server != 'false'` on a Go-running job/],
    ["sealed-box-interop made to wait on scope", "  sealed-box-interop:\n    runs-on: ubuntu-latest",
      "  sealed-box-interop:\n    needs: scope\n    runs-on: ubuntu-latest",
      /web\.yml\/sealed-box-interop: `needs: scope` ties a Go-running job/],
  ]) {
    mutations += 1;
    if (!webYml.includes(from)) { check(false, `mutation "${name}" no longer applies`); continue; }
    check(wiringProblems(webYml.replace(from, to)).some((p) => expect.test(p)), `mutation "${name}" was not reported`);
  }
}

check(LIGHT_SERVER_INPUTS.length > 0, "LIGHT_SERVER_INPUTS is empty");

if (failures.length > 0) {
  console.error(`web-lane-scope-test: ${failures.length} failure(s)`);
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}
console.log(`web-lane-scope-test: OK (${ROWS.length} change-set rows, 7 fail-closed cases, `
  + `${webJobs(webYml).size - 1 - SERVER_JOBS.length} light web.yml jobs gated on scope, ${SERVER_JOBS.length} `
  + `Go-running jobs ungated, ${mutations} mutations each reported)`);
