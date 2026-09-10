// Install the real Windows artifact, run it, and interrogate the running app.
//
// The unpackaged smoke (`electron-smoke.mjs`) proves the program starts. It
// cannot prove anything about the thing a user actually receives: the installer
// runs, the app lands where it said it would, DPAPI seals a credential on this
// machine, the `relayium://` association names the installed binary, a second
// launch restores the first window, a reinstall keeps the identity, and an
// uninstall removes the program without taking the user's keys.
//
// Windows-only, and it says so rather than pretending to skip cleanly: there is
// no meaningful macOS behaviour to fall back to.
//
// ## What it is allowed to touch
//
// Only what it created. Every path it will write is asserted ABSENT first — the
// install directory, `%LOCALAPPDATA%\Relayium`, and the `relayium` class key. If
// any exists, this host is not clean and the run fails rather than deleting
// state it does not own. Nothing is matched by process name or wildcard.
//
// ## What it does NOT claim
//
// The forced termination near the end is CLEANUP. It is not a graceful-quit
// test, and no assertion here covers tray Quit, the close-to-tray dialog,
// deep-link activation, sleep/wake, upgrade across versions, code signing, or
// SmartScreen/download-reputation behaviour. Those need their own evidence.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const failures = [];
const notes = [];
const check = (name, ok, detail) => {
  if (ok) return true;
  failures.push(detail === undefined ? name : `${name}: ${detail}`);
  return false;
};
const note = (line) => {
  notes.push(line);
  process.stdout.write(`  ${line}\n`);
};

const DEADLINE = { install: 180_000, launch: 120_000, exit: 60_000, uninstall: 180_000 };

function bail(reason) {
  process.stdout.write(`RELAYIUM_INSTALLED ${JSON.stringify({ failures: [reason], notes })}\n`);
  process.exit(1);
}

if (process.platform !== "win32") bail(`installed acceptance is Windows-only; ran on ${process.platform}`);

const installer = process.argv[2];
if (!installer || !existsSync(installer)) bail(`installer not found: ${installer ?? "(no argument)"}`);

const runnerTemp = process.env["RUNNER_TEMP"];
if (!runnerTemp) bail("RUNNER_TEMP is not set; refusing to invent a location to install into");

const localAppData = process.env["LOCALAPPDATA"];
if (!localAppData) bail("LOCALAPPDATA is not set");

// A space in the destination on purpose. `/D=` takes an UNQUOTED path and NSIS
// supports spaces in it (Chapter 3 documents `/D=C:\Program Files\NSIS`), so a
// space-free path would leave the quoting behaviour every real user hits — a
// default install lands under `Programs` — untested.
const installDir = path.join(runnerTemp, "relayium acceptance", "Relayium");
const dataRoot = path.join(localAppData, "Relayium");
/** Coupled to `APP_DIRECTORY` in `storage.ts` and `installer.nsh`, via the path above. */
const APP_DIR_NAME = path.basename(dataRoot);
const secretsDir = path.join(dataRoot, "secrets");
const uninstaller = path.join(installDir, "Uninstall Relayium.exe");
const installedExe = path.join(installDir, "Relayium.exe");

/** Everything this run is allowed to delete, recorded as it is created. */
const owned = { installParent: null, dataRoot: false, aliasRoot: null, substLetter: null };
/** Only PIDs this run spawned. Never a name or image match. */
const spawnedPids = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An ephemeral loopback port the OS just told us was free.
 *
 * Bind-then-release races anything else on the machine in principle; on a
 * disposable runner with one test in flight it does not in practice, and a
 * fixed port would collide with itself across the two launches below.
 */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(what, predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() - started > timeoutMs) {
      check(`waiting for ${what}`, false, `timed out after ${timeoutMs}ms`);
      return false;
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// Registry, read-only except where this run created the key by installing.
// ---------------------------------------------------------------------------

function regQueryDefault(key) {
  const r = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => /REG_SZ/.test(l));
  if (!line) return null;
  return line.slice(line.indexOf("REG_SZ") + "REG_SZ".length).trim();
}

const regKeyExists = (key) => spawnSync("reg.exe", ["query", key], { encoding: "utf8" }).status === 0;

/**
 * Split a Windows command-line string into argv, honouring quotes.
 *
 * Needed because a substring test is not an assertion: `"C:\evil\Relayium.exe"`
 * contains the product name, and `"C:\x\Relayium.exe.bak"` contains the whole
 * installed path. The first token must BE the executable, not merely mention it.
 */
function tokenizeCommand(value) {
  const tokens = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started || current.length > 0) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

const samePath = (a, b) =>
  path.win32.normalize(a).replace(/\\+$/, "").toLowerCase() ===
  path.win32.normalize(b).replace(/\\+$/, "").toLowerCase();

// ---------------------------------------------------------------------------
// Process control. Owned PIDs only.
// ---------------------------------------------------------------------------

function runInstaller(args, timeoutMs, label, executable = installer) {
  return new Promise((resolve) => {
    // Verbatim, because `/D=` must reach NSIS unquoted and Node would otherwise
    // add quotes around a path containing a space. `argv0` is quoted explicitly
    // so the program name is still parsed as one token. No shell is involved at
    // any point: this is a direct CreateProcess with a fixed argument list.
    const child = spawn(executable, args, {
      windowsVerbatimArguments: true,
      argv0: `"${executable}"`,
      stdio: "ignore",
    });
    if (child.pid) spawnedPids.add(child.pid);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killOwned(child.pid);
      resolve({ ok: false, code: null, reason: `${label} did not finish within ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, reason: `${label} could not start: ${String(err)}` });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spawnedPids.delete(child.pid);
      resolve({ ok: true, code, reason: null });
    });
  });
}

function killOwned(pid) {
  if (!pid || !spawnedPids.has(pid)) return;
  // The exact PID and its children. Never `/IM`, which would reach a Relayium
  // this run did not start.
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  spawnedPids.delete(pid);
}

// ---------------------------------------------------------------------------
// CDP over the loopback debugging port. Node 24's built-in WebSocket.
// ---------------------------------------------------------------------------

async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list returned ${res.status}`);
  return res.json();
}

class CdpSession {
  #ws;
  #next = 1;
  #pending = new Map();

  static async open(wsUrl) {
    const session = new CdpSession();
    session.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timed out")), 30_000);
      session.#ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      session.#ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP socket error"));
      }, { once: true });
    });
    session.#ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const waiter = session.#pending.get(msg.id);
      if (!waiter) return;
      session.#pending.delete(msg.id);
      waiter(msg);
    });
    return session;
  }

  send(method, params) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the page, awaiting promises, returning a plain value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return result.result.value;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* the process may already be gone */
    }
  }
}

/** Launch the installed app with a debugging port, returning the child + port. */
function launchInstalled(port, extraEnv = {}) {
  const child = spawn(
    installedExe,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        // Injected to prove they are REFUSED. `build-mode.ts` gates every
        // override on `!app.isPackaged`, and a packaged build is the only place
        // that predicate is genuinely false. Nothing here weakens the app; the
        // assertions below fail if any of it took effect.
        RELAYIUM_WINDOWS_ENGINEERING: "1",
        RELAYIUM_WINDOWS_ORIGIN: "http://127.0.0.1:9/",
        RELAYIUM_WINDOWS_DATA_ROOT: path.join(runnerTemp, "override-must-be-ignored"),
        ...extraEnv,
      },
    },
  );
  if (child.pid) spawnedPids.add(child.pid);
  return child;
}

/** The one page target, once the app has one. */
async function attachToApp(port) {
  let pageTarget = null;
  const ready = await waitFor(
    "the app's debugging endpoint",
    async () => {
      const targets = await cdpTargets(port);
      pageTarget = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
      return pageTarget !== undefined && pageTarget !== null;
    },
    DEADLINE.launch,
  );
  if (!ready) return null;
  return pageTarget;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function main() {
  // ---- Preconditions. Refuse an unclean host rather than adapt to it. ----
  const installParent = path.dirname(installDir);
  if (!check("install directory absent before the run", !existsSync(installDir), installDir)) return;
  // Cleanup removes this whole directory, so its absence has to be asserted
  // too. Deleting a tree on the strength of a precondition that only covered a
  // child of it is how a test destroys something it never owned.
  if (!check("install parent directory absent before the run", !existsSync(installParent), installParent)) return;
  if (!check("private data root absent before the run", !existsSync(dataRoot), dataRoot)) return;
  if (!check(
    "relayium class key absent before the run",
    !regKeyExists("HKCU\\Software\\Classes\\relayium"),
  )) return;
  note(`installer: ${installer}`);
  note(`sha256: ${createHash("sha256").update(readFileSync(installer)).digest("hex")}`);
  note(`destination (contains a space on purpose): ${installDir}`);

  // ---- Install ----------------------------------------------------------
  mkdirSync(installParent, { recursive: true });
  owned.installParent = installParent;
  const install = await runInstaller(["/S", `/D=${installDir}`], DEADLINE.install, "silent install");
  if (!check("silent install ran to completion", install.ok, install.reason)) return;
  if (!check("silent install exited 0", install.code === 0, `exit ${install.code}`)) return;
  if (!check("installed executable exists", existsSync(installedExe), installedExe)) return;

  // ---- Scheme registration names the installed binary, exactly ----------
  const command = regQueryDefault("HKCU\\Software\\Classes\\relayium\\shell\\open\\command");
  if (check("relayium scheme registered under HKCU", command !== null)) {
    const tokens = tokenizeCommand(command);
    check(
      "scheme command names exactly the installed executable",
      tokens.length > 0 && samePath(tokens[0], installedExe),
      `${command} (first token: ${tokens[0]})`,
    );
    check(
      "scheme command passes the URL as a single quoted argument",
      tokens.length === 2 && tokens[1] === "%1" && command.includes('"%1"'),
      command,
    );
  }
  check(
    "no machine-wide association was created by a per-user install",
    !regKeyExists("HKLM\\Software\\Classes\\relayium"),
  );

  // ---- Launch, with overrides that must be ignored ----------------------
  const port = await freeLoopbackPort();
  const app1 = launchInstalled(port);
  owned.dataRoot = true;
  const target1 = await attachToApp(port);
  if (!check("the installed app exposed a page target", target1 !== null)) {
    killOwned(app1.pid);
    return;
  }
  check("page served from the app scheme", target1.url.startsWith("app://relayium/"), target1.url);

  let cdp;
  try {
    cdp = await CdpSession.open(target1.webSocketDebuggerUrl);
  } catch (err) {
    check("CDP session opened", false, String(err));
    killOwned(app1.pid);
    return;
  }

  const info = await cdp.evaluate("globalThis.relayium.appInfo()");
  check("production origin despite an injected override", info.origin === "https://relayium.com", JSON.stringify(info));
  check("not an engineering build despite an injected flag", info.engineering === false, String(info.engineering));
  check("no engineering banner", info.banner === null, String(info.banner));

  // First DPAPI use: this WRITES the sealed installation identity.
  const state1 = await cdp.evaluate("globalThis.relayium.auth.state()");
  check("secret store healthy on real DPAPI", state1.store === "ok", JSON.stringify(state1));
  check("not signed in", state1.signedIn === false, JSON.stringify(state1));
  check("private data root created outside the install directory", existsSync(secretsDir), secretsDir);

  const shellText = await cdp.evaluate("document.body.innerText");
  check("the shell rendered", typeof shellText === "string" && shellText.includes("Relayium"), shellText?.slice(0, 120));
  // Present, deliberately not clicked: no device code is minted, no browser
  // opens, no account is touched by this test.
  check(
    "sign-in control present but untouched",
    (await cdp.evaluate("document.querySelector('[data-test=\"sign-in\"]') !== null")) === true,
  );

  // ---- Second instance restores the first window -----------------------
  const second = spawn(installedExe, [], { stdio: "ignore" });
  if (second.pid) spawnedPids.add(second.pid);
  const secondExited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), DEADLINE.exit);
    second.on("exit", () => {
      clearTimeout(timer);
      spawnedPids.delete(second.pid);
      resolve(true);
    });
  });
  check("a second launch exits instead of running alongside", secondExited);
  if (!secondExited) killOwned(second.pid);

  const targetsAfter = (await cdpTargets(port)).filter((t) => t.type === "page");
  check("still exactly one window", targetsAfter.length === 1, `saw ${targetsAfter.length}`);
  // Identity, not merely count: a first process that had been replaced would
  // also show one window.
  check(
    "the SAME window, not a new one",
    targetsAfter[0]?.id === target1.id,
    `${target1.id} -> ${targetsAfter[0]?.id}`,
  );

  const sealedBefore = hashSealed();
  check("a sealed identity was written", sealedBefore !== null);

  cdp.close();
  killOwned(app1.pid);
  // Joined properly: the debugging endpoint disappearing is the observable
  // signal that the process is really gone, and the reinstall below must not
  // race a still-running app holding files open.
  await waitFor(
    "the first app's debugging endpoint to disappear",
    async () => {
      try {
        await cdpTargets(port);
        return false;
      } catch {
        return true;
      }
    },
    DEADLINE.exit,
  );

  // ---- The destination guard: a silent install must not eat the data ----
  //
  // With a real identity now on disk, point the installer at the private data
  // directory twice, spelled two different ways. Both must be refused BEFORE
  // extraction. The enclosing-parent destination is NOT among them; see below.
  const sentinel = path.join(dataRoot, "acceptance-sentinel.txt");
  writeFileSync(sentinel, "owned by installed-acceptance");
  const sentinelHash = createHash("sha256").update(readFileSync(sentinel)).digest("hex");

  // ONLY destinations this run owns.
  //
  // The enclosing-parent case (`/D=%LOCALAPPDATA%`) is deliberately NOT executed
  // here. If the guard were broken, that install would proceed — and NSIS's
  // uninstall-old-version step would then delete broad state belonging to the
  // runner account, not to this test. A guard is not worth proving by causing
  // the exact damage it exists to prevent. The enclosing relation is covered
  // statically instead, by `storage.test.ts`'s `inside-install-directory` cases
  // for the runtime half; for the NSIS half it remains UNEXECUTED, and
  // DURABLE-PARITY.md says so.
  //
  // The `..` form is the one that matters most here: it names the same
  // directory as the first case while sharing no prefix with it, so it is what
  // separates a real canonicalising guard from a spelling test.
  //
  // It is therefore built by CONCATENATION, not `path.join`. `path.join` — and
  // any other normalising helper — collapses the `..` before NSIS ever sees it,
  // producing a string byte-identical to the first case: the run would still go
  // green while testing the same spelling twice and exercising no
  // canonicalisation at all. `mustContain` below asserts the argument reaches
  // the installer un-normalised, so that degradation cannot happen silently.
  for (const [label, destination, mustContain] of [
    ["the private data directory itself", dataRoot, null],
    [
      "the private data directory reached through `..`",
      `${dataRoot}\\..\\${APP_DIR_NAME}`,
      "\\..\\",
    ],
  ]) {
    const args = ["/S", `/D=${destination}`];
    if (mustContain !== null) {
      // Asserted on the argv element as spawned, not on an intermediate: this
      // is the string NSIS will canonicalise, and the only thing that proves
      // the case is still the case it claims to be.
      if (
        !check(
          `the ${label} destination reaches NSIS un-normalised`,
          args[1].includes(mustContain),
          args[1],
        )
      ) {
        continue;
      }
    }
    const rejected = await runInstaller(args, DEADLINE.install, `install into ${label}`);
    check(`install into ${label} ran to completion`, rejected.ok, rejected.reason);
    // Error level 2 is the collision refusal specifically. "Non-zero" would also
    // be satisfied by a crash, a missing plugin or an unrelated abort — none of
    // which is evidence that the guard ran.
    check(`install into ${label} was refused as a collision`, rejected.code === 2, `exit ${rejected.code}`);
    const leaked = existsSync(path.join(destination, "Relayium.exe"));
    check(`no application was installed into ${label}`, !leaked);
    if (leaked) {
      // Deliberately NOT cleaned up. This run does not own `%LOCALAPPDATA%`,
      // and a failing guard is a finding to preserve, not to tidy away.
      failures.push(
        `LEFTOVER: the guard failed and an application was installed into ${destination}; not removed, because this run does not own that directory`,
      );
    }
    check(
      `the sealed identity survived the refused install into ${label}`,
      hashSealed() === sealedBefore,
    );
    check(
      `the sentinel survived the refused install into ${label}`,
      existsSync(sentinel) &&
        createHash("sha256").update(readFileSync(sentinel)).digest("hex") === sentinelHash,
    );
  }

  // ---- Same-version reinstall preserves the identity --------------------
  const reinstall = await runInstaller(["/S", `/D=${installDir}`], DEADLINE.install, "same-version reinstall");
  check("reinstall ran to completion", reinstall.ok, reinstall.reason);
  check("reinstall exited 0", reinstall.code === 0, `exit ${reinstall.code}`);
  check("sealed identity is byte-identical after reinstall", hashSealed() === sealedBefore);

  // Combined evidence, and only combined: byte-identity alone would not show
  // the app can still READ the identity, and a healthy store alone would not
  // distinguish reading the old one from silently minting a new one.
  const port2 = await freeLoopbackPort();
  const app2 = launchInstalled(port2);
  const target2 = await attachToApp(port2);
  if (check("the reinstalled app exposed a page target", target2 !== null)) {
    const cdp2 = await CdpSession.open(target2.webSocketDebuggerUrl);
    const state2 = await cdp2.evaluate("globalThis.relayium.auth.state()");
    check("secret store still healthy after reinstall", state2.store === "ok", JSON.stringify(state2));
    check("still signed out after reinstall", state2.signedIn === false, JSON.stringify(state2));
    check("sealed identity unchanged by the second read", hashSealed() === sealedBefore);
    cdp2.close();
  }
  killOwned(app2.pid);

  // ---- Uninstall --------------------------------------------------------
  if (check("uninstaller exists", existsSync(uninstaller), uninstaller)) {
    // `_?=` keeps the uninstaller running IN PLACE. Without it NSIS copies
    // itself to a temp directory and relaunches, so the process this run waits
    // on exits immediately while the real work continues in a child nobody
    // joined — and the assertions below would race it.
    const removed = await runInstaller(
      ["/S", `_?=${installDir}`],
      DEADLINE.uninstall,
      "silent uninstall",
      uninstaller,
    );
    check("uninstall ran to completion", removed.ok, removed.reason);
    check("uninstall exited 0", removed.code === 0, `exit ${removed.code}`);
    // In-place mode leaves the uninstaller binary itself behind by design.
    await waitFor("the program files to be removed", async () => !existsSync(installedExe), DEADLINE.uninstall);
    check("installed executable removed", !existsSync(installedExe));
    check("scheme registration removed", !regKeyExists("HKCU\\Software\\Classes\\relayium"));
    // The point of the whole guard: an uninstall must not take the keys.
    check("private data root PRESERVED by uninstall", existsSync(secretsDir), secretsDir);
    check("sealed identity preserved by uninstall", hashSealed() === sealedBefore);
  }

  await aliasPhase();
}

/**
 * The alias closure: destinations that name the private data directory through
 * something other than its own spelling.
 *
 * Runs LAST, after the uninstall, for two reasons. The sealed identity is still
 * on disk — an uninstall must not take it, which the block above just asserted —
 * so there is real data to protect. And no installation is registered, so the
 * positives below cannot trip NSIS's uninstall-the-old-version step and demolish
 * the primary install mid-run.
 *
 * Every case is a directory or drive letter this run created. `%LOCALAPPDATA%`
 * is aliased read-only as a junction TARGET in one case; it is never an install
 * destination, and `/D=` never names it or any other unowned parent.
 */
async function aliasPhase() {
  const sealed = hashSealed();
  if (!check("a sealed identity survives to test the alias guard against", sealed !== null)) return;

  // ---- Junctions --------------------------------------------------------
  const aliasRoot = path.join(runnerTemp, "relayium acceptance", "alias");
  mkdirSync(aliasRoot, { recursive: true });
  owned.aliasRoot = aliasRoot;

  const ordinary = path.join(aliasRoot, "ordinary");
  mkdirSync(ordinary, { recursive: true });

  const toData = path.join(aliasRoot, "to-data");
  const toOrdinary = path.join(aliasRoot, "to-ordinary");
  // `mklink /J` is a directory junction: no elevation, no Developer Mode. A
  // symlink would need one of those and would SKIP on a stock runner, so the
  // junction cases carry this evidence instead of a case that may not run.
  if (!check("junction to the data root created", mklinkJ(toData, dataRoot), toData)) return;
  if (!check("junction to an ordinary directory created", mklinkJ(toOrdinary, ordinary), toOrdinary)) return;

  await expectRefused("a junction onto the private data directory", toData, sealed);
  await expectRefused(
    "a path inside a junction onto the private data directory",
    path.join(toData, "Relayium"),
    sealed,
  );
  // The over-refusal regression. A guard that refuses every alias is not a
  // guard, it is a machine Relayium cannot be installed on.
  await expectInstalls("a junction onto an ordinary directory", path.join(toOrdinary, "Relayium"));

  // ---- subst ------------------------------------------------------------
  const letter = freeDriveLetter();
  if (!check("an unused drive letter was available for the subst case", letter !== null)) return;

  // The alias TARGET is %LOCALAPPDATA%, read-only — nothing is installed there.
  // The destination below is `<letter>:\Relayium`, which resolves to the data
  // root this run owns. `/D=<letter>:\` is never executed.
  if (!check(`subst ${letter}: created`, substAdd(letter, localAppData), `${letter}: -> ${localAppData}`)) {
    return;
  }
  owned.substLetter = letter;

  await expectRefused(`a subst drive onto the profile (${letter}:)`, `${letter}:\\${APP_DIR_NAME}`, sealed);
  // Without this control, the refusal above is equally explained by NSIS or the
  // guard rejecting a destination close to a drive root. This proves the
  // refusal is the alias resolving onto the data root and nothing else.
  await expectInstalls(`an unrelated path on the same subst drive (${letter}:)`, `${letter}:\\Elsewhere\\Relayium`);
}

/** A destination that must be refused before extraction, with nothing touched. */
async function expectRefused(label, destination, sealed) {
  const args = ["/S", `/D=${destination}`];
  const result = await runInstaller(args, DEADLINE.install, `install into ${label}`);
  check(`install into ${label} ran to completion`, result.ok, result.reason);
  // Error level 2 is the collision refusal specifically. A bare "non-zero"
  // would also accept a crash, a missing plugin or an unrelated abort.
  check(`install into ${label} was refused as a collision`, result.code === 2, `exit ${result.code}`);
  const landed = existsSync(path.join(destination, "Relayium.exe"));
  check(`no application was installed into ${label}`, !landed);
  if (landed) {
    failures.push(
      `LEFTOVER: the alias guard failed and an application was installed into ${destination}; not removed, because a failing guard is a finding to preserve`,
    );
  }
  check(`the sealed identity survived the refused install into ${label}`, hashSealed() === sealed);
}

/** A destination that must still install, then is uninstalled and removed. */
async function expectInstalls(label, destination) {
  const result = await runInstaller(["/S", `/D=${destination}`], DEADLINE.install, `install into ${label}`);
  check(`install into ${label} ran to completion`, result.ok, result.reason);
  if (!check(`install into ${label} exited 0`, result.code === 0, `exit ${result.code}`)) return;
  const exe = path.join(destination, "Relayium.exe");
  if (!check(`an application was installed into ${label}`, existsSync(exe), exe)) return;

  const un = path.join(destination, "Uninstall Relayium.exe");
  if (check(`uninstaller exists for ${label}`, existsSync(un), un)) {
    const removed = await runInstaller(["/S", `_?=${destination}`], DEADLINE.uninstall, `uninstall ${label}`, un);
    check(`uninstall of ${label} ran to completion`, removed.ok, removed.reason);
    check(`uninstall of ${label} exited 0`, removed.code === 0, `exit ${removed.code}`);
    await waitFor(`${label} program files to be removed`, async () => !existsSync(exe), DEADLINE.uninstall);
  }
  check(`${label} left no executable behind`, !existsSync(exe));
}

/** `mklink /J`. Needs no elevation, unlike a symlink. */
function mklinkJ(link, target) {
  const r = spawnSync("cmd.exe", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });
  return r.status === 0 && existsSync(link);
}

/** An unused drive letter, or null. Never touches one already in use. */
function freeDriveLetter() {
  for (const letter of "STUVWXY") {
    if (!existsSync(`${letter}:\\`)) return letter;
  }
  return null;
}

function substAdd(letter, target) {
  const r = spawnSync("subst.exe", [`${letter}:`, target], { stdio: "ignore" });
  return r.status === 0 && existsSync(`${letter}:\\`);
}

/**
 * Release the mapping this run made — and only if it is still the mapping this
 * run made. `subst` is a session-global namespace, so deleting a letter without
 * confirming what it currently points at could release someone else's.
 */
function substRelease(letter, expectedTarget) {
  const listing = spawnSync("subst.exe", [], { encoding: "utf8" });
  if (listing.status !== 0) {
    failures.push(`could not list subst mappings to release ${letter}:`);
    return;
  }
  const line = (listing.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.toUpperCase().startsWith(`${letter.toUpperCase()}:\\:`));
  if (line === undefined) return; // already gone
  if (!line.toUpperCase().includes(expectedTarget.toUpperCase())) {
    failures.push(`refusing to release ${letter}: — it maps to something this run did not create: ${line}`);
    return;
  }
  const r = spawnSync("subst.exe", [`${letter}:`, "/D"], { stdio: "ignore" });
  if (r.status !== 0) failures.push(`could not release subst ${letter}:`);
}

/** Hash of the sealed secret files, or null when there are none. */
function hashSealed() {
  if (!existsSync(secretsDir)) return null;
  const entries = readdirSync(secretsDir).sort();
  if (entries.length === 0) return null;
  const hash = createHash("sha256");
  for (const name of entries) {
    const full = path.join(secretsDir, name);
    if (!statSync(full).isFile()) continue;
    hash.update(name);
    // Ciphertext only. Nothing here decrypts it, and no debug channel was added
    // to the app to read it back in the clear.
    hash.update(readFileSync(full));
  }
  return hash.digest("hex");
}

function cleanup() {
  for (const pid of [...spawnedPids]) killOwned(pid);
  // Before the directories: a junction inside `aliasRoot` points AT the data
  // root, and removing the mapping first keeps a recursive delete from
  // following one. `rmSync` removes a junction without descending, but the
  // ordering is not something to leave to a library detail.
  if (owned.substLetter !== null) substRelease(owned.substLetter, localAppData);
  // Exactly the paths this run created, each recorded at the moment it created
  // it — not derived from a path it merely knows about.
  for (const dir of [owned.aliasRoot, owned.installParent, owned.dataRoot ? dataRoot : null]) {
    if (dir === null || !existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Reported, not swallowed: a path this run created and could not remove
      // is a leftover, and claiming otherwise would be false.
      failures.push(`could not remove owned directory ${dir}: ${String(err)}`);
    }
  }
}

main()
  .catch((err) => {
    failures.push(`threw: ${String(err?.stack ?? err)}`);
  })
  .finally(() => {
    cleanup();
    process.stdout.write(`RELAYIUM_INSTALLED ${JSON.stringify({ failures, notes })}\n`);
    if (failures.length > 0) {
      process.stderr.write(`installed acceptance: ${failures.length} failed\n${failures.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("installed acceptance: all assertions passed\n");
    process.exit(0);
  });
