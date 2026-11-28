// Personal-machine tests. Never installs the app, changes login items, creates
// users, mounts volumes or contacts the production account service.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATES, gateSteps } from "./gates.mjs";
import { npmCommand, runPlan } from "./qa-runner.mjs";

export function qaSteps(profile, app, npm) {
  const steps = [];
  if (profile === "windows") {
    steps.push({ name: "signed-fixture", command: "pwsh", cwd: app, args: ["-NoProfile", "-NonInteractive", "-Command",
      'if ((Get-AuthenticodeSignature -LiteralPath $env:RELAYIUM_SIGNED_FIXTURE).Status -ne "Valid") { throw "Node must have a valid Authenticode signature" }'] });
    for (const helper of ["io", "secret", "update"]) {
      steps.push({ name: `build-${helper}-helper`, command: "go", cwd: join(app, "native"),
        args: ["build", "-o", `build/relayium-${helper}-helper.exe`, `./cmd/relayium-${helper}-helper`] });
    }
    steps.push({ name: "native", command: "go", cwd: join(app, "native"),
      args: ["test", "-json", "-count=1", "-timeout", "10m", "./..."], goTests: true });
  }
  steps.push(...gateSteps(profile === "windows" ? GATES : GATES.filter(([name]) => ["check", "unit", "build"].includes(name)), app, npm));
  if (profile === "windows") {
    for (const [name, file] of [["sqlite-startup", "sqlite-startup-acceptance.mjs"],
      ["inbox-server", "inbox-server-acceptance.mjs"], ["secret-durability", "secret-durability.mjs"]]) {
      steps.push({ name, command: process.execPath, cwd: app, args: [join(app, "test/smoke", file)] });
    }
  }
  return steps;
}

export function profileFromArgs(args, platform) {
  if (args.length > 1 || (args.length && !["--profile=portable", "--profile=windows"].includes(args[0]))) {
    throw new Error("Usage: npm run qa -- [--profile=windows|--profile=portable]");
  }
  const profile = args.length ? args[0].slice("--profile=".length) : "windows";
  if (profile === "windows" && platform !== "win32") {
    throw new Error("Windows QA requires Windows. On this host run npm run qa -- --profile=portable.");
  }
  return profile;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const profile = profileFromArgs(process.argv.slice(2), process.platform);
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node.js 24, matching the Windows CI lane.");
    const npm = npmCommand();
    const app = fileURLToPath(new URL("..", import.meta.url));
    const repo = resolve(app, "../..");
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
      if (result.status !== 0) throw new Error("Could not record Git source identity.");
      return result.stdout.trim();
    };
    const commit = git(["rev-parse", "HEAD"]);
    const dirty = git(["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) throw new Error("QA requires a clean checkout so the commit identifies tested source. Commit your reviewed changes first.");
    // Do not consume credentials or privilege fixtures left over from CI.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^RELAYIUM_(WINDOWS_|XUSER|TEST_SECOND_VOLUME|SIGNED_FIXTURE|POWERSHELL)/i.test(key)) delete env[key];
    }
    env.RELAYIUM_SIGNED_FIXTURE = process.execPath;
    env.RELAYIUM_POWERSHELL = "pwsh";
    const directory = mkdtempSync(join(tmpdir(), "relayium-windows-qa-"));
    console.log(`Evidence: ${directory}`);
    const report = await runPlan(qaSteps(profile, app, npm), directory, {
      profile, commit, platform: process.platform, architecture: process.arch, os: release(), node: process.version,
      limitations: ["No public signing/installer/update-channel certification", "No real WAN or personal-account acceptance",
        ...(profile === "portable" ? ["Windows kernel, DPAPI and Electron UI not executed"]
          : ["No second-user DPAPI or volume-mount privilege provisioning; inspect all native skips"]),
        "Known Windows stored-upload response-loss recovery HOLD remains open"],
    }, { env, finalCheck: () => {
      const after = git(["rev-parse", "HEAD"]);
      if (after !== commit || git(["status", "--porcelain", "--untracked-files=all"])) {
        throw new Error("Source changed during QA; the recorded commit no longer identifies this run.");
      }
      return { commit: after, clean: true };
    } });
    console.log(`QA: ${report.status}; ${directory}`);
    // Skipped kernel proofs are useful evidence, but never aggregate PASS.
    process.exitCode = report.status === "PASS" ? 0 : report.status === "PASS_WITH_SKIPS" ? 2 : 1;
  } catch (err) { console.error(err.message); process.exitCode = 2; }
}
