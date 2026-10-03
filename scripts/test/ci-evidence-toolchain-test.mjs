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
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  COMPONENTS, PROBE_LIMITS, TOOLCHAIN_SCHEMA, ToolchainUnknown, canonical, capture, harnessChromeResolver, loadToolchainRegistry,
  main, realExec, readToolchainRegistry, selectionProgram, toolchainDifferences, toolchainDigest, validateCertificate,
} from "../ci/ci-evidence-toolchain.mjs";
// The timing trace through the namespace, so an older probe without it fails these checks by name rather than at import.
import * as toolchainModule from "../ci/ci-evidence-toolchain.mjs";
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

// What a real Xcode 27.0 (27A266a) printed for `usr/bin/xcodebuild -version -sdk`,
// byte for byte (sha256 below): the only SDK inventory grammar this probe has
// seen. Every mocked Xcode's inventory is this text with that Xcode's versions
// and path put in, so the mocks speak exactly the observed grammar. The same
// installation's three old queries answered `Xcode 27.0` / `Build version
// 27A266a`, and `27.0` for both `xcrun --sdk macosx|iphonesimulator
// --show-sdk-version` — the facts the inventory must yield.
const RAW_XCODE27 = `DriverKit27.0.sdk - DriverKit 27.0 (driverkit27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/DriverKit.platform/Developer/SDKs/DriverKit27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/DriverKit.platform

iPhoneOS27.0.sdk - iOS 27.0 (iphoneos27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform
BuildID: 8B4091AC-A29C-11F1-874D-9FFBAA4B7BC9
ProductBuildVersion: 24A430
ProductCopyright: 1983-2026 Apple Inc.
ProductName: iPhone OS
ProductVersion: 27.0

iPhoneSimulator27.0.sdk - Simulator - iOS 27.0 (iphonesimulator27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform
BuildID: 8B4091AC-A29C-11F1-874D-9FFBAA4B7BC9
ProductBuildVersion: 24A430
ProductCopyright: 1983-2026 Apple Inc.
ProductName: iPhone OS
ProductVersion: 27.0

MacOSX27.sdk - macOS 27.0 (macosx27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform
BuildID: F8088D3E-A1DA-11F1-AAD4-A82B6E44CE4F
ProductBuildVersion: 26A425
ProductCopyright: 1983-2026 Apple Inc.
ProductName: macOS
ProductUserVisibleVersion: 27.0
ProductVersion: 27.0
iOSSupportVersion: 27.0

MacOSX27.0.sdk - macOS 27.0 (macosx27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform
BuildID: F8088D3E-A1DA-11F1-AAD4-A82B6E44CE4F
ProductBuildVersion: 26A425
ProductCopyright: 1983-2026 Apple Inc.
ProductName: macOS
ProductUserVisibleVersion: 27.0
ProductVersion: 27.0
iOSSupportVersion: 27.0

AppleTVOS27.0.sdk - tvOS 27.0 (appletvos27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVOS.platform/Developer/SDKs/AppleTVOS27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVOS.platform
BuildID: CA572AB2-A1E9-11F1-897C-5D64769D1288
ProductBuildVersion: 24J360
ProductCopyright: 1983-2026 Apple Inc.
ProductName: Apple TVOS
ProductVersion: 27.0

AppleTVSimulator27.0.sdk - Simulator - tvOS 27.0 (appletvsimulator27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVSimulator.platform/Developer/SDKs/AppleTVSimulator27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVSimulator.platform
BuildID: CA572AB2-A1E9-11F1-897C-5D64769D1288
ProductBuildVersion: 24J360
ProductCopyright: 1983-2026 Apple Inc.
ProductName: Apple TVOS
ProductVersion: 27.0

XROS27.0.sdk - visionOS 27.0 (xros27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/XROS.platform/Developer/SDKs/XROS27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/XROS.platform
BuildID: 03F050EE-A0FC-11F1-AD34-488FB93739A6
ProductBuildVersion: 24M361
ProductCopyright: 1983-2026 Apple Inc.
ProductName: xrOS
ProductVersion: 27.0
iOSSupportVersion: 27.0

XRSimulator27.0.sdk - Simulator - visionOS 27.0 (xrsimulator27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/XRSimulator.platform/Developer/SDKs/XRSimulator27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/XRSimulator.platform
BuildID: 03F050EE-A0FC-11F1-AD34-488FB93739A6
ProductBuildVersion: 24M361
ProductCopyright: 1983-2026 Apple Inc.
ProductName: xrOS
ProductVersion: 27.0
iOSSupportVersion: 27.0

WatchOS27.0.sdk - watchOS 27.0 (watchos27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform/Developer/SDKs/WatchOS27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform
BuildID: 8A5D5550-A2AF-11F1-89F4-E7B6EF0E3DA2
ProductBuildVersion: 24R360
ProductCopyright: 1983-2026 Apple Inc.
ProductName: Watch OS
ProductVersion: 27.0

WatchSimulator27.0.sdk - Simulator - watchOS 27.0 (watchsimulator27.0)
SDKVersion: 27.0
Path: /Applications/Xcode.app/Contents/Developer/Platforms/WatchSimulator.platform/Developer/SDKs/WatchSimulator27.0.sdk
PlatformVersion: 27.0
PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/WatchSimulator.platform
BuildID: 8A5D5550-A2AF-11F1-89F4-E7B6EF0E3DA2
ProductBuildVersion: 24R360
ProductCopyright: 1983-2026 Apple Inc.
ProductName: Watch OS
ProductVersion: 27.0

Xcode 27.0
Build version 27A266a
`;
const RAW_XCODE27_SHA256 = "ee1163bcd5132aa5851f1e834ffc2a16065f00c010458b007d35e67158253c87";
const RAW_XCODE27_FACTS = { version: "27.0", build: "27A266a", macosx_sdk: "27.0", iphonesimulator_sdk: "27.0" };

/** An Xcode's SDK inventory: the real one's blocks with this Xcode's SDK versions and path, and its own footer. */
function sdkInventory(app, x) {
  const blocks = RAW_XCODE27.split("\n\n");
  const sdks = blocks.slice(0, -1).map((b) => {
    const v = /\((macosx|driverkit)27\.0\)$/.test(b.split("\n")[0]) ? x.macosx : x.sim;
    return b.replaceAll("MacOSX27.sdk", `MacOSX${v.split(".")[0]}.sdk`).replaceAll("27.0", v).replaceAll("/Applications/Xcode.app", app);
  });
  return `${sdks.join("\n\n")}\n\nXcode ${x.version}\nBuild version ${x.build}\n`;
}

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
      // Each Xcode answers its own `xcodebuild -version -sdk` under its own
      // DEVELOPER_DIR, and nothing else: no other argv, no `xcrun --sdk`.
      if (app) {
        if (key !== `${app}/Contents/Developer/usr/bin/xcodebuild -version -sdk` || env.DEVELOPER_DIR !== `${app}/Contents/Developer`) return { status: 64, stdout: "", stderr: "" };
        return overrides.xcodebuild ? overrides.xcodebuild(app) : { status: 0, stdout: sdkInventory(app, xcodes[app]), stderr: "" };
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
  ["macos-xcode", "an xcodebuild in an unknown shape", { xcodebuild: () => ({ status: 0, stdout: "Xcode beta\n", stderr: "" }) }, /^Xcode\.app xcodebuild -version -sdk is truncated$/],
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

// ── 5b. timing diagnostics ──────────────────────────────────────────────────
//
// Two iOS UI jobs lost their certificate to "xcrun could not run: ETIMEDOUT"
// at the end of the 150 s budget, and that line cannot say which xcrun — an
// Xcode's SDK or a simctl listing — nor where the time went. Each capture now
// prints ONE timing line (stderr only): per-component time and calls, the
// three slowest call points and the failing call's applied bound. These checks
// drive the real realExec through a fake spawn and clock, so the bounds are
// the production ones and nothing real is spawned; section 5c meets real
// processes at the boundary. The certificate, its digest, every fact, the
// probe order and every old message stay exactly as they were.

const TIMING = typeof toolchainModule.probeTrace === "function" && typeof toolchainModule.timingSummary === "function";
const NOW = () => new Date("2026-10-01T14:20:00Z");
const timingLines = (text) => text.split("\n").filter((l) => l.startsWith("ci-evidence-toolchain: timing"));
const field = (line, name) => (new RegExp(` ${name}=([^ ]*)`).exec(line ?? "") ?? [])[1];

/** The mocked runner behind a fake spawnSync: each command takes cost(argv, env) ms of a fake clock, or times out at its bound. */
function fakeSpawn(profile, { costs = () => 10, overrides = {} } = {}) {
  const r = runner(osOf(profile), overrides);
  const clock = { t: 1_000_000 };
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const argv = [cmd, ...args];
    spawned.push({ argv, timeout: opts.timeout, maxBuffer: opts.maxBuffer });
    const cost = costs(argv, opts.env);
    if (cost > opts.timeout) {
      clock.t += opts.timeout;
      return { error: Object.assign(new Error(`spawnSync ${cmd} ETIMEDOUT`), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "", stderr: "" };
    }
    clock.t += cost;
    let res;
    try { res = r.exec(argv, opts.env, opts.input); } catch { return { error: Object.assign(new Error("EINVAL"), { code: "EINVAL" }), status: null, signal: null, stdout: "", stderr: "" }; }
    if (res.status === 127 && res.stdout === "") return { error: Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" }), status: null, signal: null, stdout: "", stderr: "" };
    return { status: res.status, signal: null, stdout: res.stdout, stderr: res.stderr };
  };
  return { r, spawn, spawned, clock: () => clock.t };
}

/** main() with its stderr captured. */
function mainOut(argv, env, deps) {
  const chunks = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code;
  try { code = main(argv, env, deps); } finally { process.stderr.write = write; }
  return { code, text: chunks.join("") };
}

const depsOf = (f) => ({ registry: REGISTRY, readFile: f.r.readFile, exists: f.r.exists, listDir: f.r.listDir, realpath: f.r.realpath, now: NOW,
  resolveChrome: f.r.resolveChrome, digestFile: f.r.digestFile, spawn: f.spawn, clock: f.clock });

// The cost of each call point on the fake runner. The default macOS inventory
// discovers Xcode.app (→ Xcode_26.0.1, ordinal 1) before Xcode_16.4 (ordinal 2);
// each Xcode is one `xcodebuild -version -sdk` call.
const MAC_COSTS = ({ inventory = 10, inventory1, inventory16, devices = 10, runtimes = 10, python = 10 } = {}) => (argv) => {
  const k = argv.join(" ");
  if (/\/usr\/bin\/xcodebuild -version -sdk$/.test(k)) {
    if (inventory1 !== undefined && k.includes("Xcode_26.0.1")) return inventory1;
    if (inventory16 !== undefined && k.includes("Xcode_16.4")) return inventory16;
    return inventory;
  }
  if (k === "xcrun simctl list devices available -j") return devices;
  if (k === "xcrun simctl list runtimes -j") return runtimes;
  if (argv[1] === "-c") return python;
  return 10;
};

// Four installs (the hosted image has more): one inventory call each, so
// 4 x 25 s spends two thirds of the budget before the destination component.
const XCODES4 = { ...XCODES,
  "/Applications/Xcode_15.4.app": { version: "15.4", build: "15F31d", macosx: "14.5", sim: "17.5" },
  "/Applications/Xcode_26.1.app": { version: "26.1", build: "17B55", macosx: "26.1", sim: "26.1" } };

const CAPTURE = (profile, lane = "go", job = "test") => ["capture", "--role", "source", "--profile", profile, "--out", "OUT", "--lane", lane, "--job", job];

function scenario(name, profile, costs, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-toolchain-timing-"));
  try {
    const f = fakeSpawn(profile, { costs, overrides });
    const out = join(dir, "toolchain.json");
    const argv = CAPTURE(profile).map((a) => (a === "OUT" ? out : a));
    const { code, text } = mainOut(argv, f.r.env, depsOf(f));
    let written = null;
    try { written = readFileSync(out, "utf8"); } catch { /* none */ }
    return { name, f, code, text, written, lines: timingLines(text), warning: text.split("\n").find((l) => l.startsWith("::warning::")) ?? null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const TIMING_SCENARIOS = [
  "an instrumented capture is the same certificate, probe order and bounds",
  "a successful capture prints one timing line with its components and slowest call points",
  "a budget-remainder timeout in a simctl listing is named with its bound",
  "a per-command timeout in one Xcode's SDK is named by ordinal",
  "a remaining budget equal to the command bound is per-command",
  "an exhausted budget names the call it refused",
  "a refusal after a successful call names its component",
  "private paths, argv and environment never reach the timing line",
  "a forged trace or an unregistered profile cannot inject into the line",
  "each current profile has its own budget and timing line",
];
if (!TIMING) {
  for (const name of TIMING_SCENARIOS) check(false, `timing: ${name} — the probe has no timing trace (probeTrace/timingSummary not exported)`);
}

// Through main with the mocked exec (a seam the old CLI already had): one timing line per capture, success or not.
{
  const r = runner("Linux");
  const deps = { registry: REGISTRY, exec: r.exec, readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath, now: NOW,
    resolveChrome: r.resolveChrome, digestFile: r.digestFile };
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-toolchain-timing-"));
  const ok = mainOut(["capture", "--role", "source", "--profile", "linux-go", "--out", join(dir, "a.json"), "--lane", "go", "--job", "test"], r.env, deps);
  const okLines = timingLines(ok.text);
  check(ok.code === 0 && okLines.length === 1 && field(okLines[0], "outcome") === "certificate" && field(okLines[0], "profile") === "linux-go"
    && field(okLines[0], "role") === "source" && /^image:0:\d+,go:4:\d+$/.test(field(okLines[0], "components") ?? ""),
  `a successful capture must print exactly one timing line naming its profile and components: ${JSON.stringify(okLines)}`);
  const bad = runner("Linux", { status: { "go version": 2 } });
  const no = mainOut(["capture", "--role", "current", "--profile", "linux-go", "--out", join(dir, "b.json")], bad.env, { ...deps, exec: bad.exec });
  const noLines = timingLines(no.text);
  check(no.code === 0 && no.text.includes("::warning::ci-evidence-toolchain: no current certificate: go version exited 2\n") && noLines.length === 1
    && field(noLines[0], "outcome") === "no-certificate" && field(noLines[0], "role") === "current" && field(noLines[0], "failure") === "go.refused",
  `an unknown capture must keep its warning and print exactly one timing line naming the refusing component: ${JSON.stringify(noLines)}`);
  rmSync(dir, { recursive: true, force: true });
}

if (TIMING) {
  const { probeTrace, timingSummary } = toolchainModule;

  part("instrumented identity", () => {
    // Every profile, both roles: the capture through realExec + trace is byte for
    // byte the plain capture, runs the same argv in the same order, under the
    // production bounds.
    for (const profile of Object.keys(REGISTRY.profiles)) {
      for (const role of ["source", "current"]) {
        const plainRunner = runner(osOf(profile));
        const plain = capture({ registry: REGISTRY, profileName: profile, role, laneId: "go", jobId: "test", env: plainRunner.env, exec: plainRunner.exec,
          readFile: plainRunner.readFile, exists: plainRunner.exists, listDir: plainRunner.listDir, realpath: plainRunner.realpath, now: NOW,
          resolveChrome: plainRunner.resolveChrome, digestFile: plainRunner.digestFile, root: repoRoot });
        const f = fakeSpawn(profile);
        const trace = probeTrace(f.clock);
        const traced = capture({ registry: REGISTRY, profileName: profile, role, laneId: "go", jobId: "test", env: f.r.env,
          exec: realExec(undefined, { trace, spawn: f.spawn, clock: f.clock }), readFile: f.r.readFile, exists: f.r.exists, listDir: f.r.listDir,
          realpath: f.r.realpath, now: NOW, resolveChrome: f.r.resolveChrome, digestFile: f.r.digestFile, root: repoRoot, trace });
        check(JSON.stringify(traced, null, 2) === JSON.stringify(plain, null, 2) && traced.digest === plain.digest,
          `${profile}/${role}: the traced certificate differs from the plain one`);
        check(JSON.stringify(f.spawned.map((s) => s.argv)) === JSON.stringify(plainRunner.calls.map((c) => c.argv)),
          `${profile}/${role}: the traced capture ran other commands or another order`);
        check(f.spawned.every((s) => s.timeout === Math.min(30_000, 150_000 - 10 * f.spawned.indexOf(s))
          && s.maxBuffer === (s.argv[0] === "xcrun" ? 4 * 1024 * 1024 : 64 * 1024)),
        `${profile}/${role}: a command ran under other bounds than 30 s / the remaining 150 s budget and 64 KiB / 4 MiB`);
        check(trace.calls === f.spawned.length && Object.values(trace.components).reduce((n, c) => n + c.calls, 0) === f.spawned.length,
          `${profile}/${role}: the trace counted ${trace.calls} calls for ${f.spawned.length} commands`);
      }
    }
    check(PROBE_LIMITS.commandMs === 30_000 && PROBE_LIMITS.totalMs === 150_000 && PROBE_LIMITS.outputBytes === 64 * 1024
      && PROBE_LIMITS.listingBytes === 4 * 1024 * 1024 && Object.isFrozen(PROBE_LIMITS), "the probe's production bounds changed");
  });

  part("success line", () => {
    const s = scenario("success", "macos-xcode-iphone", MAC_COSTS({ inventory1: 5000, inventory16: 7000, devices: 9000 }));
    const plain = JSON.stringify(certFor("macos-xcode-iphone"), null, 2);
    check(s.code === 0 && s.written === `${plain}\n`, "the timed capture command did not write the plain certificate byte for byte");
    check(s.lines.length === 1 && s.text.includes(`ci-evidence-toolchain: source macos-xcode-iphone certificate ${JSON.parse(plain).digest}\n`),
      `want the unchanged certificate line and exactly one timing line: ${JSON.stringify(s.text)}`);
    const l = s.lines[0];
    check(field(l, "outcome") === "certificate" && field(l, "profile") === "macos-xcode-iphone" && field(l, "failure") === "-"
      && field(l, "calls") === "9" && field(l, "wall_ms") === "21060" && field(l, "budget_ms") === "150000" && field(l, "budget_left_ms") === "128940"
      && field(l, "components") === "image:2:20,xcode:3:12010,destination:4:9030"
      && field(l, "slowest") === "destination.simctl-devices:9000:ok,xcode.xcodebuild-sdk-inventory#2:7000:ok,xcode.xcodebuild-sdk-inventory#1:5000:ok",
    `the success line does not account for the capture's time: ${l}`);
  });

  part("simctl budget remainder", () => {
    // About the observed shape: the inventory takes most of the budget and a
    // listing meets the remainder. Old line: generic; new line: which and how.
    const s = scenario("simctl", "macos-xcode-iphone", MAC_COSTS({ inventory: 25_000, devices: 29_000, runtimes: 25_000 }), { xcodes: XCODES4 });
    check(s.code === 0 && s.written === null && s.warning === "::warning::ci-evidence-toolchain: no source certificate: xcrun could not run: ETIMEDOUT",
      `a timed-out listing must keep the old unknown: no certificate, exit 0, the same warning: ${s.warning}`);
    check(s.lines.length === 1 && field(s.lines[0], "outcome") === "no-certificate"
      && field(s.lines[0], "failure") === "destination.simctl-runtimes:timeout:elapsed_ms=20970:applied_ms=20970:bound=budget-remainder:budget_before_ms=20970:budget_after_ms=0"
      && field(s.lines[0], "components") === "image:2:20,xcode:5:100010,destination:2:49970" && field(s.lines[0], "wall_ms") === "150000",
    `the timed-out simctl runtimes listing is not named with its bound: ${s.lines[0]}`);
    const runtimes = s.f.spawned.filter((x) => x.argv.join(" ") === "xcrun simctl list runtimes -j");
    check(runtimes.length === 1 && s.f.spawned.at(-1) === runtimes[0], "a timed-out command was retried, or the probe went on after it");
  });

  part("sdk per-command", () => {
    const s = scenario("sdk", "macos-xcode-iphone", MAC_COSTS({ inventory16: 40_000 }));
    const simctl = scenario("simctl", "macos-xcode-iphone", MAC_COSTS({ inventory: 25_000, devices: 29_000, runtimes: 25_000 }), { xcodes: XCODES4 });
    // realExec names the program that could not run, as it always has: here that Xcode's own xcodebuild.
    check(s.written === null && s.warning === "::warning::ci-evidence-toolchain: no source certificate: /Applications/Xcode_16.4.app/Contents/Developer/usr/bin/xcodebuild could not run: ETIMEDOUT",
      `an SDK inventory timeout must be the usual could-not-run unknown: ${s.warning}`);
    check(field(s.lines[0], "failure") === "xcode.xcodebuild-sdk-inventory#2:timeout:elapsed_ms=30000:applied_ms=30000:bound=per-command:budget_before_ms=149970:budget_after_ms=119970",
      `the Xcode SDK timeout is not named by call point, ordinal and bound: ${s.lines[0]}`);
    check(field(s.lines[0], "failure") !== field(simctl.lines[0], "failure"), "the timing line cannot tell an SDK timeout from a simctl one");
    // With most of the budget left, a timed-out command is still not retried, and nothing runs after it.
    const inv = s.f.spawned.filter((x) => x.argv.join(" ") === "/Applications/Xcode_16.4.app/Contents/Developer/usr/bin/xcodebuild -version -sdk");
    check(inv.length === 1 && s.f.spawned.at(-1) === inv[0] && field(s.lines[0], "calls") === "4",
      "a timed-out command with budget left was retried, or the probe went on after it");
  });

  part("tie", () => {
    const s = scenario("tie", "macos-xcode-iphone", MAC_COSTS({ inventory: 25_000, devices: 19_970, runtimes: 40_000 }), { xcodes: XCODES4 });
    check(/^destination\.simctl-runtimes:timeout:elapsed_ms=30000:applied_ms=30000:bound=per-command:budget_before_ms=30000:/.test(field(s.lines[0], "failure") ?? ""),
      `a remaining budget exactly equal to the 30 s bound must be per-command: ${s.lines[0]}`);
  });

  part("exhausted", () => {
    const s = scenario("exhausted", "macos-xcode-iphone", MAC_COSTS({ inventory: 25_000, devices: 29_000, runtimes: 20_970 }), { xcodes: XCODES4 });
    check(s.written === null && s.warning === "::warning::ci-evidence-toolchain: no source certificate: the probe ran out of its time budget"
      && field(s.lines[0], "failure") === "destination.selection-program:budget-exhausted:elapsed_ms=0:applied_ms=0:budget_before_ms=0:budget_after_ms=0"
      && field(s.lines[0], "budget_left_ms") === "0",
    `an exhausted budget must keep its message and name the refused call: ${s.warning} / ${s.lines[0]}`);
    check(!s.f.spawned.some((x) => x.argv[1] === "-c"), "a command was spawned with no budget left");
  });

  part("refusal", () => {
    const s = scenario("refusal", "macos-xcode-iphone", MAC_COSTS(), { xcodebuild: () => ({ status: 0, stdout: "Xcode beta\n", stderr: "" }) });
    check(s.written === null && s.warning === "::warning::ci-evidence-toolchain: no source certificate: Xcode.app xcodebuild -version -sdk is truncated"
      && field(s.lines[0], "failure") === "xcode.refused:last=xcode.xcodebuild-sdk-inventory#1:ok",
    `a parse refusal must keep its message and name the component and its last call: ${s.lines[0]}`);
    const exit = scenario("exit", "macos-xcode-iphone", MAC_COSTS(), { status: { "xcrun simctl list devices available -j": 1 } });
    check(/simctl list devices available -j exited 1$/.test(exit.warning ?? "") && field(exit.lines[0], "failure") === "destination.refused:last=destination.simctl-devices:exit:1",
      `a nonzero exit must keep its message and name its call: ${exit.lines[0]}`);
  });

  part("privacy", () => {
    // Canaries in a private Xcode path (which the old message prints, unchanged),
    // in the environment, in DEVELOPER_DIR and in the C compiler command.
    const canary = "CANARY7q";
    const xcodes = { [`/Applications/Xcode_${canary}.app`]: { version: "26.0.1", build: "17A400", macosx: "26.0", sim: "26.0" } };
    const priv = scenario("private Xcode", "macos-xcode-go", MAC_COSTS({ inventory: 40_000 }), {
      xcodes, realpaths: { [`/Applications/Xcode_${canary}.app`]: `/Users/owner-${canary}/Private/Xcode_${canary}.app` },
      env: { SECRET_TOKEN: `tok-${canary}`, DEVELOPER_DIR: `/Users/owner-${canary}/Private/Xcode_${canary}.app/Contents/Developer` },
      out: { "go env CGO_ENABLED CC": `1\nclang-${canary} --sysroot=/Users/owner-${canary}\n` },
    });
    check(priv.warning?.includes(canary) && field(priv.lines[0], "failure")?.startsWith("xcode.xcodebuild-sdk-inventory#1:timeout:"),
      `the private-path scenario did not time out in the private Xcode (it must, to test the line): ${priv.warning} / ${priv.lines[0]}`);
    const cc = scenario("private CC", "macos-xcode-go", MAC_COSTS({ inventory: 10 }), {
      env: { SECRET_TOKEN: `tok-${canary}` }, out: { "go env CGO_ENABLED CC": `1\nclang-${canary} --sysroot=/Users/owner-${canary}\n` },
    });
    for (const s of [priv, cc]) {
      check(s.lines.length === 1 && !/[/\\%]|canary|import json|Xcode_|Users|tok-/i.test(s.lines[0]),
        `${s.name}: the timing line carries a path, argv, program or environment value: ${s.lines[0]}`);
    }
  });

  part("injection", () => {
    const forged = probeTrace(() => 0);
    forged.top = [{ component: "xcode", op: "sdk-macosx\n::error::x", ordinal: 0, ms: 1, outcome: "ok" }];
    check(timingSummary(forged, { role: "source", profile: "linux-go", registry: REGISTRY, outcome: "certificate" }) === "ci-evidence-toolchain: timing unavailable",
      "a line with a line end or a workflow command in it was printed");
    forged.top = [{ component: "xcode", op: "sdk%0A", ordinal: 0, ms: 1, outcome: "ok" }];
    check(timingSummary(forged, { role: "source", profile: "linux-go", registry: REGISTRY, outcome: "certificate" }) === "ci-evidence-toolchain: timing unavailable",
      "a line with a percent escape in it was printed");
    const clean = probeTrace(() => 0);
    for (const profile of ["linux-go%0A::warning::x", "linux-nope", "../linux-go", "Linux-Go"]) {
      check(field(timingSummary(clean, { role: "source", profile, registry: REGISTRY, outcome: "certificate" }), "profile") === "unregistered",
        `the unregistered profile ${JSON.stringify(profile)} was printed`);
    }
    check(field(timingSummary(clean, { role: "witness", profile: "linux-go", registry: REGISTRY, outcome: "certificate" }), "role") === "unknown",
      "an unknown role was printed");
    const f = fakeSpawn("linux-go");
    const { text } = mainOut(["capture", "--role", "source", "--profile", "linux-go%0A::warning::x", "--out", join(tmpdir(), "never-written.json"), "--lane", "go", "--job", "test"],
      f.r.env, depsOf(f));
    check(timingLines(text).length === 1 && field(timingLines(text)[0], "profile") === "unregistered", `an unregistered CLI profile reached the timing line: ${text}`);
  });

  part("current budgets", () => {
    // Two current profiles in one run: the first times out at its budget's end;
    // the second starts with a whole new budget and its own trace.
    const dir = mkdtempSync(join(tmpdir(), "ci-evidence-toolchain-timing-"));
    const f = fakeSpawn("macos-xcode-iphone", { costs: MAC_COSTS({ inventory: 25_000, devices: 29_000, runtimes: 25_000 }), overrides: { xcodes: XCODES4 } });
    const { code, text } = mainOut(["current", "--profiles", "macos-xcode-iphone,macos-xcode", "--dir", dir], f.r.env, depsOf(f));
    const lines = timingLines(text);
    let files = [];
    try { files = readdirSync(dir).sort(); } catch { /* none */ }
    check(code === 0 && lines.length === 2 && JSON.stringify(files) === JSON.stringify(["macos-xcode.json"]),
      `want two timing lines and only the second profile's certificate: ${JSON.stringify(files)} ${JSON.stringify(lines)}`);
    check(field(lines[0], "profile") === "macos-xcode-iphone" && field(lines[0], "outcome") === "no-certificate" && field(lines[0], "budget_left_ms") === "0"
      && field(lines[1], "profile") === "macos-xcode" && field(lines[1], "outcome") === "certificate" && field(lines[1], "role") === "current"
      && field(lines[1], "budget_left_ms") === "49970" && field(lines[1], "calls") === "7" && field(lines[1], "wall_ms") === "100030",
    `the second profile did not get its own budget and trace: ${JSON.stringify(lines)}`);
    rmSync(dir, { recursive: true, force: true });
  });
}

// ── 5c. timing at the real process boundary ─────────────────────────────────
// Real child processes, all finite (the slowest is cut at 100 ms).
if (TIMING) {
  const { probeTrace } = toolchainModule;
  const at = (component, op) => { const t = probeTrace(); t.current = { component, op, ordinal: 0 }; return t; };
  part("real boundary", () => {
    const slowTrace = at("destination", "simctl-runtimes");
    const slow = threw(() => realExec({ left: 100 }, { trace: slowTrace })(["sleep", "2"]));
    check(slow instanceof ToolchainUnknown && slow.message === "sleep could not run: ETIMEDOUT" && slowTrace.failure?.outcome === "timeout"
      && slowTrace.failure.applied === 100 && slowTrace.failure.op === "simctl-runtimes" && slowTrace.failure.ms >= 90,
    `a real timeout was not traced with its applied bound: ${slow?.message} ${JSON.stringify(slowTrace.failure)}`);
    const bufTrace = at("go", "go-version");
    const buf = threw(() => realExec(undefined, { trace: bufTrace })([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"]));
    check(buf instanceof ToolchainUnknown && / could not run: ENOBUFS$/.test(buf.message) && bufTrace.failure?.outcome === "enobufs",
      `real output past its cap was not refused and traced: ${buf?.message} ${JSON.stringify(bufTrace.failure)}`);
    const sigTrace = at("image", "sw-vers-product");
    const sig = realExec(undefined, { trace: sigTrace })(["/bin/sh", "-c", "kill -TERM $$"]);
    check(sig.status === null && sigTrace.last?.outcome === "signal:SIGTERM" && sigTrace.failure === null,
      `a real signal death was not traced as one (status ${sig.status}, ${JSON.stringify(sigTrace.last)})`);
    const goneTrace = at("go", "cc-version");
    check(realExec(undefined, { trace: goneTrace })(["definitely-not-a-command-xyz"]).status === 127 && goneTrace.last?.outcome === "enoent" && goneTrace.failure === null,
      "a missing command is not still 127, traced as enoent");
    const exitTrace = at("go", "cc-target");
    check(realExec(undefined, { trace: exitTrace })(["/bin/sh", "-c", "exit 3"]).status === 3 && exitTrace.last?.outcome === "exit:3",
      "a real nonzero exit is not returned and traced");
    let spawned = 0;
    const zeroTrace = at("xcode", "sdk-macosx");
    const zero = threw(() => realExec({ left: 0 }, { trace: zeroTrace, spawn: () => { spawned += 1; return { status: 0 }; } })(["true"]));
    check(zero instanceof ToolchainUnknown && /time budget/.test(zero.message) && spawned === 0 && zeroTrace.failure?.outcome === "budget-exhausted",
      "a zero budget spawned something, or was not traced");
  });
}

// ── 5d. one SDK inventory per Xcode ─────────────────────────────────────────
//
// Each installed Xcode is asked ONCE — its own `usr/bin/xcodebuild -version
// -sdk` — where it was `xcodebuild -version` plus two `xcrun --sdk …
// --show-sdk-version`. The certificate's facts and bytes do not change
// (section 1 and the instrumented identity compare whole certificates, the
// mocks now answering only the inventory). These checks hold the parser to the
// one grammar a real Xcode printed (RAW_XCODE27) and refuse everything else.

const parseSdkInventory = toolchainModule.parseSdkInventory;
const INVENTORY = typeof parseSdkInventory === "function";
if (!INVENTORY) check(false, "the probe has no SDK inventory parser (parseSdkInventory not exported)");
// The three old queries' raw answers on the same installation (receipts, sha256 checked).
const OLD_RECEIPTS = { version: ["Xcode 27.0\nBuild version 27A266a\n", "694b44731d0b415c5b11d844151e466d7f5e200a95627efda377f232f1a6ab77"],
  sdk: ["27.0\n", "7b01c549928398a045692f24bcac7803b348524cdd76f21265b02984b2ba556a"] };
const cp = (n) => String.fromCodePoint(n);
const RAW_BLOCKS = RAW_XCODE27.split("\n\n");
const rawWith = (blocks) => `${blocks.join("\n\n")}\n\n${RAW_BLOCKS.at(-1)}`;
const sdkBlocks = () => RAW_BLOCKS.slice(0, -1);
const familyOf = (b) => /\(([a-z]+)[0-9.]+\)$/.exec(b.split("\n")[0])[1];
const editBlock = (family, edit, nth = 0) => {
  let seen = -1;
  return rawWith(sdkBlocks().map((b) => (familyOf(b) === family && ++seen === nth ? edit(b) : b)));
};
const parsed = (text) => { try { return parseSdkInventory(text, "Xcode_T.app"); } catch (err) { return err; } };
const refused = (text, re) => { const r = parsed(text); return r instanceof ToolchainUnknown && re.test(r.message); };

if (INVENTORY) {
  part("inventory raw", () => {
    check(createHashHex(RAW_XCODE27) === RAW_XCODE27_SHA256 && Buffer.byteLength(RAW_XCODE27) === 4951,
      "RAW_XCODE27 is not the real Xcode 27 inventory byte for byte");
    const facts = parsed(RAW_XCODE27);
    check(canonical(facts) === canonical(RAW_XCODE27_FACTS), `the real Xcode 27 inventory did not parse to its facts: ${facts?.message ?? canonical(facts)}`);
    check(createHashHex(OLD_RECEIPTS.version[0]) === OLD_RECEIPTS.version[1] && createHashHex(OLD_RECEIPTS.sdk[0]) === OLD_RECEIPTS.sdk[1]
      && `Xcode ${facts.version}\nBuild version ${facts.build}\n` === OLD_RECEIPTS.version[0]
      && `${facts.macosx_sdk}\n` === OLD_RECEIPTS.sdk[0] && `${facts.iphonesimulator_sdk}\n` === OLD_RECEIPTS.sdk[0],
    "the inventory's facts are not exactly what the three old queries answered on the same Xcode");
    // The two macOS blocks (MacOSX27.sdk and MacOSX27.0.sdk) are both there and agree.
    check(sdkBlocks().filter((b) => familyOf(b) === "macosx").length === 2, "the real inventory no longer has its two macOS SDK blocks");
  });

  part("inventory capture", () => {
    // The real text through capture: one Xcode answering RAW_XCODE27 verbatim
    // certifies byte for byte like the grammar-derived mock of the same facts.
    const x27 = { "/Applications/Xcode_27.0.app": { version: "27.0", build: "27A266a", macosx: "27.0", sim: "27.0" } };
    const o = { xcodes: x27, out: { "xcode-select -p": "/Applications/Xcode_27.0.app/Contents/Developer\n" } };
    const viaRaw = certFor("macos-xcode", { ...o, xcodebuild: () => ({ status: 0, stdout: RAW_XCODE27, stderr: "" }) });
    const viaMock = certFor("macos-xcode", o);
    check(JSON.stringify(viaRaw, null, 2) === JSON.stringify(viaMock, null, 2)
      && canonical(viaRaw.toolchain.xcode.installed) === canonical([{ app: "/Applications/Xcode_27.0.app", ...RAW_XCODE27_FACTS }]),
    `the real inventory and the mocked one of the same facts certify differently: ${canonical(viaRaw.toolchain.xcode)}`);
    // One call per real install (the Xcode.app alias asked once), through that
    // install's own xcodebuild under its own DEVELOPER_DIR; no `xcrun --sdk`.
    const r = runner("macOS");
    capture({ registry: REGISTRY, profileName: "macos-xcode", role: "source", laneId: "go", jobId: "test", env: r.env, exec: r.exec,
      readFile: r.readFile, exists: r.exists, listDir: r.listDir, realpath: r.realpath, now: NOW, resolveChrome: r.resolveChrome, digestFile: r.digestFile, root: repoRoot });
    const xc = r.calls.filter((c) => /xcodebuild|^xcrun$|xcode-select/.test(c.argv[0]))
      .map((c) => `${c.argv.join(" ")} @${c.env.DEVELOPER_DIR}`);
    check(JSON.stringify(xc) === JSON.stringify([
      "/Applications/Xcode_26.0.1.app/Contents/Developer/usr/bin/xcodebuild -version -sdk @/Applications/Xcode_26.0.1.app/Contents/Developer",
      "/Applications/Xcode_16.4.app/Contents/Developer/usr/bin/xcodebuild -version -sdk @/Applications/Xcode_16.4.app/Contents/Developer",
      "xcode-select -p @"]), `the Xcode inventory ran other commands than one own-xcodebuild inventory per install: ${JSON.stringify(xc)}`);
    for (const profile of Object.keys(REGISTRY.profiles)) {
      const { calls } = traced(profile);
      check(!calls.some((a) => a[0] === "xcrun" && a[1] === "--sdk"), `${profile} still asks xcrun --sdk`);
    }
    // Each install's facts come from its own inventory, never another's.
    const per = certFor("macos-xcode").toolchain.xcode.installed;
    check(canonical(per) === canonical([
      { app: "/Applications/Xcode_16.4.app", version: "16.4", build: "16F6", macosx_sdk: "15.5", iphonesimulator_sdk: "18.5" },
      { app: "/Applications/Xcode_26.0.1.app", version: "26.0.1", build: "17A400", macosx_sdk: "26.0", iphonesimulator_sdk: "26.0" }]),
    `two installs' inventories were mixed: ${canonical(per)}`);
    // Through capture: an inventory carrying a second Xcode's footer line is unknown, named by the install asked.
    const crossed = threw(() => certFor("macos-xcode", { xcodebuild: (app) => (app.includes("16.4")
      ? { status: 0, stdout: sdkInventory(app, { version: "16.4", build: "16F6", macosx: "15.5", sim: "26.0" }).replace("\nXcode 16.4\n", "\nXcode 16.4\nXcode 26.0.1\n"), stderr: "" }
      : { status: 0, stdout: sdkInventory(app, XCODES[app]), stderr: "" }) }));
    check(crossed instanceof ToolchainUnknown && /^Xcode_16\.4\.app xcodebuild -version -sdk has an unrecognised line where an SDK block starts/.test(crossed.message),
      `an inventory carrying a second Xcode's footer was not refused: ${crossed?.message ?? "a certificate"}`);
  });

  part("inventory refusals", () => {
    const sim = (edit) => editBlock("iphonesimulator", edit);
    const over = (n) => rawWith([...Array.from({ length: n }, () => sdkBlocks()[1]), ...sdkBlocks()]);
    let under = 1;
    while (Buffer.byteLength(over(under + 1)) <= PROBE_LIMITS.outputBytes) under += 1;
    const cases = [
      ["no footer", RAW_XCODE27.slice(0, RAW_XCODE27.indexOf("Xcode 27.0\n")), /does not end with the Xcode version footer$/],
      ["no build line", RAW_XCODE27.replace("\nBuild version 27A266a\n", "\n"), /does not end with the Xcode version footer$/],
      ["a footer twice", `${RAW_XCODE27}Xcode 27.0\nBuild version 27A266a\n`, /unrecognised line where an SDK block starts \(line 123\)$/],
      ["text after the footer", `${RAW_XCODE27}note\n`, /does not end with the Xcode version footer$/],
      ["text before the first SDK", `note\n${RAW_XCODE27}`, /unrecognised line where an SDK block starts \(line 1\)$/],
      ["an Xcode beta footer", RAW_XCODE27.replace("Xcode 27.0\nBuild", "Xcode beta\nBuild"), /does not end with the Xcode version footer$/],
      ["a footer with a trailing space", RAW_XCODE27.replace("27A266a\n", "27A266a \n"), /does not end with the Xcode version footer$/],
      ["a footer without its line end", RAW_XCODE27.slice(0, -1), /does not end with a line end$/],
      ["CRLF line ends", RAW_XCODE27.replaceAll("\n", "\r\n"), /has a byte outside printable ASCII and LF$/],
      ...[0x00, 0x09, 0x0b, 0x1b, 0x7f, 0x85, 0x2028, 0xff0d].map((c) => [`U+${c.toString(16).padStart(4, "0")} in a value`,
        RAW_XCODE27.replace("ProductName: iPhone OS", `ProductName: iPhone${cp(c)}OS`), /has a byte outside printable ASCII and LF$/]),
      ["no iphonesimulator SDK", rawWith(sdkBlocks().filter((b) => familyOf(b) !== "iphonesimulator")), /lists no iphonesimulator SDK$/],
      ["no macosx SDK", rawWith(sdkBlocks().filter((b) => familyOf(b) !== "macosx")), /lists no macosx SDK$/],
      ["two macosx SDK versions", editBlock("macosx", (b) => b.replace("SDKVersion: 27.0", "SDKVersion: 27.1")), /lists the macosx SDK at two different versions$/],
      ["two iphonesimulator SDK versions", rawWith([...sdkBlocks(), sdkBlocks()[2].replace("SDKVersion: 27.0", "SDKVersion: 26.5")]), /lists the iphonesimulator SDK at two different versions$/],
      ["two appletvos SDK versions", rawWith([...sdkBlocks(), sdkBlocks()[5].replace("SDKVersion: 27.0", "SDKVersion: 26.0")]), /lists the appletvos SDK at two different versions$/],
      ["a repeated SDKVersion", sim((b) => b.replace("SDKVersion: 27.0\n", "SDKVersion: 27.0\nSDKVersion: 27.0\n")), /repeats SDKVersion in one SDK block/],
      ["a repeated Path", sim((b) => b.replace("\nPlatformVersion", `\n${b.split("\n")[2]}\nPlatformVersion`)), /repeats Path in one SDK block/],
      ["a repeated optional key", sim((b) => b.replace("\nProductVersion: 27.0", "\nProductVersion: 27.0\nProductVersion: 27.0")), /repeats ProductVersion in one SDK block/],
      ["no SDKVersion", sim((b) => b.replace("SDKVersion: 27.0\n", "")), /has an SDK block without SDKVersion$/],
      ["no PlatformPath", editBlock("driverkit", (b) => b.split("\n").slice(0, -1).join("\n")), /has an SDK block without PlatformPath$/],
      ["an unknown key", sim((b) => `${b}\nSDKFlavor: plain`), /unrecognised line in an SDK block/],
      ["a key out of order", sim((b) => { const l = b.split("\n"); [l[1], l[2]] = [l[2], l[1]]; return l.join("\n"); }), /has SDKVersion out of its order/],
      ["an optional key out of order", editBlock("macosx", (b) => b.replace("ProductUserVisibleVersion: 27.0\nProductVersion: 27.0", "ProductVersion: 27.0\nProductUserVisibleVersion: 27.0")), /has ProductUserVisibleVersion out of its order/],
      ["an SDKVersion without a minor", sim((b) => b.replace("SDKVersion: 27.0", "SDKVersion: 27")), /has a SDKVersion in an unrecognised shape/],
      ["an SDKVersion with a suffix", sim((b) => b.replace("SDKVersion: 27.0", "SDKVersion: 27.0b1")), /has a SDKVersion in an unrecognised shape/],
      ["a relative Path", sim((b) => b.replace("Path: /", "Path: ")), /has a Path in an unrecognised shape/],
      ["a ProductName past its 200 characters", sim((b) => b.replace("ProductName: iPhone OS", `ProductName: ${"x".repeat(201)}`)), /has a ProductName in an unrecognised shape/],
      ["an empty value", sim((b) => b.replace("ProductName: iPhone OS", "ProductName: ")), /unrecognised line in an SDK block/],
      ["no blank line before the footer", RAW_XCODE27.replace("\n\nXcode 27.0\n", "\nXcode 27.0\n"), /is truncated inside an SDK block$/],
      ["a doubled blank line", RAW_XCODE27.replace("\n\n", "\n\n\n"), /unrecognised line where an SDK block starts \(line 7\)$/],
      ["two blocks run together", RAW_XCODE27.replace("PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/DriverKit.platform\n\n", "PlatformPath: /Applications/Xcode.app/Contents/Developer/Platforms/DriverKit.platform\n"), /unrecognised line in an SDK block \(line 6\)$/],
      ["a header with no canonical identity", RAW_XCODE27.replace(" (iphonesimulator27.0)", ""), /unrecognised line where an SDK block starts/],
      ["a header with an upper-case family", RAW_XCODE27.replace("(iphonesimulator27.0)", "(iPhoneSimulator27.0)"), /unrecognised line where an SDK block starts/],
      ["an empty output", "", /does not end with a line end$/],
      ["only a footer", "Xcode 27.0\nBuild version 27A266a\n", /is truncated$/],
      ["an output past the 64 KiB cap", over(under + 1), /is above its output cap$/],
    ];
    for (const [what, text, re] of cases) {
      const r = parsed(text);
      check(r instanceof ToolchainUnknown && re.test(r.message) && r.message.startsWith("Xcode_T.app xcodebuild -version -sdk ")
        && !/\/Applications|\/Users|Platforms/.test(r.message),
      `an SDK inventory with ${what} was not refused as ${re}: ${r instanceof Error ? r.message : canonical(r)}`);
    }
    check(parsed(undefined) instanceof ToolchainUnknown && parsed(undefined).message === "Xcode_T.app xcodebuild -version -sdk is not text", "a missing inventory output was not refused");
    // The cap is the command's own 64 KiB, not something smaller: just under it parses.
    check(canonical(parsed(over(under))) === canonical(RAW_XCODE27_FACTS) && Buffer.byteLength(over(under)) <= PROBE_LIMITS.outputBytes,
      "an inventory just under the 64 KiB output cap was refused");
    // Every truncation of the real output is refused: no prefix of it is a complete inventory.
    let prefixes = 0;
    for (let k = 0; k < RAW_XCODE27.length; k += 1) if (parsed(RAW_XCODE27.slice(0, k)) instanceof ToolchainUnknown) prefixes += 1;
    check(prefixes === RAW_XCODE27.length, `${RAW_XCODE27.length - prefixes} truncations of the real inventory were accepted`);
  });

  part("inventory admits", () => {
    // What the grammar admits on purpose: the facts these yield.
    const sim = (edit) => editBlock("iphonesimulator", edit);
    for (const [what, text, want] of [
      // The version is ONLY the block's SDKVersion — never its header or file name.
      ["an iphonesimulator SDKVersion that differs from its header", sim((b) => b.replace("SDKVersion: 27.0", "SDKVersion: 26.5")), { ...RAW_XCODE27_FACTS, iphonesimulator_sdk: "26.5" }],
      ["a three-part SDKVersion", sim((b) => b.replace("SDKVersion: 27.0", "SDKVersion: 27.0.1")), { ...RAW_XCODE27_FACTS, iphonesimulator_sdk: "27.0.1" }],
      // The family is ONLY the header's canonical identity — never the file name or display name.
      ["a renamed SDK file and display", sim((b) => b.replace("iPhoneSimulator27.0.sdk - Simulator - iOS 27.0", "Other27.0.sdk - Something 27.0")), RAW_XCODE27_FACTS],
      // Repeated blocks of one family with one SDKVersion: that version, no physical identity claimed.
      ["a repeated identical iphonesimulator block", rawWith([...sdkBlocks(), sdkBlocks()[2]]), RAW_XCODE27_FACTS],
      ["a ProductName of exactly 200 characters", sim((b) => b.replace("ProductName: iPhone OS", `ProductName: ${"x".repeat(200)}`)), RAW_XCODE27_FACTS],
      ["the four required keys only", sim((b) => b.split("\n").slice(0, 5).join("\n")), RAW_XCODE27_FACTS],
      ["a two-part Xcode version and another build", RAW_XCODE27.replace("Xcode 27.0\nBuild version 27A266a", "Xcode 27\nBuild version 27B5"), { ...RAW_XCODE27_FACTS, version: "27", build: "27B5" }],
    ]) {
      const r = parsed(text);
      check(!(r instanceof Error) && canonical(r) === canonical(want), `an SDK inventory with ${what} did not yield ${canonical(want)}: ${r instanceof Error ? r.message : canonical(r)}`);
    }
    // A family taken from the file name instead would find this simulator block; the canonical identity says iphoneos.
    check(refused(sim((b) => b.replace("(iphonesimulator27.0)", "(iphoneos27.0)")), /lists no iphonesimulator SDK$/),
      "an SDK block's family was not taken from its canonical identity");
  });

  part("inventory budget", () => {
    // The hosted shape: seven installs, each inventory slow. The sixth meets the
    // budget's remainder; it is named, bounded by that remainder, and nothing
    // runs after it. Every inventory call keeps the 64 KiB output cap.
    const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`/Applications/Xcode_2${i}.0.app`, { version: `2${i}.0`, build: `2${i}A1`, macosx: `2${i}.0`, sim: `2${i}.0` }]));
    const s = scenario("inventory remainder", "macos-xcode-ipad", MAC_COSTS({ inventory: 25_000 }), { xcodes: many });
    check(s.written === null && s.warning === "::warning::ci-evidence-toolchain: no source certificate: /Applications/Xcode_25.0.app/Contents/Developer/usr/bin/xcodebuild could not run: ETIMEDOUT"
      && field(s.lines[0], "failure") === "xcode.xcodebuild-sdk-inventory#6:timeout:elapsed_ms=24980:applied_ms=24980:bound=budget-remainder:budget_before_ms=24980:budget_after_ms=0"
      && field(s.lines[0], "calls") === "8" && field(s.lines[0], "components") === "image:2:20,xcode:6:149980" && field(s.lines[0], "budget_left_ms") === "0",
    `an inventory meeting the budget's remainder is not named with its bound: ${s.warning} / ${s.lines[0]}`);
    const inv = s.f.spawned.filter((x) => x.argv.at(-1) === "-sdk");
    check(inv.length === 6 && s.f.spawned.at(-1) === inv[5] && inv.every((x) => x.maxBuffer === 64 * 1024)
      && JSON.stringify(inv.map((x) => x.timeout)) === JSON.stringify([30_000, 30_000, 30_000, 30_000, 30_000, 24_980]),
    `the inventory calls ran under other bounds, were retried, or the probe went on: ${JSON.stringify(inv.map((x) => [x.timeout, x.maxBuffer]))}`);
  });
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
  + `schema/digest/comparison/registry/CLI/budget controls; timing diagnostics; SDK inventory grammar; live: ${live})`);
