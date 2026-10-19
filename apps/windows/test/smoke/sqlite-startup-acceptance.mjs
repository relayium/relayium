// Real SQLite bootstrap, independently of the HTTP-server readiness probe.
// A Go test timeout retains the goroutine stack of a stalled bootstrap. The
// original Inbox acceptance still opens its own separate fresh database.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareServerOverlay, runOwnedFixtureChild } from "./server-platform.mjs";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const PROBE = fileURLToPath(new URL("./sqlite-startup_probe_test.go", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, {
  cwd: REPO, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
}).trim();
async function moduleHashes(path) {
  const mod = await readFile(path);
  const sum = await readFile(path.replace(/\.mod$/, ".sum"));
  const normalized = (bytes) => sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")));
  return { modSHA256: sha256(mod), sumSHA256: sha256(sum),
    modNormalizedSHA256: normalized(mod), sumNormalizedSHA256: normalized(sum) };
}

export function probeSucceeded(result) {
  return result.code === 0 && result.closed && !result.timedOut && !result.unjoined
    && !result.spawnError && /^--- PASS: TestSQLiteColdStart \(/m.test(result.stdout)
    && /^PASS\r?$/m.test(result.stdout);
}

async function baselineRef(args) {
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--baseline-ref" || !/^[0-9a-f]{40}$/.test(args[1])) {
      throw new Error("usage: sqlite-startup-acceptance.mjs [--baseline-ref FULL_SHA]");
    }
    return args[1];
  }
  if (!process.env.GITHUB_EVENT_PATH) return null;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const ref = event.pull_request?.base?.sha ?? event.before;
  if (ref === undefined) return null; // dispatch: current case remains mandatory
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("invalid baseline event SHA");
  if (/^0+$/.test(ref)) return null; // first push: there is no earlier graph to compare
  return ref;
}

export async function main(args = process.argv.slice(2)) {
  const root = await mkdtemp(join(tmpdir(), "sqlite-startup-"));
  const children = [];
  const rows = [];
  const failures = [];
  let accepted = false;
  let cancelled = null;
  const interrupt = (signal) => {
    cancelled ??= signal;
    for (const entry of children.filter((child) => !child.closed)) {
      try { entry.child.kill("SIGTERM"); } catch { /* closure remains required */ }
    }
  };
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => interrupt(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const requireActive = () => { if (cancelled) throw new Error(`cold-database probe interrupted by ${cancelled}`); };
  const register = (child, label, ledger) => {
    const entry = { child, label, ledger, closed: false };
    entry.done = new Promise((done) => {
      child.once("close", () => { entry.closed = true; done(); });
      child.once("error", () => { if (child.pid === undefined) { entry.closed = true; done(); } });
    });
    children.push(entry);
    if (cancelled) { try { child.kill("SIGTERM"); } catch { /* checked at join */ } }
  };
  try {
    const ref = await baselineRef(args);
    const cohorts = [{ label: "current", modArgs: [], modPath: join(REPO, "server", "go.mod") }];
    if (ref) {
      git("merge-base", "--is-ancestor", ref, "HEAD");
      const changed = [git("diff", "--name-only", ref, "--", "server"),
        git("ls-files", "--others", "--exclude-standard", "--", "server")]
        .flatMap((text) => text.split("\n")).filter(Boolean);
      if (changed.length && changed.every((path) => /^server\/go\.(mod|sum)$/.test(path))) {
        const readBlob = (path) => execFileSync("git", ["show", `${ref}:${path}`], {
          cwd: REPO, timeout: 10_000, maxBuffer: 1024 * 1024,
        });
        const mod = readBlob("server/go.mod");
        const sum = readBlob("server/go.sum");
        const modPath = join(root, "baseline.mod");
        await writeFile(modPath, mod);
        await writeFile(join(root, "baseline.sum"), sum);
        cohorts.push({ label: "baseline", modArgs: ["-modfile", modPath], modPath, ref });
      } else {
        console.log("baseline comparison not applicable: server source changed or module graph unchanged");
      }
    } else {
      console.log("baseline comparison not applicable: no PR/push base; current cold case is mandatory");
    }
    for (const cohort of cohorts) {
      requireActive();
      const taskRoot = join(root, cohort.label);
      await mkdir(taskRoot);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^RELAYIUM_/i.test(key)));
      Object.assign(env, { TMPDIR: taskRoot, TMP: taskRoot, TEMP: taskRoot, GOWORK: "off" });
      const inputs = await moduleHashes(cohort.modPath);
      const { args: overlayArgs, provenance } = await prepareServerOverlay({ repoRoot: REPO, taskRoot });
      const binary = join(taskRoot, process.platform === "win32" ? "sqlite-probe.test.exe" : "sqlite-probe.test");
      const compiled = await runOwnedFixtureChild(process.platform === "win32" ? "go.exe" : "go",
        ["test", ...overlayArgs, ...cohort.modArgs, "-mod=readonly", "-c", "-o", binary, PROBE], {
          cwd: join(REPO, "server"), env, timeoutMs: 8 * 60_000,
          label: `compile-${cohort.label}`, register,
        });
      requireActive();
      if (compiled.code !== 0 || !compiled.closed || compiled.timedOut || compiled.unjoined || compiled.spawnError) {
        throw new Error(`${cohort.label} compile failed: ${JSON.stringify(compiled)}`);
      }
      const result = await runOwnedFixtureChild(binary,
        ["-test.run", "^TestSQLiteColdStart$", "-test.v", "-test.count=1", "-test.timeout=60s"], {
          cwd: taskRoot, env, timeoutMs: 65_000, label: `cold-${cohort.label}`, register,
        });
      requireActive();
      if (JSON.stringify(inputs) !== JSON.stringify(await moduleHashes(cohort.modPath))) {
        throw new Error(`${cohort.label}: module inputs changed during the probe`);
      }
      const row = { ...cohort, ...inputs, provenance, ...result };
      rows.push(row);
      console.log(JSON.stringify(row));
      if (!probeSucceeded(result)) {
        failures.push(cohort.label);
        console.error(`${cohort.label}: cold-start failed; collecting the remaining independent comparison`);
      }
    }
    requireActive();
    if (failures.length) throw new Error(`real named cold-start test did not pass: ${failures.join(", ")}`);
    accepted = true;
  } finally {
    for (const entry of children.filter((child) => !child.closed)) {
      try { entry.child.kill("SIGKILL"); } catch { /* closure is checked below */ }
      let timer;
      await Promise.race([entry.done, new Promise((done) => { timer = setTimeout(done, 4_000); })]);
      clearTimeout(timer);
    }
    const pending = children.filter((child) => !child.closed);
    let cleanupError;
    if (accepted && !pending.length) {
      try { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch (error) { cleanupError = error; accepted = false; }
    }
    console.log(JSON.stringify({ accepted: accepted && !pending.length, cohorts: rows.length,
      taskRootRemoved: accepted && !pending.length, cancelled,
      children: children.map(({ label, ledger, closed }) => ({ label, pid: ledger.pid, closed })) }));
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (!accepted || pending.length) console.error(`cold-database evidence retained: ${root}`);
    if (pending.length) throw new Error("cold-database probe has unjoined children");
    if (cleanupError) throw cleanupError;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
