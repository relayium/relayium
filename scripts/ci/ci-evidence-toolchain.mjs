#!/usr/bin/env node
// scripts/ci/ci-evidence-toolchain.mjs — the toolchain certificate a witnessed
// check is compared on.
//
// ## Why a tree is not a toolchain
//
// PR→main evidence reuse (scripts/ci/ci-evidence.mjs) proves the main commit's
// whole tree equals the tree a pull request's full run tested. The tree pins
// recipes: workflow text, `go.mod`, lockfiles, the in-tree Xcode selection. It
// does NOT pin what those recipes resolve to on the runner they got:
//
//   * Xcode: macOS jobs use the image's default Xcode, and the iOS lanes select
//     the highest installed 26.x — both decided by the IMAGE's inventory;
//   * floating setup resolutions: `setup-node` `node-version: 24` takes the
//     newest 24.x, `setup-java` `'17'` the newest 17.0.x;
//   * image tools: the C compiler `go test -race` builds cgo with, the Chrome
//     binary the browser harness resolves, the simulator a job's own selection
//     rule picks, `git`, `jq`.
//
// So a witness is allowed only when the toolchain the SOURCE job actually ran on
// equals the toolchain a fresh run would get NOW. This file defines that
// toolchain as data and nothing else: a fixed set of profiles, each a list of
// components, each component a bounded set of argv commands (no shell, no
// eval, no network) whose outputs are parsed by anchored patterns into a
// normalized object. Anything unexpected — a missing tool where one is required,
// output in an unknown shape, a timeout — is UNKNOWN, and an unknown certificate
// never matches anything: the lane runs in full.
//
// ## Two captures, one comparison
//
//   capture (source)   the LAST step of every reusable job's full path, after
//                      every tool that job uses has been set up, selected,
//                      installed or downloaded; uploaded as an attempt-scoped
//                      artifact whose API digest the verifier checks.
//   capture (current)  on the main push, before any witness is decided, on the
//                      runner family the job would run on now — inside the
//                      lane's `evidence` job for Ubuntu profiles (after the same
//                      setup actions), in a short `certify` job for macOS and
//                      Windows profiles.
//
// `toolchain` (what is compared) contains only facts BOTH captures can observe
// identically; `binding` ties a certificate to one job execution; `audit` keeps
// facts that are derived and only recorded (the DEVELOPER_DIR a selection
// produced, which is a function of the compared Xcode inventory and the tree).
//
// Dependency-free; Node 18+ (it runs on whatever Node the runner image has when
// a job sets none up).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TOOLCHAIN_SCHEMA = "relayium.ci-evidence.toolchain/v1";
export const TOOLCHAIN_REGISTRY_FILE = "scripts/ci/ci-evidence-toolchain-registry.json";
export const TOOLCHAIN_REGISTRY_SCHEMA = "relayium.ci-evidence.toolchain-registry/v1";

export const PROBE_LIMITS = Object.freeze({
  commandMs: 30_000,
  totalMs: 150_000,
  outputBytes: 64 * 1024,
  xcodes: 12,
  runtimes: 64,
  certificateBytes: 64 * 1024,
  binaryBytes: 1024 * 1024 * 1024,
  listingBytes: 4 * 1024 * 1024,
  devices: 2000,
});

/** Any doubt about a toolchain fact. The certificate is then unusable. */
export class ToolchainUnknown extends Error {}

const unknown = (message) => { throw new ToolchainUnknown(message); };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** JSON with sorted keys at every level — the only form that is hashed or compared. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── the probe context ───────────────────────────────────────────────────────

/**
 * Runs argv (never a shell) with a per-command and an overall time bound.
 * Returns `{ status, stdout, stderr }`; a timeout or spawn error is unknown.
 */
export function realExec(budget = { left: PROBE_LIMITS.totalMs }) {
  return (argv, env = {}, input = undefined) => {
    if (budget.left <= 0) unknown("the probe ran out of its time budget");
    const started = Date.now();
    const r = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: Math.min(PROBE_LIMITS.commandMs, budget.left),
      maxBuffer: argv[0] === "xcrun" ? PROBE_LIMITS.listingBytes : PROBE_LIMITS.outputBytes,
      env: { ...process.env, ...env },
      ...(input === undefined ? {} : { input }),
    });
    budget.left -= Date.now() - started;
    if (r.error?.code === "ENOENT") return { status: 127, stdout: "", stderr: "" };
    if (r.error) unknown(`${argv[0]} could not run: ${r.error.code ?? r.error.message}`);
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

function run(ctx, argv, env, input) {
  const r = ctx.exec(argv, env, input);
  if (r.status !== 0) unknown(`${argv.join(" ")} exited ${r.status}`);
  return `${r.stdout}`;
}

const firstLine = (text) => String(text).split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";

function match(text, pattern, what) {
  const m = pattern.exec(text);
  if (!m) unknown(`${what} is not in a recognised shape: ${JSON.stringify(String(text).slice(0, 160))}`);
  return m;
}

// ── components ──────────────────────────────────────────────────────────────

/**
 * ImageOS, as capture reads it AND as the schema accepts it — one grammar, so
 * the two cannot drift apart. The family+release shape (ubuntu24, macos15,
 * win25) plus, as one complete literal, the Windows Server 2025 image that
 * ships Visual Studio 2026 (`windows-latest` reports `win25-vs2026`). Any other
 * suffix or VS generation is an image this probe has never seen, so unknown.
 * No `m` flag: `$` is the end of the whole value, never a line end.
 */
const IMAGE_OS = /^(?:[a-z]+[0-9]+|win25-vs2026)$/;

/** Runner image and OS identity. ImageVersion is what makes image tools (gcc, git, jq) comparable. */
function image(ctx) {
  const env = ctx.env;
  const out = {
    runner_os: match(env.RUNNER_OS ?? "", /^(Linux|macOS|Windows)$/, "RUNNER_OS")[1],
    runner_arch: match(env.RUNNER_ARCH ?? "", /^(X64|ARM64|X86|ARM)$/, "RUNNER_ARCH")[1],
    image_os: match(env.ImageOS ?? "", IMAGE_OS, "ImageOS")[0],
    image_version: match(env.ImageVersion ?? "", /^[0-9]{8}\.[0-9]+(\.[0-9]+)?$/, "ImageVersion")[0],
  };
  if (out.runner_os === "Linux") {
    const rel = ctx.readFile("/etc/os-release");
    const id = match(rel, /^ID=("?)([a-z0-9._-]+)\1$/m, "/etc/os-release ID")[2];
    const ver = match(rel, /^VERSION_ID=("?)([0-9.]+)\1$/m, "/etc/os-release VERSION_ID")[2];
    out.os_release = `${id} ${ver}`;
  } else if (out.runner_os === "macOS") {
    const v = match(run(ctx, ["sw_vers", "-productVersion"]).trim(), /^[0-9]+(\.[0-9]+){1,2}$/, "sw_vers -productVersion")[0];
    const b = match(run(ctx, ["sw_vers", "-buildVersion"]).trim(), /^[0-9A-Za-z]+$/, "sw_vers -buildVersion")[0];
    out.os_release = `macOS ${v} (${b})`;
  } else {
    out.os_release = match(run(ctx, ["cmd", "/d", "/c", "ver"]), /Version ([0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?)/, "ver")[1];
  }
  return out;
}

/**
 * Go, as setup-go left it, and the C compiler cgo (and so `-race`) builds with:
 * the CC command, the binary it resolves to (real path), its version line and
 * the TARGET it actually compiles for, as the compiler itself reports it
 * (`-dumpmachine`, which GCC — MinGW included — and clang both answer). GOARCH
 * is never taken for the compiler's target: an x86_64 and an aarch64 GCC of one
 * version print the same version line. A CC that is set but cannot be resolved,
 * run or asked its target is unknown; an absent CC (nothing on PATH) is
 * recorded as absent on every field, which compares unequal to any compiler.
 */
function go(ctx) {
  const ver = match(firstLine(run(ctx, ["go", "version"])), /^go version (go[0-9]+\.[0-9]+(\.[0-9]+)?(rc[0-9]+)?) ([a-z0-9]+)\/([a-z0-9]+)$/, "go version");
  const lines = run(ctx, ["go", "env", "CGO_ENABLED", "CC"]).split(/\r?\n/);
  const cgo = match((lines[0] ?? "").trim(), /^[01]$/, "go env CGO_ENABLED")[0];
  const cc = (lines[1] ?? "").trim();
  const absent = { version: ver[1], goos: ver[4], goarch: ver[5], cgo_enabled: cgo, cc: "absent", cc_path: "absent", cc_version: "absent", cc_target: "absent" };
  if (cc === "") return absent;
  const bin = cc.split(/\s+/)[0];
  const probe = ctx.exec([bin, "--version"]);
  if (probe.status === 127) return { ...absent, cc };
  if (probe.status !== 0) unknown(`${cc} --version exited ${probe.status}`);
  const ccVersion = match(firstLine(probe.stdout), /^.*\b[0-9]+\.[0-9]+(\.[0-9]+)?.*$/, `${cc} --version`)[0];
  const path = ctx.realpath(/[\\/]/.test(bin) ? bin : ctx.which(bin));
  const target = match(firstLine(run(ctx, [bin, ...cc.split(/\s+/).slice(1), "-dumpmachine"])),
    /^[A-Za-z0-9_]+(-[A-Za-z0-9_.]+){1,4}$/, `${cc} -dumpmachine`)[0];
  return { version: ver[1], goos: ver[4], goarch: ver[5], cgo_enabled: cgo, cc, cc_path: path, cc_version: ccVersion, cc_target: target };
}

/**
 * Node and npm, as setup-node (or the image) left them. On Windows npm is the
 * batch file npm.cmd, which Node refuses to spawn without a shell (EINVAL, see
 * "Spawning .bat and .cmd files on Windows" in the child_process docs), so it
 * goes through cmd.exe as one fixed argv: /d skips AutoRun, every token is a
 * literal, and npm.cmd is still resolved on the job's own PATH.
 */
function node(ctx) {
  const npm = ctx.env.RUNNER_OS === "Windows" ? ["cmd", "/d", "/c", "npm.cmd", "--version"] : ["npm", "--version"];
  return {
    version: match(firstLine(run(ctx, ["node", "--version"])), /^v[0-9]+\.[0-9]+\.[0-9]+$/, "node --version")[0],
    npm: match(firstLine(run(ctx, npm)), /^[0-9]+\.[0-9]+\.[0-9]+$/, "npm --version")[0],
  };
}

/** The JDK setup-java selected (`java -version` reports on stderr). */
function java(ctx) {
  const r = ctx.exec(["java", "-version"]);
  if (r.status !== 0) unknown(`java -version exited ${r.status}`);
  const text = `${r.stderr}${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const v = match(text[0] ?? "", /^(openjdk|java) version "([0-9][0-9._+a-z-]*)"/, "java -version");
  const runtime = match(text[1] ?? "", /^.*Runtime Environment .*\(build ([0-9][0-9._+a-z-]*)\)$/i, "java -version runtime");
  return { version: v[2], build: runtime[1] };
}

/**
 * The revisions of exactly the Android SDK packages a profile names, read from
 * each package's `source.properties` under ANDROID_HOME. Installed-by-the-job
 * packages float, so the current capture must install the same set first.
 */
function androidSdk(ctx, params) {
  const home = ctx.env.ANDROID_HOME ?? "";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(home)) unknown("ANDROID_HOME is not set to an absolute path");
  const out = {};
  for (const pkg of params.packages) {
    const rel = match(pkg, /^(platforms|build-tools);([A-Za-z0-9._-]+)$/, "an Android package id");
    const props = ctx.readFile(join(home, rel[1], rel[2], "source.properties"));
    out[pkg] = match(props, /^Pkg\.Revision=([0-9][0-9.]*(\s?rc[0-9]+)?)\s*$/m, `${pkg} Pkg.Revision`)[1];
  }
  return out;
}

/**
 * The Chrome the browser suites ACTUALLY launch: resolved by the harness's own
 * `resolveChrome` (web/e2e/harness.mjs — the very function, so `CHROME_PATH`
 * first and then its per-platform candidate order, never a copy of that rule),
 * then that binary's real path, sha256 and `--version`. A harness that resolves
 * nothing, an unreadable binary or an unknown version string is unknown.
 */
function chrome(ctx) {
  if (typeof ctx.resolveChrome !== "function") unknown("the browser harness's Chrome resolver is unavailable");
  let path;
  try { path = ctx.resolveChrome(); } catch (err) { unknown(`the browser harness resolves no Chrome: ${String(err?.message ?? err).split("\n")[0]}`); }
  if (typeof path !== "string" || !path.startsWith("/")) unknown(`the browser harness resolved ${JSON.stringify(path)}`);
  const real = ctx.realpath(path);
  const v = match(firstLine(run(ctx, [path, "--version"])), /^(Google Chrome|Chromium) ([0-9]+(\.[0-9]+){3})\b/, `${path} --version`);
  return {
    pinned: typeof ctx.env.CHROME_PATH === "string" && ctx.env.CHROME_PATH !== "",
    path,
    real_path: real,
    sha256: ctx.digestFile(real),
    version: `${v[1]} ${v[2]}`,
  };
}

/**
 * Every installed Xcode (version, build, both SDKs) and the image's default
 * selection. Every Xcode a job may select — the default, or the highest 26.x the
 * iOS selection picks — is a function of this inventory and the tree.
 */
function xcode(ctx) {
  const apps = ctx.listDir("/Applications").filter((n) => /^Xcode[A-Za-z0-9_.-]*\.app$/.test(n)).sort();
  const seen = new Map();
  for (const app of apps) {
    const real = ctx.realpath(join("/Applications", app));
    if (seen.has(real)) continue;
    if (seen.size >= PROBE_LIMITS.xcodes) unknown(`more than ${PROBE_LIMITS.xcodes} Xcodes installed`);
    const dev = join(real, "Contents/Developer");
    const text = run(ctx, [join(dev, "usr/bin/xcodebuild"), "-version"], { DEVELOPER_DIR: dev });
    const v = match(text, /^Xcode ([0-9]+(\.[0-9]+){0,2})\s*\nBuild version ([0-9A-Za-z]+)\s*$/m, `${app} xcodebuild -version`);
    const sdk = (name) => match(run(ctx, ["xcrun", "--sdk", name, "--show-sdk-version"], { DEVELOPER_DIR: dev }).trim(),
      /^[0-9]+(\.[0-9]+){1,2}$/, `${app} ${name} SDK`)[0];
    seen.set(real, { app: real, version: v[1], build: v[3], macosx_sdk: sdk("macosx"), iphonesimulator_sdk: sdk("iphonesimulator") });
  }
  if (seen.size === 0) unknown("no Xcode is installed");
  const byDefault = run(ctx, ["xcode-select", "-p"], { DEVELOPER_DIR: "" }).trim();
  match(byDefault, /^\/[A-Za-z0-9 _./-]+$/, "xcode-select -p");
  // The Xcode this job USED: the lane's own selection exports DEVELOPER_DIR
  // (the iOS lanes), every other job uses the image default. Never re-derived
  // here — a certificate describes the context it ran in.
  const used = ctx.env.DEVELOPER_DIR ? ctx.env.DEVELOPER_DIR : byDefault;
  match(used, /^\/[A-Za-z0-9 _./-]+$/, "the used DEVELOPER_DIR");
  const usedReal = ctx.realpath(used.replace(/\/Contents\/Developer\/?$/, ""));
  const hit = seen.get(usedReal);
  if (!hit) unknown(`the Xcode in use (${used}) is not one of the installed Xcodes`);
  return {
    installed: [...seen.values()].sort((a, b) => (a.app < b.app ? -1 : 1)),
    default_developer_dir: byDefault,
    used: { app: hit.app, version: hit.version, build: hit.build },
  };
}

/**
 * A job's selection program: the `python3 -c '…'` that turns
 * `xcrun simctl list devices available -j` into a device, taken verbatim from
 * where the job runs it (a workflow step, or a script the job calls). Lines are
 * dedented by the first program line's indentation, exactly as YAML's block
 * scalar (or the script itself) hands them to the shell. Exactly one such
 * program, or unknown.
 */
export function selectionProgram(text, where) {
  const lines = String(text).split("\n");
  let from = 0;
  let to = lines.length;
  if (where.step !== undefined) {
    const at = lines.findIndex((l) => l.trim() === `- name: ${where.step}`);
    if (at === -1 || lines.findIndex((l, i) => i > at && l.trim() === `- name: ${where.step}`) !== -1) {
      unknown(`${where.file} does not name the step ${JSON.stringify(where.step)} exactly once`);
    }
    const indent = lines[at].length - lines[at].trimStart().length;
    from = at + 1;
    const next = lines.findIndex((l, i) => i >= from && l.trim() !== "" && (l.length - l.trimStart().length) <= indent && !l.trim().startsWith("#"));
    to = next === -1 ? lines.length : next;
  }
  const opens = [];
  for (let i = from; i < to; i += 1) {
    const m = /\| (\/usr\/bin\/python3|python3) -c '(import json, sys)$/.exec(lines[i]);
    if (m) opens.push({ i, interpreter: m[1], first: m[2] });
  }
  if (opens.length !== 1) unknown(`${where.file}${where.step ? ` (${where.step})` : ""} runs ${opens.length} selection programs, want 1`);
  const { i, interpreter, first } = opens[0];
  const body = [];
  let base = null;
  for (let k = i + 1; k < to; k += 1) {
    const line = lines[k];
    if (base === null) base = line.length - line.trimStart().length;
    if (line.trim() !== "" && !line.startsWith(" ".repeat(base))) unknown("the selection program is not uniformly indented");
    const close = line.indexOf("'");
    if (close !== -1) {
      body.push(line.slice(base, close));
      if (!/^\)"?\s*$/.test(line.slice(close + 1))) unknown("the selection program does not close where it is read");
      return { interpreter, program: [first, ...body].join("\n") };
    }
    body.push(line.slice(base));
  }
  return unknown("the selection program never closes");
}

/**
 * The simulator destination a job's OWN selection rule picks on this runner now:
 * the job's program, pinned by sha256 in the registry, run by the same
 * interpreter on the same `simctl` listing, and the device it prints resolved to
 * what the destination IS — name, device type, runtime (version and build) —
 * plus its position in the listing, the order fact a first-match rule decides
 * on. The UDID is NOT compared: it is an identifier minted per device set, so
 * comparing it across runners would compare nothing about the destination; it
 * is kept in the certificate's audit block. A program that changed without its
 * pin, prints nothing, or picks an unknown device is unknown — never "close
 * enough".
 */
function destination(ctx, params) {
  const d = params.destination;
  if (!isObject(d)) unknown("the profile names no destination rule");
  const { interpreter, program } = selectionProgram(ctx.readFile(resolve(ctx.repoRoot, d.file)), d);
  const programSha = sha256(`${interpreter}\0${program}`);
  if (programSha !== d.sha256) unknown(`the ${d.id} selection program is not the one the registry pins (${programSha})`);
  const listing = run(ctx, ["xcrun", "simctl", "list", "devices", "available", "-j"]);
  let devices;
  let runtimes;
  try {
    devices = JSON.parse(listing).devices;
    runtimes = JSON.parse(run(ctx, ["xcrun", "simctl", "list", "runtimes", "-j"])).runtimes;
  } catch (err) {
    if (err instanceof ToolchainUnknown) throw err;
    unknown(`simctl did not return JSON: ${err.message}`);
  }
  if (!isObject(devices) || !Array.isArray(runtimes) || runtimes.length > PROBE_LIMITS.runtimes) unknown("simctl listings are malformed");
  const flat = [];
  for (const [runtime, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) unknown("a simctl device list is not an array");
    for (const dev of list) flat.push({ runtime, dev });
  }
  if (flat.length > PROBE_LIMITS.devices) unknown("the simctl device listing is above its cap");
  const exe = interpreter.startsWith("/") ? interpreter : ctx.which(interpreter);
  const printed = firstLine(run(ctx, [exe, "-c", program], {}, listing));
  const udid = match(printed.split(/\s+/)[0] ?? "", /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/, `the ${d.id} selection`)[0];
  const hits = flat.map((x, position) => ({ ...x, position })).filter((x) => isObject(x.dev) && x.dev.udid === udid);
  if (hits.length !== 1) unknown(`the ${d.id} selection printed ${udid}, which the listing has ${hits.length} times`);
  const { runtime, dev, position } = hits[0];
  const rt = runtimes.filter((r) => isObject(r) && r.identifier === runtime);
  if (rt.length !== 1 || typeof rt[0].version !== "string" || typeof rt[0].buildversion !== "string") {
    unknown(`the selected device's runtime ${runtime} is not exactly one installed runtime`);
  }
  if (typeof dev.name !== "string" || typeof dev.deviceTypeIdentifier !== "string" || dev.isAvailable !== true) {
    unknown("the selected device is malformed or unavailable");
  }
  ctx.audit.simulator_udid = udid;
  return {
    rule: d.id,
    program_sha256: programSha,
    interpreter: { path: ctx.realpath(exe), version: match(firstLine(run(ctx, [exe, "--version"])), /^Python [0-9]+\.[0-9]+\.[0-9]+$/, `${exe} --version`)[0] },
    selected: {
      name: dev.name, device_type: dev.deviceTypeIdentifier, listing_position: position,
      runtime, runtime_version: rt[0].version, runtime_build: rt[0].buildversion,
    },
  };
}

export const COMPONENTS = Object.freeze({ image, go, node, java, "android-sdk": androidSdk, chrome, xcode, destination });

// ── the registry ────────────────────────────────────────────────────────────

/** The toolchain registry, read and checked; anything unexpected is unknown. */
export function loadToolchainRegistry(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { unknown(`the toolchain registry is not JSON: ${err.message}`); }
  if (!isObject(doc) || doc.schema !== TOOLCHAIN_REGISTRY_SCHEMA) unknown("the toolchain registry schema is wrong");
  if (!isObject(doc.profiles) || !isObject(doc.lanes)) unknown("the toolchain registry has no profiles or lanes");
  for (const [name, profile] of Object.entries(doc.profiles)) {
    if (!/^(linux|macos|windows)-[a-z0-9-]+$/.test(name)) unknown(`profile ${name} has an unusable name`);
    if (!isObject(profile) || !["ubuntu-latest", "macos-15", "windows-latest"].includes(profile.runner)) unknown(`profile ${name} has no runner`);
    const os = { "ubuntu-latest": "linux", "macos-15": "macos", "windows-latest": "windows" }[profile.runner];
    if (!name.startsWith(`${os}-`)) unknown(`profile ${name} runs on ${profile.runner}`);
    if (!Array.isArray(profile.components) || profile.components[0] !== "image"
      || new Set(profile.components).size !== profile.components.length
      || !profile.components.every((c) => Object.hasOwn(COMPONENTS, c))) unknown(`profile ${name} has malformed components`);
    if (profile.components.includes("android-sdk") !== (Array.isArray(profile.androidPackages) && profile.androidPackages.length > 0)) {
      unknown(`profile ${name} names android-sdk without packages, or packages without android-sdk`);
    }
    if (profile.runner !== "macos-15" && (profile.components.includes("xcode") || profile.components.includes("destination"))) {
      unknown(`profile ${name} probes Xcode off macOS`);
    }
    if (profile.components.includes("destination") !== (typeof profile.destination === "string")
      || (profile.destination !== undefined && !isObject(doc.destinations?.[profile.destination]))) {
      unknown(`profile ${name} names a destination without the component, the component without one, or an unknown one`);
    }
    const extraKeys = Object.keys(profile).filter((k) => !["runner", "components", "androidPackages", "destination"].includes(k));
    if (extraKeys.length) unknown(`profile ${name} has unknown keys ${extraKeys.join(", ")}`);
  }
  if (doc.destinations !== undefined && !isObject(doc.destinations)) unknown("the toolchain registry's destinations are malformed");
  for (const [id, d] of Object.entries(doc.destinations ?? {})) {
    const keys = Object.keys(d ?? {}).sort().join();
    if (!/^[a-z0-9-]+$/.test(id) || !isObject(d) || !(keys === "file,sha256" || keys === "file,sha256,step")
      || typeof d.file !== "string" || !/^[A-Za-z0-9_./-]+$/.test(d.file) || d.file.includes("..")
      || !/^[0-9a-f]{64}$/.test(d.sha256 ?? "") || (d.step !== undefined && !(typeof d.step === "string" && d.step.length > 0))) {
      unknown(`destination ${id} is malformed`);
    }
  }
  const stepRef = (x) => isObject(x) && Object.keys(x).sort().join() === "job,step" && /^[a-z0-9-]+$/.test(x.job)
    && typeof x.step === "string" && x.step.length > 0 && x.step.length <= 200;
  for (const [laneId, lane] of Object.entries(doc.lanes)) {
    if (!isObject(lane) || !isObject(lane.jobs)) unknown(`toolchain lane ${laneId} has no jobs`);
    const extra = Object.keys(lane).filter((k) => !["jobs", "ubuntuSetup", "certify"].includes(k));
    if (extra.length) unknown(`toolchain lane ${laneId} has unknown keys ${extra.join(", ")}`);
    if (lane.ubuntuSetup !== undefined && !(Array.isArray(lane.ubuntuSetup) && lane.ubuntuSetup.every(stepRef))) {
      unknown(`toolchain lane ${laneId} has a malformed ubuntuSetup`);
    }
    if (lane.certify !== undefined && !(isObject(lane.certify) && Object.entries(lane.certify).every(([r, steps]) =>
      ["macos-15", "windows-latest"].includes(r) && Array.isArray(steps) && steps.every(stepRef)))) {
      unknown(`toolchain lane ${laneId} has a malformed certify block`);
    }
    // Every family the lane's jobs need is probed, and nothing else is.
    const families = new Set(Object.values(lane.jobs).filter((j) => j.profile).map((j) => doc.profiles[j.profile]?.runner));
    for (const runner of ["macos-15", "windows-latest"]) {
      if (families.has(runner) !== (lane.certify?.[runner] !== undefined)) {
        unknown(`toolchain lane ${laneId} ${families.has(runner) ? "needs" : "must not have"} a ${runner} certify job`);
      }
    }
    if (!families.has("ubuntu-latest") && (lane.ubuntuSetup ?? []).length > 0) unknown(`toolchain lane ${laneId} sets up Ubuntu it never probes`);
    for (const [jobId, job] of Object.entries(lane.jobs)) {
      const ok = isObject(job) && ((typeof job.profile === "string" && doc.profiles[job.profile] !== undefined && job.uncertifiable === undefined)
        || (job.profile === undefined && typeof job.uncertifiable === "string" && job.uncertifiable.length > 10));
      if (!ok) unknown(`toolchain job ${laneId}/${jobId} names neither a known profile nor an uncertifiable reason`);
    }
  }
  return doc;
}

export const readToolchainRegistry = () => loadToolchainRegistry(readFileSync(resolve(repoRoot, TOOLCHAIN_REGISTRY_FILE), "utf8"));

// ── capture ─────────────────────────────────────────────────────────────────

const intOf = (v, what) => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(v)) unknown(`${what} is ${JSON.stringify(v ?? null)}`);
  return Number(v);
};

/**
 * The certificate for one profile on this runner. `role` is `source` (a lane
 * job's own execution) or `current` (a probe on the main push).
 */
export function capture({
  registry, profileName, role, laneId, jobId, env, exec, readFile, exists, listDir, realpath, now,
  resolveChrome, digestFile = fileDigest, root = repoRoot,
}) {
  const profile = registry.profiles[profileName];
  if (!profile) unknown(`profile ${profileName} is not in the toolchain registry`);
  if (role !== "source" && role !== "current") unknown(`role ${role} is neither source nor current`);
  const ctx = {
    env, exec, resolveChrome, repoRoot: root, audit: { simulator_udid: "" },
    readFile: (p) => { try { return readFile(p); } catch { return unknown(`${p} is unreadable`); } },
    exists, listDir: (p) => { try { return listDir(p); } catch { return unknown(`${p} is unlistable`); } },
    realpath: (p) => { try { return realpath(p); } catch { return unknown(`${p} does not resolve`); } },
    digestFile: (p) => {
      let bytes;
      try { bytes = digestFile(p); } catch { return unknown(`${p} is unreadable`); }
      return typeof bytes === "string" && /^[0-9a-f]{64}$/.test(bytes) ? bytes : unknown(`${p} has no digest`);
    },
    // PATH lookup the way a shell would do it for `python3`: the first entry
    // whose file exists, by real path. Unknown when there is none.
    which: (name) => {
      const names = env.RUNNER_OS === "Windows" ? [`${name}.exe`, name] : [name];
      for (const dir of String(env.PATH ?? "").split(env.RUNNER_OS === "Windows" ? ";" : delimiter)) {
        for (const n of names) if (dir !== "" && exists(join(dir, n))) return join(dir, n);
      }
      return unknown(`${name} is not on PATH`);
    },
  };
  const expectedOs = { "ubuntu-latest": "Linux", "macos-15": "macOS", "windows-latest": "Windows" }[profile.runner];
  if (env.RUNNER_OS !== expectedOs) unknown(`profile ${profileName} is for ${expectedOs}, this runner is ${env.RUNNER_OS}`);
  const toolchain = {};
  for (const name of profile.components) {
    toolchain[name] = COMPONENTS[name](ctx, {
      packages: profile.androidPackages,
      destination: profile.destination === undefined ? undefined : { id: profile.destination, ...registry.destinations[profile.destination] },
    });
  }
  const binding = {
    role,
    profile: profileName,
    lane: laneId,
    job: jobId,
    repository_id: intOf(env.GITHUB_REPOSITORY_ID, "GITHUB_REPOSITORY_ID"),
    run_id: intOf(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    run_attempt: intOf(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT"),
    sha: match(env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/, "GITHUB_SHA")[0],
    workflow_ref: match(env.GITHUB_WORKFLOW_REF ?? "", /^[^\s]{1,400}$/, "GITHUB_WORKFLOW_REF")[0],
    github_job: match(env.GITHUB_JOB ?? "", /^[a-z0-9-]{1,60}$/, "GITHUB_JOB")[0],
    job_index: role === "source" ? intOf(env.CI_EVIDENCE_JOB_INDEX, "CI_EVIDENCE_JOB_INDEX") : 0,
    job_total: role === "source" ? intOf(env.CI_EVIDENCE_JOB_TOTAL, "CI_EVIDENCE_JOB_TOTAL") : 1,
  };
  if (binding.job_total < 1 || binding.job_index >= binding.job_total) unknown("the job index is outside the job total");
  const cert = {
    schema: TOOLCHAIN_SCHEMA,
    binding,
    toolchain,
    digest: toolchainDigest(profileName, toolchain),
    audit: {
      captured_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      developer_dir: String(env.DEVELOPER_DIR ?? "").slice(0, 300),
      matrix: String(env.CI_EVIDENCE_MATRIX ?? "").slice(0, 500),
      simulator_udid: ctx.audit.simulator_udid,
    },
  };
  return validateCertificate(cert, registry);
}

/** sha256 of a file's bytes, refusing anything that is not a bounded regular file. */
export function fileDigest(path) {
  const st = statSync(path);
  if (!st.isFile() || st.size > PROBE_LIMITS.binaryBytes) throw new Error(`${path} is not a bounded regular file`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export const toolchainDigest = (profileName, toolchain) => sha256(canonical({ profile: profileName, toolchain }));

// ── validation and comparison ───────────────────────────────────────────────

const str = (re) => (v) => typeof v === "string" && re.test(v);
const nonEmpty = str(/^[^\n]{1,300}$/);
const COMPONENT_SHAPES = {
  image: { runner_os: str(/^(Linux|macOS|Windows)$/), runner_arch: str(/^(X64|ARM64|X86|ARM)$/), image_os: str(IMAGE_OS),
    image_version: str(/^[0-9]{8}\.[0-9]+(\.[0-9]+)?$/), os_release: nonEmpty },
  go: { version: str(/^go[0-9.]+(rc[0-9]+)?$/), goos: str(/^[a-z0-9]+$/), goarch: str(/^[a-z0-9]+$/), cgo_enabled: str(/^[01]$/),
    cc: nonEmpty, cc_path: nonEmpty, cc_version: nonEmpty, cc_target: str(/^(absent|[A-Za-z0-9_]+(-[A-Za-z0-9_.]+){1,4})$/) },
  node: { version: str(/^v[0-9]+\.[0-9]+\.[0-9]+$/), npm: str(/^[0-9]+\.[0-9]+\.[0-9]+$/) },
  java: { version: nonEmpty, build: nonEmpty },
  chrome: { pinned: (v) => typeof v === "boolean", path: str(/^\/[^\n]{1,299}$/), real_path: str(/^\/[^\n]{1,299}$/),
    sha256: str(/^[0-9a-f]{64}$/), version: str(/^(Google Chrome|Chromium) [0-9]+(\.[0-9]+){3}$/) },
};

function shapeOk(value, spec) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  const want = Object.keys(spec).sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i] && spec[k](value[k]));
}

function componentOk(name, value, profile) {
  if (COMPONENT_SHAPES[name]) return shapeOk(value, COMPONENT_SHAPES[name]);
  if (name === "android-sdk") {
    return isObject(value) && Object.keys(value).sort().join() === [...profile.androidPackages].sort().join()
      && Object.values(value).every(str(/^[0-9][0-9.]*(\s?rc[0-9]+)?$/));
  }
  if (name === "xcode") {
    return isObject(value) && Object.keys(value).sort().join() === "default_developer_dir,installed,used"
      && nonEmpty(value.default_developer_dir)
      && shapeOk(value.used, { app: nonEmpty, version: str(/^[0-9]+(\.[0-9]+){0,2}$/), build: str(/^[0-9A-Za-z]+$/) })
      && Array.isArray(value.installed) && value.installed.length > 0
      && value.installed.some((x) => isObject(x) && x.app === value.used.app && x.build === value.used.build)
      && value.installed.length <= PROBE_LIMITS.xcodes && value.installed.every((x) => shapeOk(x, {
        app: nonEmpty, version: str(/^[0-9]+(\.[0-9]+){0,2}$/), build: str(/^[0-9A-Za-z]+$/),
        macosx_sdk: str(/^[0-9]+(\.[0-9]+){1,2}$/), iphonesimulator_sdk: str(/^[0-9]+(\.[0-9]+){1,2}$/),
      }));
  }
  if (name === "destination") {
    return shapeOk(value, { rule: (v) => v === profile.destination, program_sha256: str(/^[0-9a-f]{64}$/),
      interpreter: (v) => shapeOk(v, { path: str(/^\/[^\n]{1,299}$/), version: str(/^Python [0-9]+\.[0-9]+\.[0-9]+$/) }),
      selected: (v) => shapeOk(v, {
        listing_position: (n) => Number.isSafeInteger(n) && n >= 0 && n < PROBE_LIMITS.devices,
        name: nonEmpty, device_type: nonEmpty, runtime: nonEmpty, runtime_version: nonEmpty, runtime_build: nonEmpty,
      }) });
  }
  return false;
}

/** A certificate, structurally and by digest; returns it or throws unknown. */
export function validateCertificate(cert, registry) {
  if (!isObject(cert) || Object.keys(cert).sort().join() !== "audit,binding,digest,schema,toolchain") unknown("a certificate has the wrong keys");
  if (cert.schema !== TOOLCHAIN_SCHEMA) unknown("a certificate has the wrong schema");
  const b = cert.binding;
  const bindingKeys = "github_job,job,job_index,job_total,lane,profile,repository_id,role,run_attempt,run_id,sha,workflow_ref";
  if (!isObject(b) || Object.keys(b).sort().join() !== bindingKeys) unknown("a certificate binding has the wrong keys");
  const profile = registry.profiles[b.profile];
  if (!profile) unknown(`a certificate names the unknown profile ${JSON.stringify(b.profile)}`);
  if (!["source", "current"].includes(b.role) || !nonEmpty(b.lane) || !nonEmpty(b.job) || !str(/^[0-9a-f]{40}$/)(b.sha)
    || ![b.repository_id, b.run_id, b.run_attempt].every((n) => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(b.job_index) || !Number.isSafeInteger(b.job_total) || b.job_index < 0 || b.job_index >= b.job_total
    || !nonEmpty(b.workflow_ref) || !str(/^[a-z0-9-]{1,60}$/)(b.github_job)) unknown("a certificate binding is malformed");
  const t = cert.toolchain;
  if (!isObject(t) || Object.keys(t).join() !== profile.components.join()) unknown(`a ${b.profile} certificate does not carry exactly its components`);
  for (const name of profile.components) {
    if (!componentOk(name, t[name], profile)) unknown(`a ${b.profile} certificate's ${name} component is malformed`);
  }
  if (cert.digest !== toolchainDigest(b.profile, t)) unknown("a certificate's digest does not match its toolchain");
  const a = cert.audit;
  if (!isObject(a) || Object.keys(a).sort().join() !== "captured_at,developer_dir,matrix,simulator_udid"
    || !str(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)(a.captured_at) || typeof a.developer_dir !== "string"
    || typeof a.matrix !== "string" || !str(/^([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})?$/)(a.simulator_udid)) {
    unknown("a certificate's audit block is malformed");
  }
  if (Buffer.byteLength(JSON.stringify(cert)) > PROBE_LIMITS.certificateBytes) unknown("a certificate is above its size cap");
  return cert;
}

/** The differing compared facts, as `component.field` paths; empty when equal. */
export function toolchainDifferences(source, current) {
  const out = [];
  const walk = (a, b, path) => {
    if (canonical(a) === canonical(b)) return;
    if (isObject(a) && isObject(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    out.push(path);
  };
  walk(source.toolchain, current.toolchain, "");
  return out;
}

// ── the command ─────────────────────────────────────────────────────────────

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i] ?? "") || argv[i + 1] === undefined) return null;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** The certificates in `dir` (`<profile>.json`), validated; anything else is skipped. */
export function readCertificates(dir, registry, readDir = readdirSync, readFile = (f) => readFileSync(f, "utf8")) {
  const out = {};
  let names = [];
  try { names = readDir(dir); } catch { return out; }
  for (const name of names.sort()) {
    const m = /^([a-z0-9-]+)\.json$/.exec(name);
    if (!m || !registry.profiles[m[1]]) continue;
    try {
      const text = readFile(join(dir, name));
      if (text.length > PROBE_LIMITS.certificateBytes) continue;
      const cert = validateCertificate(JSON.parse(text), registry);
      if (cert.binding.profile === m[1] && cert.binding.role === "current") out[m[1]] = cert;
    } catch { /* skipped: a missing current certificate means a full run */ }
  }
  return out;
}

export function main(argv, env = process.env, deps = {}) {
  const [command, ...rest] = argv;
  const a = args(rest);
  // `current --profiles p,q --dir D`: the current probe on a main push; one
  // certificate per profile, each independent (an unknown in one does not stop
  // the others), each absent rather than partial when unknown.
  // `export --dir D`: those certificates as ONE `certificates=<json>` line for
  // $GITHUB_OUTPUT (a certify job's output). `import --dir D`: the inverse in
  // the evidence job, from every CI_EVIDENCE_CERTIFICATES_* variable.
  if (command === "current" || command === "export" || command === "import") {
    if (!a || !a.dir || (command === "current" ? !a.profiles : a.profiles !== undefined)) {
      process.stderr.write("usage: ci-evidence-toolchain.mjs current --profiles P[,Q] --dir D | export --dir D | import --dir D\n");
      return 2;
    }
    let registry;
    try { registry = deps.registry ?? readToolchainRegistry(); } catch (err) {
      process.stderr.write(`::warning::ci-evidence-toolchain: ${err.message}\n`);
      return command === "export" ? (process.stdout.write("certificates={}\n"), 0) : 0;
    }
    mkdirSync(a.dir, { recursive: true });
    if (command === "current") {
      for (const profile of a.profiles.split(",")) {
        if (!/^[a-z0-9-]+$/.test(profile)) { process.stderr.write(`usage: unusable profile ${JSON.stringify(profile)}\n`); return 2; }
        main(["capture", "--role", "current", "--profile", profile, "--out", join(a.dir, `${profile}.json`)], env, { ...deps, registry });
      }
      return 0;
    }
    if (command === "export") {
      const certs = readCertificates(a.dir, registry, deps.readDir, deps.readText);
      const line = JSON.stringify(certs);
      process.stdout.write(`certificates=${line.length > 900 * 1024 ? "{}" : line}\n`);
      return 0;
    }
    for (const [key, value] of Object.entries(env)) {
      if (!/^CI_EVIDENCE_CERTIFICATES_[A-Z0-9_]+$/.test(key) || typeof value !== "string" || value === "") continue;
      let map;
      try { map = JSON.parse(value); } catch { process.stderr.write(`::warning::${key} is not JSON\n`); continue; }
      if (!isObject(map)) continue;
      for (const [profile, cert] of Object.entries(map)) {
        try {
          if (!registry.profiles[profile]) continue;
          const ok = validateCertificate(cert, registry);
          if (ok.binding.profile !== profile || ok.binding.role !== "current") continue;
          writeFileSync(join(a.dir, `${profile}.json`), JSON.stringify(ok));
        } catch (err) { process.stderr.write(`::warning::${key} ${profile}: ${err.message}\n`); }
      }
    }
    return 0;
  }
  if (command !== "capture" || !a || !["source", "current"].includes(a.role) || !a.profile || !a.out
    || (a.role === "source" && (!a.lane || !a.job))) {
    process.stderr.write("usage: ci-evidence-toolchain.mjs capture --role source|current --profile P --out FILE "
      + "[--lane L --job J]\n");
    return 2;
  }
  try {
    const registry = deps.registry ?? readToolchainRegistry();
    const cert = capture({
      registry, profileName: a.profile, role: a.role, laneId: a.lane ?? "-", jobId: a.job ?? "-", env,
      exec: deps.exec ?? realExec(),
      readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
      exists: deps.exists ?? existsSync,
      listDir: deps.listDir ?? ((p) => readdirSync(p)),
      realpath: deps.realpath ?? realpathSync,
      now: deps.now ?? (() => new Date()),
      resolveChrome: deps.resolveChrome,
      digestFile: deps.digestFile ?? fileDigest,
      root: deps.root ?? repoRoot,
    });
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, `${JSON.stringify(cert, null, 2)}\n`);
    process.stderr.write(`ci-evidence-toolchain: ${a.role} ${a.profile} certificate ${cert.digest}\n`);
    return 0;
  } catch (err) {
    // A probe that cannot describe its runner writes NO certificate and exits 0.
    // A source job without a certificate can never be witnessed, and a main push
    // without a current certificate runs the lane in full — so an unknown
    // toolchain costs a full run, never a red job and never a reuse. Only a
    // malformed invocation (exit 2) is the workflow's own contract failing.
    process.stderr.write(`::warning::ci-evidence-toolchain: no ${a.role} certificate: ${err.message}\n`);
    return 0;
  }
}

/**
 * The browser harness's own resolver, or one that refuses: a harness that cannot
 * be loaded leaves every Chrome-using profile unknown, so its lanes run in full.
 */
export async function harnessChromeResolver(root = repoRoot) {
  try {
    const harness = await import(pathToFileURL(resolve(root, "web/e2e/harness.mjs")).href);
    if (typeof harness.resolveChrome === "function") return harness.resolveChrome;
  } catch { /* below */ }
  return () => { throw new Error("web/e2e/harness.mjs could not be loaded"); };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), process.env, { resolveChrome: await harnessChromeResolver() });
}
