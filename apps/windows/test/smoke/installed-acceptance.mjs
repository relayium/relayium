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
/** One attach attempt's socket budget, inside `DEADLINE.launch`. */
const ATTACH_OPEN_MS = 10_000;
/** One `/json/list` request's budget, including its body. */
const CDP_HTTP_MS = 10_000;

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

/**
 * The profile directory names to survey. A CLOSED list of two known candidates,
 * not a scan: nothing here enumerates the user's other application profiles.
 *
 * Both are surveyed because which one Electron uses is not obvious and guessing
 * wrong produces the worst possible diagnostic — "no Local State anywhere",
 * which reads as a finding and is actually a missed directory.
 *
 * `app.getName()` returns `productName` from the packaged `package.json`, or
 * `name` when there is none. Extracting `app.asar` from a real build shows
 * `{"name":"relayium-windows"}` with **no `productName`** — electron-builder's
 * `productName: Relayium` configures the executable and install directory, not
 * the packaged manifest — and `main.ts` never calls `app.setName`. So the live
 * profile is expected under `relayium-windows`, and `Relayium` is surveyed as
 * the other closed possibility rather than assumed absent.
 */
const PROFILE_DIR_CANDIDATES = ["relayium-windows", "Relayium"];

const SCHEME_KEY = "HKCU\\Software\\Classes\\relayium";
const SEND_VERB = "RelayiumSendFiles";
const SEND_FILE_KEY = `HKCU\\Software\\Classes\\*\\shell\\${SEND_VERB}`;
const SEND_DIR_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${SEND_VERB}`;
const SCHEME_CMD_KEY = `${SCHEME_KEY}\\shell\\open\\command`;
const secretsDir = path.join(dataRoot, "secrets");
const uninstaller = path.join(installDir, "Uninstall Relayium.exe");
const installedExe = path.join(installDir, "Relayium.exe");

/** Everything this run is allowed to delete, recorded as it is created. */
const owned = {
  installParent: null,
  dataRoot: false,
  aliasRoot: null,
  substLetter: null,
  schemeInstallParent: null,
  schemeKey: false,
};
/** Only PIDs this run spawned. Never a name or image match. */
const spawnedPids = new Set();
/** The child object for each owned PID, so an exit can be JOINED rather than
 *  assumed. A PID whose object this run no longer holds is polled instead. */
const spawnedChildren = new Map();
/** Every CDP session this run opened. The explicit closes below are the normal
 *  path; this is the `finally` that covers a throw between attach and close. */
const openSessions = new Set();
/** In-flight kills, so two callers for one PID join the SAME attempt instead of
 *  racing two `taskkill`s and two polls. */
const killing = new Map();

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

/** Bounded poll that records NOTHING. The caller reports, so one problem does
 *  not become two failures. */
async function poll(predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(250);
  }
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

/**
 * Write a REAL shortcut, through the same shell interface the uninstaller reads.
 *
 * The foreign cases have to be genuine `.lnk` files: a file of the right NAME
 * full of arbitrary bytes only exercises the uninstaller's fail-closed path,
 * which is a different assertion from "this link names somebody else".
 */
function writeShortcut(linkPath, target, args) {
  const ps = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RELAYIUM_LNK)",
    "$s.TargetPath = $env:RELAYIUM_TARGET",
    "$s.Arguments = $env:RELAYIUM_ARGS",
    "$s.Save()",
  ].join("; ");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
    env: { ...process.env, RELAYIUM_LNK: linkPath, RELAYIUM_TARGET: target, RELAYIUM_ARGS: args },
  }).status === 0;
}

/** What a shortcut actually points at, read the same way. */
function readShortcut(linkPath) {
  const ps = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RELAYIUM_LNK)",
    "Write-Output $s.TargetPath",
    "Write-Output $s.Arguments",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    env: { ...process.env, RELAYIUM_LNK: linkPath },
  });
  if (r.status !== 0) return null;
  const [target = "", args = ""] = r.stdout.split(/\r?\n/);
  return { target: target.trim(), args: args.trim() };
}

/** One NAMED value under a key. `MultiSelectModel` is not a default value. */
function regQueryValue(key, name) {
  const r = spawnSync("reg.exe", ["query", key, "/v", name], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => /REG_SZ/.test(l));
  if (!line) return null;
  return line.slice(line.indexOf("REG_SZ") + "REG_SZ".length).trim();
}

/** Writes a key's default value. Only ever used on keys this run owns. */
function regSetDefault(key, value) {
  return spawnSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], {
    stdio: "ignore",
  }).status === 0;
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
    if (child.pid) {
      spawnedPids.add(child.pid);
      spawnedChildren.set(child.pid, child);
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Joined BEFORE resolving. Returning while the timed-out installer is
      // still alive hands the next phase a running NSIS process holding the
      // very directory it is about to assert on.
      void (async () => {
        const joined = await killOwned(child.pid);
        resolve({
          ok: false,
          code: null,
          reason: joined
            ? `${label} did not finish within ${timeoutMs}ms`
            : `${label} did not finish within ${timeoutMs}ms and could not be joined after taskkill`,
        });
      })();
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
      spawnedChildren.delete(child.pid);
      resolve({ ok: true, code, reason: null });
    });
  });
}

/**
 * Kill one owned process and JOIN it.
 *
 * `taskkill /F` returns as soon as the request is made; the process, its
 * children and the file handles they hold outlive that return. The previous
 * version dropped the PID from the registry immediately, so cleanup deleted the
 * install directory while the app still had it open — the `EPERM` this run
 * reported. Now the exit is OBSERVED: the child's own `exit` event when this run
 * still has the object, otherwise a bounded liveness poll on the exact PID.
 *
 * The PID stays registered until the exit is observed, and a process that never
 * exits is a recorded failure rather than a silent one.
 */
function killOwned(pid) {
  if (!pid || !spawnedPids.has(pid)) return Promise.resolve(true);
  const already = killing.get(pid);
  if (already) return already;
  const attempt = killOwnedOnce(pid).finally(() => killing.delete(pid));
  killing.set(pid, attempt);
  return attempt;
}

async function killOwnedOnce(pid) {
  const child = spawnedChildren.get(pid) ?? null;
  const exited =
    child === null || child.exitCode !== null || child.signalCode !== null
      ? null
      : new Promise((resolve) => child.once("exit", () => resolve(true)));
  // The exact PID and its children. Never `/IM`, which would reach a Relayium
  // this run did not start.
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  if (exited !== null) {
    await Promise.race([exited, sleep(DEADLINE.exit)]);
  }
  // The child object covers only the process this run spawned. The poll
  // confirms that PID is released; it says nothing about descendants — see
  // `alive`.
  const gone = await poll(() => !alive(pid), DEADLINE.exit);
  if (gone) {
    spawnedPids.delete(pid);
    spawnedChildren.delete(pid);
  }
  return gone;
}

/**
 * Whether a PID still exists. Signal 0 tests for existence and sends nothing.
 *
 * This is the PARENT only. `/T` asks the kernel to kill the tree, but polling
 * one PID does not prove every descendant is gone, and this run does not
 * enumerate them. The bounded removal retry in `cleanup()` is what actually
 * observes a lingering handle: a directory that will not go is reported.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and is not ours to signal — which for a PID this
    // run spawned means it is still there, so it is NOT reported as gone.
    return err?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// CDP over the loopback debugging port. Node 24's built-in WebSocket.
// ---------------------------------------------------------------------------

/**
 * The debugging endpoint's target list, on a finite budget.
 *
 * An unbounded `fetch` cannot be bounded by the poll around it: a request that
 * never settles holds the predicate open past the deadline the poll exists to
 * enforce. The signal stays armed across the body read — aborting it errors the
 * body stream — so a half-sent response cannot hang here either.
 */
async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(CDP_HTTP_MS),
  });
  if (!res.ok) throw new Error(`/json/list returned ${res.status}`);
  return res.json();
}

class CdpSession {
  #ws;
  #next = 1;
  #pending = new Map();

  /**
   * Connect, on this call's OWN budget, closing the socket on any failure.
   *
   * A caller racing `open()` against a timer cannot clean up after it: the
   * promise it holds has rejected, so there is no session to close and the
   * socket is left connecting. So the deadline lives here, and every failure
   * path closes the socket before rejecting.
   */
  static async open(wsUrl, timeoutMs = ATTACH_OPEN_MS) {
    const session = new CdpSession();
    session.#ws = new WebSocket(wsUrl);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
        session.#ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        session.#ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("CDP socket error"));
        }, { once: true });
      });
    } catch (err) {
      try {
        session.#ws.close();
      } catch {
        /* nothing to close */
      }
      throw err;
    }
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
    openSessions.add(session);
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
    openSessions.delete(this);
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
  if (child.pid) {
    spawnedPids.add(child.pid);
    spawnedChildren.set(child.pid, child);
  }
  return child;
}

/**
 * Attach to the app's window, once the PRELOAD BRIDGE is actually usable.
 *
 * A page target appears before the bridge exists. The previous version returned
 * the first `type: "page"` target it saw, so an `evaluate` could land on the
 * document before `contextBridge` had exposed `globalThis.relayium` — which is
 * exactly how the tenth run failed, reading `.auth` of `undefined` after the
 * reinstall. The earlier attaches were the same race, won by luck.
 *
 * So readiness is a property of the BRIDGE, not of the target list, and it is
 * bounded: within `DEADLINE.launch` there must be a page on the app scheme whose
 * `globalThis.relayium.auth.state` is callable. Anything else is a hard failure
 * with the last observation attached — never a relaxed assertion, and never a
 * skip.
 *
 * Returns the ready target and its OPEN session; the caller closes the session
 * in a `finally`.
 */
async function attachToApp(port, label) {
  let target = null;
  let session = null;
  let last = "no page target";
  const ready = await poll(async () => {
    const targets = await cdpTargets(port).catch(() => []);
    const page = targets.find(
      (t) =>
        t.type === "page" &&
        typeof t.webSocketDebuggerUrl === "string" &&
        typeof t.url === "string" &&
        t.url.startsWith("app://relayium/"),
    );
    if (!page) {
      last = `targets: ${targets.map((t) => `${t.type} ${t.url ?? ""}`).join(", ") || "(none)"}`;
      return false;
    }
    // A fresh session per attempt: a target that went away mid-poll leaves a
    // dead socket, and reusing it would report the wrong reason.
    let attempt = null;
    try {
      // `open` carries its own deadline and closes its own socket, so this
      // poll cannot outlive a connect that never settles and cannot leak one.
      attempt = await CdpSession.open(page.webSocketDebuggerUrl);
      const bridged = await attempt.evaluate(
        "typeof globalThis.relayium?.auth?.state === 'function' && typeof globalThis.relayium?.appInfo === 'function'",
      );
      if (bridged !== true) {
        last = `page ${page.url} has no bridge yet`;
        attempt.close();
        return false;
      }
      target = page;
      session = attempt;
      return true;
    } catch (err) {
      attempt?.close();
      last = `session on ${page.url}: ${String(err)}`;
      return false;
    }
  }, DEADLINE.launch);
  if (!ready || session === null || target === null) {
    check(`${label} exposed a usable app bridge`, false, last);
    session?.close();
    return null;
  }
  return { target, cdp: session };
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
  // The send entries, for the same reason the directories above are asserted.
  //
  // This run OVERWRITES them and its cleanup DELETES them, and the ownership
  // comments elsewhere describe intent rather than establish fact. If a real
  // installation of Relayium were already on this machine, every send assertion
  // below would be reading its registration and the cleanup would take the
  // user's own entries with it. Absence first, then they are this run's.
  if (!check("file send verb absent before the run", !regKeyExists(SEND_FILE_KEY), SEND_FILE_KEY)) return;
  if (!check("folder send verb absent before the run", !regKeyExists(SEND_DIR_KEY), SEND_DIR_KEY)) return;
  {
    const link = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "SendTo", "Relayium.lnk");
    if (!check("SendTo shortcut absent before the run", !existsSync(link), link)) return;
  }
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

  // ---- the Explorer send entries ----------------------------------------
  //
  // Read back from the REAL registry the installer just wrote. What Explorer
  // then DOES with a verb — whether it honours `MultiSelectModel`, and what
  // argv it builds — is the shell's behaviour and is not observable here
  // without driving Explorer itself. These assert the contract; the shell's
  // half is documented rather than claimed.
  for (const [what, key] of [
    ["file", SEND_FILE_KEY],
    ["folder", SEND_DIR_KEY],
  ]) {
    const verb = regQueryDefault(key);
    check(`${what} send verb registered under HKCU`, verb !== null, key);
    check(
      `${what} send verb is SINGLE-selection`,
      regQueryValue(key, "MultiSelectModel") === "Single",
      String(regQueryValue(key, "MultiSelectModel")),
    );
    const sendCommand = regQueryDefault(`${key}\\command`);
    if (check(`${what} send command present`, sendCommand !== null)) {
      const tokens = tokenizeCommand(sendCommand);
      check(
        `${what} send command names exactly the installed executable`,
        tokens.length > 0 && samePath(tokens[0], installedExe),
        `${sendCommand} (first token: ${tokens[0]})`,
      );
      check(
        `${what} send command passes the flag and ONE quoted path`,
        tokens.length === 3 && tokens[1] === "--send-files" && tokens[2] === "%1"
          && sendCommand.includes('"%1"'),
        sendCommand,
      );
    }
  }
  check(
    "no machine-wide send verb was created",
    !regKeyExists("HKLM\\Software\\Classes\\*\\shell\\RelayiumSendFiles"),
  );
  // Not a default association: double-clicking a file is unchanged.
  check(
    "no file-type association was claimed",
    !regKeyExists("HKCU\\Software\\Classes\\.bin"),
  );

  // ---- the SendTo shortcut, the bulk path --------------------------------
  const sendToLink = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "SendTo", "Relayium.lnk");
  if (check("SendTo shortcut created", existsSync(sendToLink), sendToLink)) {
    const link = readShortcut(sendToLink);
    if (check("SendTo shortcut is readable", link !== null)) {
      check(
        "SendTo shortcut targets exactly the installed executable",
        samePath(link.target, installedExe),
        `${link.target} vs ${installedExe}`,
      );
      // The flag and NOTHING else: Explorer appends every selected path after
      // these arguments, which is what makes this the bulk path.
      check("SendTo shortcut carries only the flag", link.args === "--send-files", link.args);
    }
  }

  // ---- Launch, with overrides that must be ignored ----------------------
  const port = await freeLoopbackPort();
  const app1 = launchInstalled(port);
  owned.dataRoot = true;
  const attached1 = await attachToApp(port, "the installed app");
  if (attached1 === null) {
    await killOwned(app1.pid);
    return;
  }
  const { target: target1, cdp } = attached1;
  check("page served from the app scheme", target1.url.startsWith("app://relayium/"), target1.url);

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
  // ---- The sign-in control, reached the way a user reaches it -----------
  //
  // ## Why this navigates instead of querying the page it landed on
  //
  // The previous revision asked for `sign-in` on whatever page was showing.
  // That was a foundation-UI assumption: a fresh process lands on LAN and
  // starts a room by itself — the product behaviour — so the control is not on
  // that page at all, and the assertion reported it missing. Run
  // 34500018599 failed on exactly that and on nothing else.
  //
  // So the account page is reached through the sidebar, which is what a user
  // does. NOTHING beyond that row is clicked: no device code is minted, no
  // browser opens, no request is made and no account is touched by this test.
  //
  // The crypto gate comes first. Until libsodium has loaded, the main pane
  // shows the starting card and every page's controls are absent — so without
  // this wait a pending gate would be reported as a missing button.
  const present = (name) =>
    cdp.evaluate(`document.querySelector('[data-test="${name}"]') !== null`);
  if (
    (await waitFor(
      "the encryption library to load",
      async () => (await present("crypto-pending")) === false,
      DEADLINE.launch,
    )) &&
    (await waitFor(
      "the sidebar account row",
      async () => (await present("nav-account")) === true,
      DEADLINE.launch,
    ))
  ) {
    // A sidebar row carries its `data-test` on the `li` and its handler on the
    // `button` inside, so clicking the marked element itself would dispatch an
    // event nothing listens to and then report success.
    const clicked = await cdp.evaluate(
      '(() => { const el = document.querySelector(\'[data-test="nav-account"]\');' +
        " if (!el) return false;" +
        ' const target = el.tagName === "BUTTON" ? el : el.querySelector("button") ?? el;' +
        " target.click(); return true; })()",
    );
    check("sidebar account row clicked", clicked === true);
    if (
      await waitFor(
        "the signed-out account page",
        async () => (await present("sign-in")) === true,
        DEADLINE.launch,
      )
    ) {
      // Present, and deliberately not clicked.
      check("sign-in control present but untouched", (await present("sign-in")) === true);
    }
  }

  // ---- Profile BEFORE any second instance exists ------------------------
  //
  // The ordering matters more than it looks. Electron initialises OSCrypt in
  // native start-up, before any JavaScript — including
  // `requestSingleInstanceLock()` — has run. So a second process reaches the
  // shared profile and can settle its encryption key while the first process is
  // still the one holding an in-memory key it has not persisted.
  //
  // If that happens, the sealed identity is written under the first process's
  // key while the key that survives on disk is the second's, and every later
  // launch fails to decrypt a file that never changed — which is exactly the
  // shape run 34460496151 reported: identical `Local State`, identical
  // ciphertext, unreadable store.
  //
  // The previous revision sampled only AFTER the second instance, so it could
  // not tell "this key was always here" from "the second instance put it here".
  // This sample is the control.
  notes.push(`profile BEFORE second instance: ${JSON.stringify(profileState())}`);

  // ---- Second instance restores the first window -----------------------
  const second = spawn(installedExe, [], { stdio: "ignore" });
  if (second.pid) {
    spawnedPids.add(second.pid);
    spawnedChildren.set(second.pid, second);
  }
  const secondExited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), DEADLINE.exit);
    second.on("exit", () => {
      clearTimeout(timer);
      spawnedPids.delete(second.pid);
      spawnedChildren.delete(second.pid);
      resolve(true);
    });
  });
  check("a second launch exits instead of running alongside", secondExited);
  if (!secondExited) await killOwned(second.pid);

  const targetsAfter = (await cdpTargets(port)).filter((t) => t.type === "page");
  check("still exactly one window", targetsAfter.length === 1, `saw ${targetsAfter.length}`);
  // Identity, not merely count: a first process that had been replaced would
  // also show one window.
  check(
    "the SAME window, not a new one",
    targetsAfter[0]?.id === target1.id,
    `${target1.id} -> ${targetsAfter[0]?.id}`,
  );

  notes.push(`profile AFTER second instance: ${JSON.stringify(profileState())}`);

  const sealedBefore = hashSealed();
  check("a sealed identity was written", sealedBefore !== null);

  cdp.close();
  await killOwned(app1.pid);
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

  // ---- Crash durability, BEFORE any reinstall is involved ---------------
  //
  // The first launch above was ended with `taskkill /F`. That bypasses
  // Electron's normal shutdown, and normal shutdown is where
  // `CommitPendingWrite` flushes `Local State` — the file holding the OSCrypt
  // key that every sealed blob depends on. If the key was minted on first run
  // and never reached disk, the next launch mints a NEW one and the sealed
  // identity becomes undecryptable while remaining byte-identical.
  //
  // This step relaunches with NO reinstall in between, which is what separates
  // "a crash destroys the identity" from "a reinstall destroys the identity".
  // The first Windows job could not tell them apart, because it only ever
  // observed the store after a reinstall.
  //
  // Asserted, not merely noted. A forced termination is what a power cut or a
  // Task Manager kill looks like, and an identity that does not survive one is a
  // real durability defect, not a test artifact.
  notes.push(`profile after first launch: ${JSON.stringify(profileState())}`);
  const portR = await freeLoopbackPort();
  const appR = launchInstalled(portR);
  const attachedR = await attachToApp(portR, "the relaunched app");
  if (attachedR !== null) {
    try {
      const stateR = await attachedR.cdp.evaluate("globalThis.relayium.auth.state()");
      notes.push(`store after forced-kill relaunch, no reinstall: ${stateR.store}`);
      check(
        "secret store readable after a forced kill, WITHOUT any reinstall",
        stateR.store === "ok",
        JSON.stringify(stateR),
      );
      check("sealed identity byte-identical after the relaunch", hashSealed() === sealedBefore);
    } finally {
      attachedR.cdp.close();
    }
  }
  await killOwned(appR.pid);
  await waitFor(
    "the relaunched app's debugging endpoint to disappear",
    async () => {
      try {
        await cdpTargets(portR);
        return false;
      } catch {
        return true;
      }
    },
    DEADLINE.exit,
  );
  notes.push(`profile after relaunch: ${JSON.stringify(profileState())}`);

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
  const attached2 = await attachToApp(port2, "the reinstalled app");
  if (attached2 !== null) {
    try {
      const state2 = await attached2.cdp.evaluate("globalThis.relayium.auth.state()");
      notes.push(`store after reinstall: ${state2.store}`);
      notes.push(`profile after reinstall: ${JSON.stringify(profileState())}`);
      // Unchanged and NOT relaxed: an unreadable store here is a failure. The
      // diagnostics above exist to explain it, not to excuse it.
      check("secret store still healthy after reinstall", state2.store === "ok", JSON.stringify(state2));
      check("still signed out after reinstall", state2.signedIn === false, JSON.stringify(state2));
      check("sealed identity unchanged by the second read", hashSealed() === sealedBefore);
    } finally {
      attached2.cdp.close();
    }
  }
  await killOwned(app2.pid);

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
    check("file send verb removed", !regKeyExists(SEND_FILE_KEY));
    check("folder send verb removed", !regKeyExists(SEND_DIR_KEY));
    check(
      "SendTo shortcut removed",
      !existsSync(join(process.env.APPDATA ?? "", "Microsoft", "Windows", "SendTo", "Relayium.lnk")),
    );
    // The point of the whole guard: an uninstall must not take the keys.
    check("private data root PRESERVED by uninstall", existsSync(secretsDir), secretsDir);
    check("sealed identity preserved by uninstall", hashSealed() === sealedBefore);
  }

  await aliasPhase();
  await schemeOwnershipPhase();
  await sendToArgsOwnershipPhase();
}

/**
 * An uninstall must remove OUR association and must not touch anyone else's.
 *
 * An association is a shared, single-valued resource. If the user has since
 * pointed `relayium://` at another program, deleting it on uninstall would
 * silently break a choice they made. The uninstaller therefore compares the
 * registered command against the exact one it wrote, and this proves both
 * halves — the removal is already asserted in the main flow above; what is
 * proven here is the refusal.
 *
 * Runs last, with nothing installed and the scheme key absent. Every piece of
 * state it touches it created itself.
 */
/**
 * The other half of shortcut ownership: OUR program, somebody else's arguments.
 *
 * The target test alone is not enough. A user who repointed this entry at the
 * same executable with different arguments — a different flag, an extra switch —
 * has made a choice, and an uninstaller matching on the target would reverse it.
 * Its own install/uninstall cycle, because there is one SendTo path and the
 * target case has already spent the previous one.
 */
async function sendToArgsOwnershipPhase() {
  const sendToLink = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "SendTo", "Relayium.lnk");
  const dir = path.join(runnerTemp, "relayium acceptance", "args", "Relayium");
  owned.argsInstallParent = path.dirname(path.dirname(dir));

  const installed = await runInstaller(["/S", `/D=${dir}`], DEADLINE.install, "install for the args case");
  if (!check("args-case install exited 0", installed.ok && installed.code === 0, `exit ${installed.code}`)) return;
  if (!check("args-case install created the SendTo entry", existsSync(sendToLink), sendToLink)) return;

  // Same executable this installation wrote. Only the arguments differ.
  const ourExe = path.join(dir, "Relayium.exe");
  const foreignArgs = "--send-files --some-other-switch";
  if (!check("foreign SendTo ARGS written", writeShortcut(sendToLink, ourExe, foreignArgs))) return;
  owned.sendToLink = sendToLink;

  const un = path.join(dir, "Uninstall Relayium.exe");
  if (check("args-case uninstaller exists", existsSync(un), un)) {
    const removed = await runInstaller(["/S", `_?=${dir}`], DEADLINE.uninstall, "args-case uninstall", un);
    check("args-case uninstall exited 0", removed.ok && removed.code === 0, `exit ${removed.code}`);
  }

  const after = existsSync(sendToLink) ? readShortcut(sendToLink) : null;
  check(
    "a SendTo shortcut with FOREIGN ARGUMENTS survived our uninstall",
    after !== null && after.args === foreignArgs,
    after === null ? "(shortcut deleted)" : after.args,
  );
  notes.push("send-entry ownership: foreign arguments on our own executable preserved");
}

async function schemeOwnershipPhase() {
  if (!check("scheme key absent before the ownership case", !regKeyExists(SCHEME_KEY))) return;

  const dir = path.join(runnerTemp, "relayium acceptance", "own", "Relayium");
  owned.schemeInstallParent = path.dirname(path.dirname(dir));

  const installed = await runInstaller(["/S", `/D=${dir}`], DEADLINE.install, "install for ownership case");
  if (!check("ownership-case install exited 0", installed.ok && installed.code === 0, `exit ${installed.code}`)) return;
  check("ownership-case install registered the scheme", regKeyExists(SCHEME_KEY));

  // Somebody else takes the association over.
  const foreign = '"C:\\Windows\\System32\\notepad.exe" "%1"';
  if (!check("foreign association written", regSetDefault(SCHEME_CMD_KEY, foreign))) return;
  owned.schemeKey = true;

  // And the send verbs, in the same install. The name is the cheapest thing to
  // collide on, so the foreign values deliberately keep OUR verb name and our
  // flag — only the program differs. An uninstaller that matched on the key, on
  // the name, or on a path prefix would take all three of these with it.
  const foreignSend = '"C:\\Windows\\System32\\notepad.exe" --send-files "%1"';
  const sendOwnershipKeys = [SEND_FILE_KEY, SEND_DIR_KEY];
  let sendForeignWritten = true;
  for (const key of sendOwnershipKeys) {
    if (!regSetDefault(`${key}\\command`, foreignSend)) sendForeignWritten = false;
  }
  check("foreign send commands written", sendForeignWritten);
  owned.sendKeys = sendOwnershipKeys;

  // The SendTo shortcut equivalent: a REAL shortcut of our exact name, pointing
  // somewhere else. Our flag is kept deliberately — only the program differs —
  // so an uninstaller that matched on the name, or on the arguments alone,
  // would take it.
  const sendToLink = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "SendTo", "Relayium.lnk");
  const foreignTarget = "C:\\Windows\\System32\\notepad.exe";
  let foreignLinkWritten = false;
  if (existsSync(sendToLink)) {
    foreignLinkWritten = writeShortcut(sendToLink, foreignTarget, "--send-files");
    check("foreign SendTo shortcut written", foreignLinkWritten);
    owned.sendToLink = sendToLink;
  }

  const un = path.join(dir, "Uninstall Relayium.exe");
  if (check("ownership-case uninstaller exists", existsSync(un), un)) {
    const removed = await runInstaller(["/S", `_?=${dir}`], DEADLINE.uninstall, "ownership-case uninstall", un);
    check("ownership-case uninstall ran to completion", removed.ok, removed.reason);
    check("ownership-case uninstall exited 0", removed.code === 0, `exit ${removed.code}`);
  }

  const after = regQueryDefault(SCHEME_CMD_KEY);
  check(
    "a foreign relayium:// association SURVIVED our uninstall",
    after === foreign,
    `expected the foreign value to be untouched, got: ${after ?? "(key deleted)"}`,
  );
  for (const [what, key] of [["file", SEND_FILE_KEY], ["folder", SEND_DIR_KEY]]) {
    const value = regQueryDefault(`${key}\\command`);
    check(
      `a foreign ${what} send verb of the SAME NAME survived our uninstall`,
      value === foreignSend,
      `expected the foreign value to be untouched, got: ${value ?? "(key deleted)"}`,
    );
  }
  if (foreignLinkWritten) {
    const after = existsSync(sendToLink) ? readShortcut(sendToLink) : null;
    check(
      "a foreign SendTo TARGET of the same name survived our uninstall",
      after !== null && samePath(after.target, foreignTarget),
      after === null ? "(shortcut deleted)" : after.target,
    );
  }
  notes.push("scheme ownership: foreign association preserved, own registration removed");
  notes.push("send-entry ownership: foreign verbs and SendTo entry preserved by name-collision");
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
  notes.push("alias phase: junction preconditions created");

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
  notes.push(`alias phase: subst ${letter}: created`);

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
  // Explicit positive output. Absence of a failure line is not evidence a case
  // ran: a precondition that returned early would look identical in the log.
  notes.push(`REFUSED as expected (exit ${result.code}): ${label}`);
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
  notes.push(`INSTALLED and removed as expected: ${label}`);
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

/**
 * Metadata about Chromium's `Local State`, which is where the safeStorage key
 * lives — NOT its contents.
 *
 * Electron creates a `JsonPrefStore` at `DIR_SESSION_DATA/Local State`
 * (`shell/browser/browser_process_impl.cc`) and `OSCrypt::Init(local_state)`
 * takes the encryption key from it (`electron_browser_main_parts.cc`).
 * `safeStorage` delegates to OSCrypt rather than calling DPAPI per value, so
 * that one file is what makes every sealed blob readable.
 *
 * `main.ts` sets neither `userData` nor `sessionData`, so the profile is at
 * Electron's default and OUTSIDE the private data root this product protects.
 * Which directory that actually is on a runner is the thing to establish, so
 * both candidates are probed and reported.
 *
 * Existence, size and a whole-file digest only. The file holds a DPAPI-wrapped
 * key; nothing here reads, logs or transports its contents, and the digest is a
 * change-fingerprint, not a value that can be inverted.
 */
function profileState() {
  const out = {};
  for (const [baseLabel, base] of [["roaming", process.env["APPDATA"]], ["local", localAppData]]) {
    if (!base) continue;
    for (const name of PROFILE_DIR_CANDIDATES) {
      const label = `${baseLabel}/${name}`;
      const file = path.join(base, name, "Local State");
      if (!existsSync(file)) {
        out[label] = { present: false };
        continue;
      }
      const bytes = readFileSync(file);
      const entry = {
        present: true,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      };
      // Closed booleans and a length. The key itself is never read into a
      // variable that outlives this block, never logged, never compared.
      // Presence and size are enough to tell "no key yet" from "a key exists"
      // from "the key changed", which is the whole question.
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        const osCrypt = parsed?.os_crypt;
        entry.osCrypt = typeof osCrypt === "object" && osCrypt !== null;
        const key = entry.osCrypt ? osCrypt.encrypted_key : undefined;
        entry.encryptedKey = typeof key === "string";
        entry.encryptedKeyLength = entry.encryptedKey ? key.length : 0;
      } catch {
        entry.parseFailed = true;
      }
      out[label] = entry;
    }
  }
  return out;
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

async function cleanup() {
  // Any session still open here belongs to a phase that threw between attach
  // and its explicit close.
  for (const session of [...openSessions]) session.close();
  // Joined, not merely signalled. A directory cannot be removed while a process
  // this run started still holds a handle inside it, and `taskkill` returning is
  // not that process being gone.
  const unjoined = [];
  for (const pid of [...spawnedPids]) {
    if (!(await killOwned(pid))) unjoined.push(pid);
  }
  if (unjoined.length > 0) {
    // PRESERVE. Removing directories, releasing the drive mapping or deleting
    // the class key while a process this run started is still alive would tear
    // state out from under it and could destroy evidence of why it would not
    // die. The host is left dirty ON PURPOSE, and loudly: the next run's
    // preconditions will refuse it rather than a later run inheriting a mess
    // with no explanation.
    failures.push(
      `owned process(es) ${unjoined.join(", ")} did not exit; preserved every owned directory, ` +
        `the drive mapping and the class key rather than unwinding around a live child`,
    );
    return;
  }
  // Before the directories: a junction inside `aliasRoot` points AT the data
  // root, and removing the mapping first keeps a recursive delete from
  // following one. `rmSync` removes a junction without descending, but the
  // ordering is not something to leave to a library detail.
  if (owned.substLetter !== null) substRelease(owned.substLetter, localAppData);
  // The foreign value under this key was written by this run; the precondition
  // asserted the key absent before anything started, so nothing here predates it.
  if (owned.schemeKey) spawnSync("reg.exe", ["delete", SCHEME_KEY, "/f"], { stdio: "ignore" });
  // The foreign values this run WROTE, by the exact keys it recorded writing.
  // They are deliberately left behind by the uninstaller — that is the whole
  // assertion — so this run has to take them itself.
  for (const key of owned.sendKeys ?? []) {
    spawnSync("reg.exe", ["delete", key, "/f"], { stdio: "ignore" });
  }
  if (owned.sendToLink && existsSync(owned.sendToLink)) rmSync(owned.sendToLink, { force: true });
  // Exactly the paths this run created, each recorded at the moment it created
  // it — not derived from a path it merely knows about.
  for (const dir of [owned.schemeInstallParent, owned.argsInstallParent, owned.aliasRoot, owned.installParent, owned.dataRoot ? dataRoot : null]) {
    if (dir === null || !existsSync(dir)) continue;
    // Two things this covers, and it is the only place either is observed:
    // Windows releases a terminated process's handles asynchronously, and the
    // parent-PID poll above says nothing about descendants `/T` was asked to
    // take. A handle either goes within this bound or the directory is reported
    // as a leftover — bounded, and never silently retried forever.
    let removed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 20 && !removed; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed = !existsSync(dir);
      } catch (err) {
        lastError = err;
        await sleep(250);
      }
    }
    if (!removed) {
      // Reported, not swallowed: a path this run created and could not remove
      // is a leftover, and claiming otherwise would be false.
      failures.push(`could not remove owned directory ${dir}: ${String(lastError)}`);
    }
  }
}

main()
  .catch((err) => {
    failures.push(`threw: ${String(err?.stack ?? err)}`);
  })
  .finally(async () => {
    await cleanup();
    process.stdout.write(`RELAYIUM_INSTALLED ${JSON.stringify({ failures, notes })}\n`);
    if (failures.length > 0) {
      process.stderr.write(`installed acceptance: ${failures.length} failed\n${failures.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("installed acceptance: all assertions passed\n");
    process.exit(0);
  });
