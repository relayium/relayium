#!/usr/bin/env node
// scripts/test/ci-evidence-toolchain-test.mjs — the toolchain certificate
// (scripts/ci/ci-evidence-toolchain.mjs), driven through its real capture code.
//
// The certificate decides whether a main push may witness a check instead of
// re-running it. A probe that reads a version WRONG, or silently accepts an
// output shape it does not know, makes two different toolchains look equal —
// a green check over a compiler nobody ran. So every component is fed
// realistic outputs and every malformed, missing or oversized one, through a
// mocked exec/filesystem (the same functions the CLI uses), and the schema,
// digest and comparison are attacked directly. When this file runs on a real
// hosted Ubuntu runner (repo-hygiene), it also captures real certificates there,
// so the parsers meet the actual image at least once per change.
//
// Node standard library only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  COMPONENTS, PROBE_LIMITS, TOOLCHAIN_SCHEMA, ToolchainUnknown, canonical, capture, harnessChromeResolver, loadToolchainRegistry,
  main, realExec, readToolchainRegistry, selectionProgram, toolchainDifferences, toolchainDigest, validateCertificate,
} from "../ci/ci-evidence-toolchain.mjs";
import { resolveChrome as harnessResolveChrome } from "../../web/e2e/harness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const createHashHex = (text) => createHash("sha256").update(text).digest("hex");
const registryText = readFileSync(resolve(repoRoot, "scripts/ci/ci-evidence-toolchain-registry.json"), "utf8");
const failures = [];
let checks = 0;
const check = (ok, message) => { checks += 1; if (!ok) failures.push(message); };
const threw = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const REGISTRY = loadToolchainRegistry(registryText);
const SHA = "0123456789abcdef0123456789abcdef01234567";

// ── a mocked runner per family ──────────────────────────────────────────────

const OUT = {
  "sw_vers -productVersion": "15.7\n",
  "sw_vers -buildVersion": "24G222\n",
  "cmd /d /c ver": "\r\nMicrosoft Windows [Version 10.0.26100.6584]\r\n",
  "go version": "go version go1.26.3 linux/amd64\n",
  "go env CGO_ENABLED CC": "1\ngcc\n",
  "gcc --version": "gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0\nCopyright (C) 2023 Free Software Foundation, Inc.\n",
  "clang --version": "Apple clang version 17.0.0 (clang-1700.3.19.1)\nTarget: arm64-apple-darwin24.6.0\n",
  "gcc -dumpmachine": "x86_64-linux-gnu\n",
  "clang -dumpmachine": "arm64-apple-darwin24.6.0\n",
  "node --version": "v24.9.0\n",
  "npm --version": "11.6.0\n",
  "/usr/bin/google-chrome --version": "Google Chrome 141.0.7390.54 \n",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --version": "Google Chrome 141.0.7390.54\n",
  "/usr/bin/python3 --version": "Python 3.9.6\n",
  "/opt/homebrew/bin/python3 --version": "Python 3.13.7\n",
  "xcode-select -p": "/Applications/Xcode_16.4.app/Contents/Developer\n",
  "xcrun simctl list runtimes -j": JSON.stringify({ runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", version: "26.0", buildversion: "23A339", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-5", version: "18.5", buildversion: "22F77", isAvailable: true },
  ] }),
};

// The simulator listing a runner image ships (`simctl list devices available -j`).
// Deliberately NOT in name order, and with the newer runtime first, so the
// three selection rules disagree: the iPhone rule takes the first iPhone of the
// listing, the iPad rule the sorted-first (name, runtime, udid) iPad.
const U = (n) => `0000000${n}-AAAA-BBBB-CCCC-DDDDEEEEFFF${n}`;
const dev = (name, n, type, extra = {}) => ({ name, udid: U(n), isAvailable: true, state: "Shutdown", deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}`, ...extra });
const DEVICES = () => ({ devices: {
  "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [dev("iPad Pro 13-inch (M4)", 1, "iPad-Pro-13-inch-M4-8GB"), dev("iPhone 17 Pro", 2, "iPhone-17-Pro"), dev("iPhone 17", 3, "iPhone-17")],
  "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [dev("iPad Air 11-inch (M2)", 4, "iPad-Air-11-inch-M2"), dev("iPhone 16", 5, "iPhone-16")],
} });
OUT["xcrun simctl list devices available -j"] = JSON.stringify(DEVICES());
const DESTINATION_FILES = Object.fromEntries(Object.values(REGISTRY.destinations).map((d) => [resolve(repoRoot, d.file), readFileSync(resolve(repoRoot, d.file), "utf8")]));
const CHROME = { Linux: "/usr/bin/google-chrome", macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
const XCODES = {
  "/Applications/Xcode_16.4.app": { version: "16.4", build: "16F6", macosx: "15.5", sim: "18.5" },
  "/Applications/Xcode_26.0.1.app": { version: "26.0.1", build: "17A400", macosx: "26.0", sim: "26.0" },
};

const ENV = {
  Linux: { RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20260928.1" },
  macOS: { RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", ImageOS: "macos15", ImageVersion: "20260929.0102" },
  Windows: { RUNNER_OS: "Windows", RUNNER_ARCH: "X64", ImageOS: "win25", ImageVersion: "20260928.1" },
};
const BINDING_ENV = {
  GITHUB_REPOSITORY_ID: "1282331342", GITHUB_RUN_ID: "36873812806", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: "relayium/relayium/.github/workflows/merge-gate.yml@refs/pull/156/merge", GITHUB_JOB: "test",
  CI_EVIDENCE_JOB_INDEX: "0", CI_EVIDENCE_JOB_TOTAL: "1", ANDROID_HOME: "/usr/local/lib/android/sdk",
};

function runner(os, overrides = {}) {
  const calls = [];
  const out = { ...OUT, ...(os === "macOS" ? { "go version": "go version go1.26.3 darwin/arm64\n", "go env CGO_ENABLED CC": "1\nclang\n" } : {}),
    // Windows npm is the batch file npm.cmd, reached only through cmd.exe (which answers in CRLF).
    ...(os === "Windows" ? { "go version": "go version go1.26.3 windows/amd64\n", "go env CGO_ENABLED CC": "1\ngcc\n", "cmd /d /c npm.cmd --version": "11.6.0\r\n" } : {}),
    ...overrides.out };
  const files = {
    "/etc/os-release": 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n',
    "/usr/local/lib/android/sdk/platforms/android-37.0/source.properties": "Pkg.Desc=Android SDK Platform 37\nPkg.Revision=1\n",
    "/usr/local/lib/android/sdk/build-tools/36.0.0/source.properties": "Pkg.Revision=36.0.0\n",
    ...overrides.files,
  };
  const exists = new Set(overrides.exists ?? ["/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/gcc", "/usr/bin/clang", "/usr/bin/gcc.exe", "/toolchain/bin/clang"]);
  const xcodes = overrides.xcodes ?? XCODES;
  return {
    calls,
    // Windows separates PATH with ';' whatever the host this test runs on.
    env: { ...ENV[os], ...BINDING_ENV, PATH: os === "Windows" ? "/usr/bin;/bin" : "/opt/homebrew/bin:/usr/bin:/bin", ...overrides.env },
    exec: (argv, env = {}, input = undefined) => {
      calls.push({ argv, env, input });
      if (os === "Windows") {
        // What realExec meets on a real Windows runner: Node refuses to spawn a
        // batch file without a shell (spawnSync reports EINVAL, realExec turns it
        // into this unknown); a bare `npm`, or a whole command line passed as the
        // program name, is no executable PATH resolves.
        if (/\.(cmd|bat)$/i.test(argv[0])) throw new ToolchainUnknown(`${argv[0]} could not run: EINVAL`);
        if (argv[0] === "npm" || /\s/.test(argv[0])) return { status: 127, stdout: "", stderr: "" };
      }
      // A job's selection program is EXECUTED, by a real Python, on the listing —
      // the rule the job runs, not a re-implementation of it.
      if (argv[1] === "-c" && /python3$/.test(argv[0])) {
        if (overrides.python) return overrides.python(argv, input);
        const real = spawnSync("python3", ["-c", argv[2]], { input, encoding: "utf8" });
        return { status: real.status, stdout: real.stdout, stderr: real.stderr };
      }
      const key = argv.join(" ");
      const app = Object.keys(xcodes).find((a) => key.startsWith(`${a}/Contents/Developer/usr/bin/xcodebuild`));
      if (app) {
        const x = xcodes[app];
        return overrides.xcodebuild ? overrides.xcodebuild(app) : { status: 0, stdout: `Xcode ${x.version}\nBuild version ${x.build}\n`, stderr: "" };
      }
      const sdk = /^xcrun --sdk (macosx|iphonesimulator) --show-sdk-version$/.exec(key);
      if (sdk) {
        const x = Object.entries(xcodes).find(([a]) => env.DEVELOPER_DIR === `${a}/Contents/Developer`)?.[1];
        return x ? { status: 0, stdout: `${sdk[1] === "macosx" ? x.macosx : x.sim}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" };
      }
      if (key === "java -version") {
        return overrides.java ?? { status: 0, stdout: "", stderr: 'openjdk version "17.0.16" 2025-07-15\nOpenJDK Runtime Environment Temurin-17.0.16+8 (build 17.0.16+8)\nOpenJDK 64-Bit Server VM\n' };
      }
      if (overrides.status?.[key] !== undefined) return { status: overrides.status[key], stdout: "", stderr: "" };
      if (out[key] === undefined) return { status: 127, stdout: "", stderr: "" };
      return { status: 0, stdout: out[key], stderr: "" };
    },
    readFile: (p) => { const all = { ...DESTINATION_FILES, ...files }; if (all[p] === undefined) throw new Error("ENOENT"); return all[p]; },
    exists: (p) => exists.has(p),
    resolveChrome: "resolveChrome" in overrides ? overrides.resolveChrome : (() => { if (!CHROME[os]) throw new Error(`no Chrome found on platform ${os}`); return CHROME[os]; }),
    digestFile: overrides.digestFile ?? (() => "c".repeat(64)),
    // `Xcode.app` is the usual alias of one real install; only the default inventory carries it.
    listDir: (p) => { if (p !== "/Applications") throw new Error("ENOENT"); return [...Object.keys(xcodes).map((a) => a.slice(14)), "Safari.app", ...(overrides.xcodes ? [] : ["Xcode.app"])]; },
    realpath: (p) => ({ "/Applications/Xcode.app": "/Applications/Xcode_26.0.1.app", "/usr/bin/google-chrome": "/opt/google/chrome/google-chrome",
      "/usr/bin/gcc": "/usr/bin/x86_64-linux-gnu-gcc-13", ...overrides.realpaths })[p] ?? p,
  };
}

const osOf = (profile) => ({ "ubuntu-latest": "Linux", "macos-15": "macOS", "windows-latest": "Windows" })[REGISTRY.profiles[profile].runner];

function certFor(profile, overrides = {}, role = "source") {
  const r = runner(osOf(profile), overrides);
  return capture({ registry: overrides.registry ?? REGISTRY, profileName: profile, role, laneId: "go", jobId: "test", env: r.env, exec: r.exec,
    readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath, now: () => new Date("2026-10-01T14:20:00Z"),
    resolveChrome: r.resolveChrome, digestFile: r.digestFile, root: repoRoot });
}

// ── 1. every profile captures, validates and is stable ──────────────────────

for (const profile of Object.keys(REGISTRY.profiles)) {
  let cert = null;
  const err = threw(() => { cert = certFor(profile); });
  check(err === null, `profile ${profile} did not capture on a consistent ${osOf(profile)} runner: ${err?.message}`);
  if (!cert) continue;
  check(Object.keys(cert.toolchain).join() === REGISTRY.profiles[profile].components.join(),
    `profile ${profile} captured [${Object.keys(cert.toolchain)}], want its components in order`);
  check(cert.digest === toolchainDigest(profile, cert.toolchain) && cert.schema === TOOLCHAIN_SCHEMA, `profile ${profile}: digest/schema wrong`);
  const again = certFor(profile);
  check(again.digest === cert.digest, `profile ${profile}: two captures of the same runner differ`);
  check(toolchainDifferences(cert, again).length === 0, `profile ${profile}: equal captures report differences`);
}
try {
  const mac = certFor("macos-xcode-iphone");
  check(mac.toolchain.xcode.installed.length === 2 && mac.toolchain.xcode.installed.every((x) => x.app.startsWith("/Applications/Xcode_")),
    "the Xcode inventory did not resolve the Xcode.app alias onto the real install exactly once");
  check(mac.toolchain.xcode.installed[1].iphonesimulator_sdk === "26.0" && mac.toolchain.xcode.default_developer_dir.endsWith("Xcode_16.4.app/Contents/Developer"),
    "the Xcode inventory lost an SDK version or the default selection");
  check(mac.toolchain.xcode.used.version === "16.4", "a job on the image default did not record the default Xcode as used");
  const selected = certFor("macos-xcode-iphone", { env: { DEVELOPER_DIR: "/Applications/Xcode_26.0.1.app/Contents/Developer" } });
  check(selected.toolchain.xcode.used.build === "17A400" && toolchainDifferences(mac, selected).every((d) => d.startsWith("xcode.used.")) && toolchainDifferences(mac, selected).length === 3,
    "a job that selected Xcode 26 through DEVELOPER_DIR did not record it as used, or the difference is not exactly xcode.used");
  check(certFor("linux-go").toolchain.go.cc_version.startsWith("gcc (Ubuntu 13.3.0"), "the cgo C compiler version was not recorded");
  const cgoCc = certFor("linux-go").toolchain.go;
  check(cgoCc.cc_target === "x86_64-linux-gnu" && cgoCc.cc_path === "/usr/bin/x86_64-linux-gnu-gcc-13",
    `the cgo compiler's own target and resolved binary were not recorded: ${JSON.stringify(cgoCc)}`);
  // The verified finding: an aarch64 GCC of the very same version, under the same
  // Go/linux/amd64/cgo=1, must NOT certify as the x86_64 one.
  const arm = certFor("linux-go", { out: { "gcc -dumpmachine": "aarch64-linux-gnu\n" } });
  check(JSON.stringify(toolchainDifferences(certFor("linux-go"), arm)) === JSON.stringify(["go.cc_target"]),
    `two GCCs of one version but different targets must differ in exactly go.cc_target: ${JSON.stringify(toolchainDifferences(certFor("linux-go"), arm))}`);
  const moved = certFor("linux-go", { realpaths: { "/usr/bin/gcc": "/usr/bin/x86_64-linux-gnu-gcc-14" } });
  check(JSON.stringify(toolchainDifferences(certFor("linux-go"), moved)) === JSON.stringify(["go.cc_path"]),
    "a CC that resolves to another binary must differ in go.cc_path");
  check(certFor("windows-go").toolchain.go.cc_path === "/usr/bin/gcc.exe", "the Windows CC was not resolved to its .exe");
  const noCc = certFor("linux-go", { status: { "gcc --version": 127 } }).toolchain.go;
  check(noCc.cc === "gcc" && noCc.cc_path === "absent" && noCc.cc_target === "absent" && noCc.cc_version === "absent",
    `a CC that is not installed must be recorded absent on every field: ${JSON.stringify(noCc)}`);
  check(certFor("macos-xcode-go").toolchain.go.cc_version.startsWith("Apple clang version 17"), "the macOS cgo compiler was not recorded");
  check(certFor("windows-node").toolchain.node.npm === "11.6.0", "Windows npm (npm.cmd through cmd.exe) was not recorded");
  check(certFor("linux-java-android").toolchain["android-sdk"]["build-tools;36.0.0"] === "36.0.0", "an Android package revision was not recorded");
  const src = certFor("linux-go", { env: { CI_EVIDENCE_JOB_INDEX: "3", CI_EVIDENCE_JOB_TOTAL: "8", DEVELOPER_DIR: "/x" } });
  check(src.binding.job_index === 3 && src.binding.job_total === 8 && src.audit.developer_dir === "/x", "the source binding lost its matrix index");
  const cur = certFor("linux-go", { env: { CI_EVIDENCE_JOB_INDEX: undefined, CI_EVIDENCE_JOB_TOTAL: undefined } }, "current");
  check(cur.binding.job_index === 0 && cur.binding.job_total === 1 && cur.binding.role === "current", "a current certificate is not index 0 of 1");
  check(toolchainDifferences(src, cur).length === 0, "source and current captures of the same toolchain differ beyond their bindings");
} catch (err) {
  check(false, `the per-component capture checks could not run: ${err.message}`);
}

// ── 1b. the simulator destination is each job's OWN rule, executed ──────────
//
// The listing is the same for all three; the rules are not. The iPhone UI smoke
// takes the first iPhone of the listing (iOS 26, "iPhone 17 Pro"), the iPad
// shell the sorted-first iPad ("iPad Air", iOS 18.5), the session acceptance
// script the first iPhone with its own interpreter. Reordering the listing
// changes the iPhone rules' answer and not the iPad's — and the certificate
// follows the answer, not the inventory.
try {
  const sel = (profile, o) => certFor(profile, o).toolchain.destination;
  const iphone = sel("macos-xcode-iphone");
  const audit = (profile, o) => certFor(profile, o).audit.simulator_udid;
  check(audit("macos-xcode-iphone") === U(2) && iphone.selected.listing_position === 1 && iphone.selected.name === "iPhone 17 Pro"
    && iphone.selected.runtime === "com.apple.CoreSimulator.SimRuntime.iOS-26-0" && iphone.selected.runtime_version === "26.0"
    && iphone.selected.runtime_build === "23A339" && iphone.selected.device_type.endsWith("iPhone-17-Pro")
    && iphone.interpreter.path === "/usr/bin/python3" && iphone.interpreter.version === "Python 3.9.6",
  `the iPhone UI smoke's rule did not pick the listing's first iPhone: ${JSON.stringify(iphone)}`);
  const ipad = sel("macos-xcode-ipad");
  check(audit("macos-xcode-ipad") === U(4) && ipad.selected.name === "iPad Air 11-inch (M2)" && ipad.selected.runtime_build === "22F77",
    `the iPad shell's rule did not pick the sorted-first iPad: ${JSON.stringify(ipad.selected)}`);
  const acceptance = sel("macos-xcode-go-iphone");
  check(audit("macos-xcode-go-iphone") === U(2) && acceptance.interpreter.path === "/opt/homebrew/bin/python3"
    && acceptance.interpreter.version === "Python 3.13.7" && acceptance.rule === "session-acceptance-iphone",
  `the session acceptance rule did not run its own PATH python3: ${JSON.stringify(acceptance)}`);
  check(new Set([iphone.program_sha256, ipad.program_sha256, acceptance.program_sha256]).size === 3,
    "two different selection rules share one program digest");
  const reordered = DEVICES();
  reordered.devices = Object.fromEntries(Object.entries(reordered.devices).reverse());
  const out = { "xcrun simctl list devices available -j": JSON.stringify(reordered) };
  const iphone2 = certFor("macos-xcode-iphone", { out });
  check(iphone2.audit.simulator_udid === U(5),
    `the iPhone rule on a reordered listing picked ${iphone2.audit.simulator_udid}, want the new first iPhone`);
  const diff = toolchainDifferences(certFor("macos-xcode-iphone"), iphone2);
  check(diff.length > 0 && diff.every((d) => d.startsWith("destination.selected.")) && diff.includes("destination.selected.name")
    && diff.includes("destination.selected.runtime_build"),
  `a reordered listing that moves the iPhone pick must differ exactly in the selection: ${JSON.stringify(diff)}`);
  // The iPad rule picks the same device on the reordered listing; only the
  // listing position — an order fact, compared conservatively — moves.
  const ipad2 = certFor("macos-xcode-ipad", { out });
  check(ipad2.audit.simulator_udid === U(4) && JSON.stringify(toolchainDifferences(certFor("macos-xcode-ipad"), ipad2)) === JSON.stringify(["destination.selected.listing_position"]),
    `the iPad rule on a reordered listing must pick the same device and differ only in its listing position: ${JSON.stringify(toolchainDifferences(certFor("macos-xcode-ipad"), ipad2))}`);
  // Same destination on another runner whose device set minted other UDIDs: EQUAL.
  const renamed = DEVICES();
  for (const list of Object.values(renamed.devices)) for (const d of list) d.udid = d.udid.replace(/^0000000/, "9999999");
  const otherSet = certFor("macos-xcode-iphone", { out: { "xcrun simctl list devices available -j": JSON.stringify(renamed) } });
  check(toolchainDifferences(certFor("macos-xcode-iphone"), otherSet).length === 0 && otherSet.audit.simulator_udid !== audit("macos-xcode-iphone"),
    "the same destination under different UDIDs (another runner's device set) does not compare equal");
  // A different iPhone model on the same runtime at the same position is NOT the same destination.
  const swapped = DEVICES();
  swapped.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"][1] = dev("iPhone 17 Pro Max", 2, "iPhone-17-Pro-Max");
  const d3 = toolchainDifferences(certFor("macos-xcode-iphone"), certFor("macos-xcode-iphone", { out: { "xcrun simctl list devices available -j": JSON.stringify(swapped) } }));
  check(JSON.stringify(d3) === JSON.stringify(["destination.selected.name", "destination.selected.device_type"]),
    `a different iPhone model at the same place must differ in name and device type: ${JSON.stringify(d3)}`);
  const moved = DEVICES();
  moved.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"].push(dev("iPad Air 11-inch (M2)", 0, "iPad-Air-11-inch-M2"));
  check(certFor("macos-xcode-ipad", { out: { "xcrun simctl list devices available -j": JSON.stringify(moved) } }).audit.simulator_udid === U(4),
    "the iPad rule's tie-break is not (name, runtime, udid)");
  // The pinned programs are the ones the workflows and the script run today.
  for (const [id, d] of Object.entries(REGISTRY.destinations)) {
    const prog = selectionProgram(readFileSync(resolve(repoRoot, d.file), "utf8"), d);
    check(createHashHex(`${prog.interpreter}\0${prog.program}`) === d.sha256,
      `destination ${id}: ${d.file}${d.step ? ` (${d.step})` : ""} no longer runs the pinned selection program; re-pin it in the toolchain registry`);
  }
} catch (err) {
  check(false, `the destination checks could not run: ${err.message}`);
}

// ── 1c. Chrome is what the browser harness itself resolves ──────────────────
try {
  check(await harnessChromeResolver() === harnessResolveChrome,
    "the CLI's Chrome resolver is not web/e2e/harness.mjs resolveChrome itself");
  const linux = certFor("linux-node-chrome").toolchain.chrome;
  check(linux.path === "/usr/bin/google-chrome" && linux.real_path === "/opt/google/chrome/google-chrome" && linux.pinned === false
    && linux.sha256 === "c".repeat(64) && linux.version === "Google Chrome 141.0.7390.54",
  `the resolved Chrome's path, real path, digest or version was not recorded: ${JSON.stringify(linux)}`);
  const pinned = certFor("linux-node-chrome", { env: { CHROME_PATH: "/opt/chrome/chrome" }, resolveChrome: () => "/opt/chrome/chrome",
    out: { "/opt/chrome/chrome --version": "Chromium 141.0.7390.54 snap\n" } });
  check(pinned.toolchain.chrome.pinned === true && pinned.toolchain.chrome.version === "Chromium 141.0.7390.54",
    "a CHROME_PATH-pinned Chromium was not recorded as pinned and as Chromium");
  const d1 = toolchainDifferences(certFor("linux-node-chrome"), certFor("linux-node-chrome", { digestFile: () => "d".repeat(64) }));
  check(JSON.stringify(d1) === JSON.stringify(["chrome.sha256"]), `a different Chrome binary must differ in exactly its digest: ${JSON.stringify(d1)}`);
  const d2 = toolchainDifferences(certFor("linux-node-chrome"), pinned);
  check(d2.includes("chrome.pinned") && d2.includes("chrome.path"), `a pinned Chrome must not compare equal to the default one: ${JSON.stringify(d2)}`);
} catch (err) {
  check(false, `the Chrome checks could not run: ${err.message}`);
}

// ── 2. every unknown is refused, by name ────────────────────────────────────

const UNKNOWNS = [
  ["linux-go", "a Go version in an unknown shape", { out: { "go version": "go version devel +abc linux/amd64\n" } }, /go version is not in a recognised shape/],
  ["linux-go", "go not installed", { status: { "go version": 127 } }, /go version exited 127/],
  ["linux-go", "a CGO_ENABLED that is not 0/1", { out: { "go env CGO_ENABLED CC": "yes\ngcc\n" } }, /go env CGO_ENABLED/],
  ["linux-go", "the C compiler failing", { status: { "gcc --version": 1 } }, /gcc --version exited 1/],
  ["linux-go", "a C compiler with no version", { out: { "gcc --version": "gcc\n" } }, /gcc --version is not in a recognised shape/],
  ["linux-go", "a C compiler that cannot name its target", { status: { "gcc -dumpmachine": 1 } }, /gcc -dumpmachine exited 1/],
  ["linux-go", "a C compiler target in an unknown shape", { out: { "gcc -dumpmachine": "x86_64\n" } }, /gcc -dumpmachine is not in a recognised shape/],
  ["linux-go", "a C compiler that is not on PATH", { env: { PATH: "/nowhere" } }, /gcc is not on PATH/],
  ["linux-node", "a node version with a suffix", { out: { "node --version": "v24.9.0-nightly\n" } }, /node --version/],
  ["linux-node", "npm missing", { status: { "npm --version": 127 } }, /npm --version exited 127/],
  ["windows-node", "no npm.cmd for cmd.exe to find", { status: { "cmd /d /c npm.cmd --version": 9009 } }, /^cmd \/d \/c npm\.cmd --version exited 9009$/],
  ["windows-node", "npm.cmd failing under cmd.exe", { status: { "cmd /d /c npm.cmd --version": 1 } }, /^cmd \/d \/c npm\.cmd --version exited 1$/],
  ["windows-node", "an npm.cmd version with a suffix", { out: { "cmd /d /c npm.cmd --version": "11.6.0-pre\r\n" } }, /^npm --version is not in a recognised shape: "11\.6\.0-pre"$/],
  ["windows-node", "cmd.exe printing its not-found text", { out: { "cmd /d /c npm.cmd --version": "'npm.cmd' is not recognized as an internal or external command,\r\n" } }, /^npm --version is not in a recognised shape/],
  ["windows-node", "cmd.exe printing nothing", { out: { "cmd /d /c npm.cmd --version": "\r\n" } }, /^npm --version is not in a recognised shape: ""$/],
  ["linux-java", "java missing", { java: { status: 127, stdout: "", stderr: "" } }, /java -version exited 127/],
  ["linux-java", "java with no runtime line", { java: { status: 0, stdout: "", stderr: 'openjdk version "17.0.16"\n' } }, /java -version runtime/],
  ["linux-java-android", "an Android package not installed", { files: { "/usr/local/lib/android/sdk/build-tools/36.0.0/source.properties": undefined } }, /source\.properties is unreadable/],
  ["linux-java-android", "an Android package with no revision", { files: { "/usr/local/lib/android/sdk/platforms/android-37.0/source.properties": "Pkg.Desc=x\n" } }, /Pkg\.Revision/],
  ["linux-java-android", "no ANDROID_HOME", { env: { ANDROID_HOME: "" } }, /ANDROID_HOME is not set/],
  ["linux-node-chrome", "a Chrome that prints something else", { out: { "/usr/bin/google-chrome --version": "Chrome Canary\n" } }, /google-chrome --version is not in a recognised shape/],
  ["linux-node-chrome", "a harness that resolves no Chrome", { resolveChrome: () => { throw new Error("no Chrome found on platform \"linux\""); } }, /resolves no Chrome: no Chrome found/],
  ["linux-node-chrome", "a CHROME_PATH the harness refuses", { env: { CHROME_PATH: "/nope" }, resolveChrome: () => { throw new Error("CHROME_PATH is set to /nope but there is no such file"); } }, /resolves no Chrome: CHROME_PATH is set/],
  ["linux-node-chrome", "a relative Chrome path", { resolveChrome: () => "google-chrome" }, /resolved "google-chrome"/],
  ["linux-node-chrome", "no resolver at all", { resolveChrome: null }, /Chrome resolver is unavailable/],
  ["linux-node-chrome", "an unreadable Chrome binary", { digestFile: () => { throw new Error("EACCES"); } }, /google-chrome is unreadable/],
  ["linux-base", "an ImageVersion that is not a date build", { env: { ImageVersion: "latest" } }, /ImageVersion is not in a recognised shape/],
  ["linux-base", "no ImageOS", { env: { ImageOS: undefined } }, /ImageOS/],
  ["linux-base", "an unreadable os-release", { files: { "/etc/os-release": undefined } }, /os-release is unreadable/],
  ["linux-base", "a profile run on the wrong OS", { env: { RUNNER_OS: "macOS" } }, /is for Linux, this runner is macOS/],
  ["macos-xcode", "no Xcode installed", { xcodes: {} }, /no Xcode is installed/],
  ["macos-xcode", "an xcodebuild in an unknown shape", { xcodebuild: () => ({ status: 0, stdout: "Xcode beta\n", stderr: "" }) }, /xcodebuild -version is not in a recognised shape/],
  ["macos-xcode", "a broken Xcode", { xcodebuild: () => ({ status: 70, stdout: "", stderr: "" }) }, /exited 70/],
  ["macos-xcode", "too many Xcodes", { xcodes: Object.fromEntries(Array.from({ length: PROBE_LIMITS.xcodes + 1 }, (_, i) => [`/Applications/Xcode_${i}.0.app`, { version: `${i}.0`, build: "1A1", macosx: "1.0", sim: "1.0" }])) }, /more than 12 Xcodes/],
  ["macos-xcode", "an unknown default selection", { out: { "xcode-select -p": "\n" } }, /xcode-select -p/],
  ["macos-xcode", "a used Xcode that is not installed", { env: { DEVELOPER_DIR: "/Applications/Xcode_99.app/Contents/Developer" } }, /is not one of the installed Xcodes/],
  ["macos-xcode-iphone", "simctl failing", { status: { "xcrun simctl list devices available -j": 1 } }, /simctl list devices available -j exited 1/],
  ["macos-xcode-iphone", "simctl returning text", { out: { "xcrun simctl list devices available -j": "== Devices ==" } }, /simctl did not return JSON/],
  ["macos-xcode-iphone", "no iPhone on the image (the job's own program fails)", { out: { "xcrun simctl list devices available -j": JSON.stringify({ devices: { r: [dev("iPad Air", 4, "iPad-Air")] } }) } }, /python3 -c .* exited 1/s],
  ["macos-xcode-go-iphone", "no iPhone on the image (the script's program prints nothing)", { out: { "xcrun simctl list devices available -j": JSON.stringify({ devices: { r: [dev("iPad Air", 4, "iPad-Air")] } }) } }, /session-acceptance-iphone selection is not in a recognised shape/],
  ["macos-xcode-ipad", "no iPad on the image", { out: { "xcrun simctl list devices available -j": JSON.stringify({ devices: { r: [dev("iPhone 16", 5, "iPhone-16")] } }) } }, /ios-ipad-shell-ipad selection is not in a recognised shape/],
  ["macos-xcode-iphone", "a pick the listing does not have", { python: () => ({ status: 0, stdout: `${U(9)}\n`, stderr: "" }) }, /which the listing has 0 times/],
  ["macos-xcode-iphone", "a pick on an uninstalled runtime", { out: { "xcrun simctl list runtimes -j": JSON.stringify({ runtimes: [] }) } }, /is not exactly one installed runtime/],
  ["macos-xcode-iphone", "a malformed runtime", { out: { "xcrun simctl list runtimes -j": JSON.stringify({ runtimes: [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0" }] }) } }, /is not exactly one installed runtime/],
  ["macos-xcode-iphone", "too many runtimes", { out: { "xcrun simctl list runtimes -j": JSON.stringify({ runtimes: Array.from({ length: PROBE_LIMITS.runtimes + 1 }, (_, i) => ({ identifier: `r${i}`, version: "1", buildversion: "1" })) }) } }, /simctl listings are malformed/],
  ["macos-xcode-iphone", "an interpreter in an unknown shape", { out: { "/usr/bin/python3 --version": "Python 3\n" } }, /python3 --version is not in a recognised shape/],
  ["macos-xcode-go-iphone", "no python3 on PATH (the compiler is)", { env: { PATH: "/toolchain/bin" } }, /python3 is not on PATH/],
  ["macos-xcode-iphone", "a selection program that changed under its pin", { files: { [resolve(repoRoot, ".github/workflows/ios.yml")]: DESTINATION_FILES[resolve(repoRoot, ".github/workflows/ios.yml")].replace('startswith("iPhone")))\')"', 'startswith("iPhone 1")))\')"') } }, /not the one the registry pins/],
  ["macos-xcode-iphone", "a workflow without the step", { files: { [resolve(repoRoot, ".github/workflows/ios.yml")]: "jobs: {}\n" } }, /does not name the step/],
  ["macos-xcode-go-iphone", "a script that grew a second program", { files: { [resolve(repoRoot, "scripts/ios-ui-session-acceptance.sh")]: `${DESTINATION_FILES[resolve(repoRoot, "scripts/ios-ui-session-acceptance.sh")]}\nx="$(echo | python3 -c 'import json, sys\nprint(1)')"\n` } }, /runs 2 selection programs/],
  ["windows-go", "a Windows ver in an unknown shape", { out: { "cmd /d /c ver": "Windows\r\n" } }, /ver is not in a recognised shape/],
  ["linux-go", "a source job with no matrix index", { env: { CI_EVIDENCE_JOB_INDEX: undefined } }, /CI_EVIDENCE_JOB_INDEX/],
  ["linux-go", "a matrix index past its total", { env: { CI_EVIDENCE_JOB_INDEX: "2", CI_EVIDENCE_JOB_TOTAL: "2" } }, /job index is outside the job total/],
  ["linux-go", "a run attempt written as 01", { env: { GITHUB_RUN_ATTEMPT: "01" } }, /GITHUB_RUN_ATTEMPT/],
  ["linux-go", "a sha that is not a commit", { env: { GITHUB_SHA: "HEAD" } }, /GITHUB_SHA/],
];
for (const [profile, what, overrides, expect] of UNKNOWNS) {
  const err = threw(() => certFor(profile, overrides));
  check(err instanceof ToolchainUnknown && expect.test(err.message), `${profile} with ${what}: want ToolchainUnknown ${expect}, got ${err?.message ?? "a certificate"}`);
}
{
  const err = threw(() => capture({ registry: REGISTRY, profileName: "linux-nope", role: "source", env: {} }));
  check(err instanceof ToolchainUnknown && /not in the toolchain registry/.test(err.message), "an unknown profile was captured");
  const role = threw(() => certFor("linux-go", {}, "witness"));
  check(role instanceof ToolchainUnknown && /neither source nor current/.test(role.message), "an unknown role was captured");
}

// ── 3. the schema, the digest and the comparison ────────────────────────────

try {
  const base = certFor("macos-xcode-go-iphone");
  const mutate = (fn) => { const c = structuredClone(base); fn(c); return threw(() => validateCertificate(c, REGISTRY)); };
  for (const [what, fn, expect] of [
    ["an extra top-level key", (c) => { c.extra = 1; }, /wrong keys/],
    ["another schema", (c) => { c.schema = "v0"; }, /wrong schema/],
    ["a binding with an extra key", (c) => { c.binding.runner = "x"; }, /binding has the wrong keys/],
    ["an unknown profile", (c) => { c.binding.profile = "macos-nope"; }, /unknown profile/],
    ["a negative index", (c) => { c.binding.job_index = -1; }, /binding is malformed/],
    ["a missing component", (c) => { delete c.toolchain.go; }, /does not carry exactly its components/],
    ["reordered components", (c) => { c.toolchain = { go: c.toolchain.go, image: c.toolchain.image, xcode: c.toolchain.xcode, destination: c.toolchain.destination }; }, /exactly its components/],
    ["a destination of another rule", (c) => { c.toolchain.destination.rule = "ios-ui-smoke-iphone"; }, /destination component is malformed/],
    ["a destination with no position", (c) => { delete c.toolchain.destination.selected.listing_position; }, /destination component is malformed/],
    ["a UDID compared as a toolchain fact", (c) => { c.toolchain.destination.selected.udid = "00000002-AAAA-BBBB-CCCC-DDDDEEEEFFF2"; }, /destination component is malformed/],
    ["an audit UDID that is not one", (c) => { c.audit.simulator_udid = "iPhone"; }, /audit block is malformed/],
    ["a component with an extra field", (c) => { c.toolchain.go.extra = "x"; }, /go component is malformed/],
    ["a Go component without the compiler target", (c) => { delete c.toolchain.go.cc_target; }, /go component is malformed/],
    ["an Xcode entry with no build", (c) => { delete c.toolchain.xcode.installed[0].build; }, /xcode component is malformed/],
    ["a toolchain edited under its digest", (c) => { c.toolchain.go.version = "go1.27.0"; }, /digest does not match/],
    ["an audit block with code in it", (c) => { c.audit.eval = "process.exit(0)"; }, /audit block is malformed/],
    ["an oversized certificate", (c) => { c.audit.matrix = "x".repeat(PROBE_LIMITS.certificateBytes); }, /above its size cap/],
  ]) {
    const err = mutate(fn);
    check(err instanceof ToolchainUnknown && expect.test(err.message), `validateCertificate accepted ${what}: ${err?.message}`);
  }
  const other = structuredClone(base);
  other.toolchain.destination.selected.runtime_build = "23A340";
  other.toolchain.go.version = "go1.26.4";
  other.digest = toolchainDigest(other.binding.profile, other.toolchain);
  const diff = toolchainDifferences(base, other);
  check(JSON.stringify(diff) === JSON.stringify(["go.version", "destination.selected.runtime_build"]),
    `toolchainDifferences reported ${JSON.stringify(diff)}, want exactly the two changed facts`);
  check(canonical({ b: 1, a: [{ d: 2, c: 3 }] }) === '{"a":[{"c":3,"d":2}],"b":1}', "canonical JSON does not sort keys at every level");
} catch (err) {
  check(false, `the schema/digest/comparison checks could not run: ${err.message}`);
}

// ── 3b. the Windows Server 2025 + Visual Studio 2026 image ──────────────────
// windows-latest moved to ImageOS `win25-vs2026`, which the family+release
// grammar refused, so no Windows certificate was ever written. Exactly that
// literal is admitted, at capture AND in the schema; it never compares equal
// to `win25`, and every near-miss — a suffix, another VS generation, a line
// end or any control byte anywhere in the value — is still unknown.

const VS2026 = "win25-vs2026";
const IMAGE_OS_REFUSED = [
  ...["\n", "\r\n", "\r", "\u0000", "\t", "\u000b", "\u000c", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029", " "]
    .flatMap((c) => [`${VS2026}${c}`, `${c}${VS2026}`, `win25${c}vs2026`, `win25-${c}vs2026`]),
  "win25\n", "win25\r\n", "ubuntu24\n", "win25-vs2026\nwin25", "win25\nwin25-vs2026", "win25-vs2026win25-vs2026",
  "win25-vs2026x", "win25-vs2026-arm64", "win25-vs20260", "win25-vs2026.1", "win25-vs2026-", "win25-vs2026/x",
  "win25-vs2022", "win25-vs2025", "win25-vs2027", "win25-vs3026", "win25-vs", "win25-", "-vs2026", "-win25",
  "win26-vs2026", "win24-vs2026", "win2025-vs2026", "win25-vs-2026", "win25_vs2026", "win25vs2026x",
  "WIN25-VS2026", "Win25-vs2026", "win25-VS2026", "win25\uff0dvs2026", "",
];
// `vs2026` alone is the legacy family+release shape, admitted like any other.
const IMAGE_OS_ADMITTED = ["ubuntu24", "macos15", "win25", "win22", "vs2026", VS2026];
// Each part runs on its own, so a helper broken in one place cannot hide the others.
const part = (what, fn) => { try { fn(); } catch (err) { check(false, `the ${VS2026} ${what} checks could not run: ${err.message}`); } };

part("round-trip", () => {
  // The actual shape, through the real capture of both Windows profiles: the
  // certificate validates, survives a JSON round trip, is stable, and a source
  // and a current capture of one runner compare equal (the reuse decision).
  for (const profile of ["windows-go", "windows-node"]) {
    for (const ImageVersion of ["20260928.1", "20260907.229.1"]) {
      const env = { ImageOS: VS2026, ImageVersion };
      let cert = null;
      const err = threw(() => { cert = certFor(profile, { env }); });
      check(err === null && cert?.toolchain.image.image_os === VS2026 && cert.toolchain.image.image_version === ImageVersion,
        `${profile} on ${VS2026}/${ImageVersion} did not capture: ${err?.message}`);
      if (!cert) continue;
      const parsed = JSON.parse(JSON.stringify(cert));
      const roundTrip = threw(() => validateCertificate(parsed, REGISTRY));
      check(roundTrip === null && parsed.digest === toolchainDigest(profile, parsed.toolchain),
        `${profile} on ${VS2026} did not survive a JSON round trip: ${roundTrip?.message}`);
      check(certFor(profile, { env }).digest === cert.digest, `${profile} on ${VS2026}: two captures of the same runner differ`);
      const current = certFor(profile, { env: { ...env, CI_EVIDENCE_JOB_INDEX: undefined, CI_EVIDENCE_JOB_TOTAL: undefined } }, "current");
      check(threw(() => validateCertificate(current, REGISTRY)) === null && current.digest === cert.digest && toolchainDifferences(cert, current).length === 0,
        `${profile} on ${VS2026}: a source and a current capture of one toolchain do not compare equal`);
    }
  }
});

part("command", () => {
  // The CLI writes it, and what it wrote validates.
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-toolchain-vs2026-"));
  const r = runner("Windows", { env: { ImageOS: VS2026 } });
  const deps = { registry: REGISTRY, exec: r.exec, readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath,
    now: () => new Date(), resolveChrome: r.resolveChrome, digestFile: r.digestFile };
  for (const profile of ["windows-go", "windows-node"]) {
    const out = join(dir, `${profile}.json`);
    const code = main(["capture", "--role", "source", "--profile", profile, "--out", out, "--lane", "cli", "--job", "cli-windows"], r.env, deps);
    let written = null;
    try { written = validateCertificate(JSON.parse(readFileSync(out, "utf8")), REGISTRY); } catch { /* checked */ }
    check(code === 0 && written?.toolchain.image.image_os === VS2026, `the capture command wrote no valid ${profile} certificate on ${VS2026}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

part("inequality", () => {
  // Different images never compare equal: the image identity is a compared,
  // digested fact, field by field.
  for (const profile of ["windows-go", "windows-node"]) {
    const legacy = certFor(profile);
    const vs = certFor(profile, { env: { ImageOS: VS2026 } });
    check(legacy.toolchain.image.image_os === "win25" && JSON.stringify(toolchainDifferences(legacy, vs)) === JSON.stringify(["image.image_os"])
      && legacy.digest !== vs.digest, `${profile}: win25 and ${VS2026} must differ in exactly image.image_os and by digest`);
    const later = certFor(profile, { env: { ImageOS: VS2026, ImageVersion: "20260929.1" } });
    check(JSON.stringify(toolchainDifferences(vs, later)) === JSON.stringify(["image.image_version"]) && vs.digest !== later.digest,
      `${profile}: two ${VS2026} builds must differ in exactly image.image_version and by digest`);
    const both = certFor(profile, { env: { ImageVersion: "20260929.1" } });
    check(JSON.stringify(toolchainDifferences(both, vs)) === JSON.stringify(["image.image_os", "image.image_version"]),
      `${profile}: another image and build must differ in both image facts`);
  }
});

part("capture refusal", () => {
  // Capture refuses every near-miss, by name.
  for (const profile of ["windows-go", "windows-node"]) {
    for (const ImageOS of IMAGE_OS_REFUSED) {
      const err = threw(() => certFor(profile, { env: { ImageOS } }));
      check(err instanceof ToolchainUnknown && /^ImageOS is not in a recognised shape/.test(err.message),
        `${profile} captured ImageOS ${JSON.stringify(ImageOS)}: ${err?.message ?? "a certificate"}`);
    }
  }
});

// The schema, independently of capture: a legacy certificate re-labelled and
// re-digested, so only the image_os shape can refuse it.
const relabel = (profile, imageOs) => {
  const c = structuredClone(certFor(profile));
  c.toolchain.image.image_os = imageOs;
  c.digest = toolchainDigest(c.binding.profile, c.toolchain);
  return threw(() => validateCertificate(c, REGISTRY));
};
part("schema", () => {
  for (const profile of ["windows-go", "windows-node"]) {
    const ok = relabel(profile, VS2026);
    check(ok === null, `the schema refused a ${profile} certificate on ${VS2026}: ${ok?.message}`);
    for (const imageOs of IMAGE_OS_REFUSED) {
      const err = relabel(profile, imageOs);
      check(err instanceof ToolchainUnknown && err.message === `a ${profile} certificate's image component is malformed`,
        `the schema accepted a ${profile} certificate with image_os ${JSON.stringify(imageOs)}: ${err?.message}`);
    }
  }
});

part("one-grammar", () => {
  // Capture and schema are one grammar: each value is admitted by both or by neither.
  for (const imageOs of [...IMAGE_OS_ADMITTED, ...IMAGE_OS_REFUSED]) {
    const captured = threw(() => certFor("windows-go", { env: { ImageOS: imageOs } })) === null;
    const schema = relabel("windows-go", imageOs) === null;
    check(captured === schema && captured === IMAGE_OS_ADMITTED.includes(imageOs),
      `ImageOS ${JSON.stringify(imageOs)}: capture ${captured ? "admits" : "refuses"}, schema ${schema ? "admits" : "refuses"}`);
  }
});

// ── 3c. Windows npm, through cmd.exe ────────────────────────────────────────
// npm on Windows is npm.cmd; spawned directly (no shell) Node refuses it with
// EINVAL, so no windows-node certificate could ever be written. It runs as one
// fixed argv through cmd.exe; Unix keeps `npm --version`. The mock above refuses
// a direct batch spawn exactly as realExec on Windows does.

const NPM_CMD = ["cmd", "/d", "/c", "npm.cmd", "--version"];
const traced = (profile, overrides = {}) => {
  const r = runner(osOf(profile), overrides);
  const cert = capture({ registry: REGISTRY, profileName: profile, role: "source", laneId: "web", jobId: "test", env: r.env, exec: r.exec,
    readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath, now: () => new Date("2026-10-01T14:20:00Z"),
    resolveChrome: r.resolveChrome, digestFile: r.digestFile, root: repoRoot });
  return { cert, calls: r.calls.map((c) => c.argv) };
};
const npmCalls = (calls) => calls.filter((a) => a.some((t) => /npm/i.test(t)));

part("Windows mock semantics", () => {
  const w = runner("Windows");
  for (const argv of [["npm.cmd", "--version"], ["NPM.CMD", "--version"], ["npm.bat", "--version"]]) {
    const err = threw(() => w.exec(argv));
    check(err instanceof ToolchainUnknown && err.message === `${argv[0]} could not run: EINVAL`, `the Windows mock spawned the batch file ${argv[0]} directly`);
  }
  check(w.exec(["npm", "--version"]).status === 127, "the Windows mock resolved a bare npm");
  const fixed = w.exec(NPM_CMD);
  check(fixed.status === 0 && fixed.stdout === "11.6.0\r\n", "the Windows mock does not answer the fixed cmd.exe route");
  check(w.exec(["cmd /d /c npm.cmd --version"]).status === 127, "the Windows mock ran a whole command line as a program name");
  check(runner("Linux").exec(["npm", "--version"]).status === 0 && runner("Linux").exec(NPM_CMD).status === 127,
    "the Unix mock does not answer exactly npm --version");
});

part("Windows npm argv", () => {
  for (const ImageOS of ["win25", VS2026]) {
    const { cert, calls } = traced("windows-node", { env: { ImageOS } });
    check(cert.toolchain.node.npm === "11.6.0", `windows-node on ${ImageOS} did not record npm through cmd.exe`);
    check(JSON.stringify(npmCalls(calls)) === JSON.stringify([NPM_CMD]),
      `windows-node on ${ImageOS} ran npm as ${JSON.stringify(npmCalls(calls))}, want exactly the fixed ${JSON.stringify(NPM_CMD)}`);
    check(calls.every((a) => Array.isArray(a) && a.length > 0 && a.every((t) => typeof t === "string") && !/\s/.test(a[0]) && !/\.(cmd|bat)$/i.test(a[0])),
      `windows-node on ${ImageOS} spawned a batch file or a command string: ${JSON.stringify(calls)}`);
  }
  for (const profile of ["linux-node", "linux-node-chrome", "linux-node-go-chrome", "macos-xcode-node-go-chrome"]) {
    const { calls } = traced(profile);
    check(JSON.stringify(npmCalls(calls)) === JSON.stringify([["npm", "--version"]]) && !calls.some((a) => a[0] === "cmd"),
      `${profile} ran npm as ${JSON.stringify(npmCalls(calls))}, want exactly ["npm","--version"]`);
  }
});

part("Windows npm equality", () => {
  for (const ImageOS of ["win25", VS2026]) {
    const env = { ImageOS };
    const source = certFor("windows-node", { env });
    const current = certFor("windows-node", { env: { ...env, CI_EVIDENCE_JOB_INDEX: undefined, CI_EVIDENCE_JOB_TOTAL: undefined } }, "current");
    check(source.digest === current.digest && toolchainDifferences(source, current).length === 0 && current.binding.role === "current",
      `windows-node on ${ImageOS}: a source and a current capture of one toolchain do not compare equal`);
    const newer = certFor("windows-node", { env, out: { "cmd /d /c npm.cmd --version": "11.6.1\r\n" } });
    check(JSON.stringify(toolchainDifferences(source, newer)) === JSON.stringify(["node.npm"]) && source.digest !== newer.digest,
      `windows-node on ${ImageOS}: another npm must differ in exactly node.npm and by digest`);
  }
});

// ── 4. the registry ─────────────────────────────────────────────────────────

for (const [what, patch, expect] of [
  ["an unknown component", (r) => { r.profiles["linux-go"].components.push("rust"); }, /malformed components/],
  ["a profile without image first", (r) => { r.profiles["linux-go"].components.reverse(); }, /malformed components/],
  ["Xcode probed on Linux", (r) => { r.profiles["linux-x"] = { runner: "ubuntu-latest", components: ["image", "xcode"] }; }, /probes Xcode off macOS/],
  ["a profile named for another OS", (r) => { r.profiles["linux-mac"] = { runner: "macos-15", components: ["image"] }; }, /runs on macos-15/],
  ["android-sdk without packages", (r) => { delete r.profiles["linux-java-android"].androidPackages; }, /android-sdk without packages/],
  ["a job naming an unknown profile", (r) => { r.lanes.go.jobs.test.profile = "linux-rust"; }, /neither a known profile/],
  ["a job with a profile AND a reason", (r) => { r.lanes.go.jobs.test.uncertifiable = "because I said so, really"; }, /neither a known profile/],
  ["an uncertifiable job with no real reason", (r) => { r.lanes["android-interop"].jobs.interop.uncertifiable = "slow"; }, /neither a known profile/],
  ["a destination component with no rule", (r) => { delete r.profiles["macos-xcode-iphone"].destination; }, /names a destination without the component/],
  ["a rule with no destination component", (r) => { r.profiles["macos-xcode"].destination = "ios-ui-smoke-iphone"; }, /names a destination without the component/],
  ["an unknown destination rule", (r) => { r.profiles["macos-xcode-iphone"].destination = "first-device"; }, /an unknown one/],
  ["a destination with no pin", (r) => { delete r.destinations["ios-ipad-shell-ipad"].sha256; }, /destination ios-ipad-shell-ipad is malformed/],
  ["a destination outside the tree", (r) => { r.destinations["ios-ipad-shell-ipad"].file = "../x.yml"; }, /destination ios-ipad-shell-ipad is malformed/],
  ["a destination on Linux", (r) => { r.profiles["linux-x"] = { runner: "ubuntu-latest", components: ["image", "destination"], destination: "ios-ui-smoke-iphone" }; }, /probes Xcode off macOS/],
  ["a profile with an unknown key", (r) => { r.profiles["linux-go"].simulators = true; }, /unknown keys simulators/],
]) {
  const r = JSON.parse(registryText);
  patch(r);
  const err = threw(() => loadToolchainRegistry(JSON.stringify(r)));
  check(err instanceof ToolchainUnknown && expect.test(err.message), `the toolchain registry accepted ${what}: ${err?.message}`);
}
check(readToolchainRegistry().schema === "relayium.ci-evidence.toolchain-registry/v1", "the on-disk toolchain registry does not load");
check(Object.keys(COMPONENTS).sort().join() === "android-sdk,chrome,destination,go,image,java,node,xcode", "the component set changed without this test");

// ── 5. the command and the time budget ──────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-toolchain-"));
  const r = runner("Linux");
  const deps = { registry: REGISTRY, exec: r.exec, readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath, now: () => new Date(),
    resolveChrome: r.resolveChrome, digestFile: r.digestFile };
  const ok = main(["capture", "--role", "source", "--profile", "linux-go", "--out", join(dir, "a.json"), "--lane", "go", "--job", "test"], r.env, deps);
  let written = null;
  try { written = validateCertificate(JSON.parse(readFileSync(join(dir, "a.json"), "utf8")), REGISTRY); } catch { /* checked */ }
  check(ok === 0 && written?.binding.lane === "go", "the capture command did not write a valid certificate");
  const bad = runner("Linux", { status: { "go version": 2 } });
  const quiet = main(["capture", "--role", "source", "--profile", "linux-go", "--out", join(dir, "b.json"), "--lane", "go", "--job", "test"], bad.env, { ...deps, exec: bad.exec });
  let exists = true;
  try { readFileSync(join(dir, "b.json")); } catch { exists = false; }
  check(quiet === 0 && !exists, `an unknown toolchain exited ${quiet} and ${exists ? "wrote" : "did not write"} a certificate; want 0 and nothing`);
  for (const argv of [["capture"], ["capture", "--role", "source", "--profile", "linux-go", "--out", "x"], ["probe", "--role", "current"],
    ["capture", "--role", "witness", "--profile", "linux-go", "--out", "x"]]) {
    check(main(argv, {}, deps) === 2, `the malformed invocation ${argv.join(" ")} did not exit 2`);
  }
  rmSync(dir, { recursive: true, force: true });
  const spent = threw(() => realExec({ left: 0 })(["true"]));
  check(spent instanceof ToolchainUnknown && /time budget/.test(spent.message), "a probe with no budget left still ran a command");
  const slow = threw(() => realExec({ left: 100 })(["sleep", "2"]));
  check(slow instanceof ToolchainUnknown && /could not run: ETIMEDOUT/.test(slow.message), `a command past its time bound was not refused: ${slow?.message}`);
  check(realExec()(["definitely-not-a-command-xyz"]).status === 127, "a missing command is not reported as 127");
}

// ── 6. a real hosted Ubuntu runner, when this runs on one ────────────────────

let live = "skipped (not a hosted Ubuntu runner)";
if (process.env.RUNNER_OS === "Linux" && process.env.ImageVersion && process.env.GITHUB_RUN_ID) {
  const real = { env: { ...process.env, CI_EVIDENCE_JOB_INDEX: "0", CI_EVIDENCE_JOB_TOTAL: "1" } };
  const results = [];
  for (const profile of ["linux-base", "linux-node", "linux-go", "linux-node-chrome"]) {
    let cert = null;
    const err = threw(() => {
      cert = capture({ registry: REGISTRY, profileName: profile, role: "current", laneId: "-", jobId: "-", env: real.env,
        exec: realExec(), readFile: (p) => readFileSync(p, "utf8"), exists: (p) => { try { readFileSync(p); return true; } catch { return false; } },
        listDir: () => [], realpath: realpathSync, now: () => new Date(), resolveChrome: harnessResolveChrome });
    });
    check(err === null, `the real ${profile} probe failed on this hosted runner: ${err?.message}`);
    if (cert) results.push(`${profile} ${cert.digest.slice(0, 12)} (${cert.toolchain.image.image_version}${cert.toolchain.go ? `, ${cert.toolchain.go.version}, ${cert.toolchain.go.cc_version}` : ""}${cert.toolchain.chrome ? `, ${cert.toolchain.chrome.version} ${cert.toolchain.chrome.real_path}` : ""})`);
  }
  live = results.join("; ");
  process.stdout.write(`ci-evidence-toolchain-test: live ${live}\n`);
}

if (failures.length > 0) {
  console.error(`ci-evidence-toolchain-test: ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`ci-evidence-toolchain-test: OK (${checks} checks: ${Object.keys(REGISTRY.profiles).length} profiles captured and stable; `
  + `${UNKNOWNS.length} unknown toolchains refused; ${VS2026} admitted and ${IMAGE_OS_REFUSED.length} near-miss ImageOS values refused at capture and schema; `
  + `schema/digest/comparison/registry/CLI/budget controls; live: ${live})`);
