/**
 * One real `relayium` CLI process, driven the way a person at a pipe drives it.
 *
 * Shared by every A12 interop driver whose counterpart is not a CLI
 * (`web/e2e/cli-web-pairing.mjs`, `scripts/interop/cli-android-peer.mjs`,
 * `scripts/interop/cli-mac-pairing.sh` through `cli-mac-peer.mjs`). It owns the
 * process and its transcript and nothing else: every judgement about what the
 * transcript MEANS is made by an oracle in another file, so a mistake here shows
 * up as a failed comparison there rather than as a pass this file granted.
 *
 * ## What is and is not simulated
 *
 * Nothing about the CLI is. It is the binary the caller built from the tree
 * under test, started with its real argv, reading a real pipe on stdin and
 * writing real stdout/stderr. The only things this file adds are:
 *
 *   * a transcript: every stderr line with a monotonic index and a timestamp,
 *     and stdout as the exact bytes (stdout is the peer's words only — the
 *     A10 output contract — so it is kept raw, never split or trimmed);
 *   * waits on that transcript, each with its own bound and each naming what
 *     it waited for when it runs out;
 *   * OS-level process control (SIGSTOP/SIGCONT/SIGINT) for the cancel and
 *     interrupt cells. Pausing the process is the one deterministic way to hold
 *     a receiver inside a sender's flow window without touching product code.
 *
 * Nothing secret is ever put in argv: the account bearer reaches the CLI only
 * through the credentials file under the caller's private XDG_CONFIG_HOME.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start `bin args…` with a piped stdin.
 *
 * `env` is MERGED over a scrubbed copy of this process's environment: every
 * inherited `RELAYIUM_*` variable is dropped first, so a developer's own
 * `RELAYIUM_LINK_DEBUG` or server override cannot change what the run proves.
 */
export function startCli({ bin, args, env = {}, cwd, label = "cli" }) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("RELAYIUM_")) base[k] = v;
  }
  const child = spawn(bin, args, {
    cwd,
    env: { ...base, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = Date.now();
  const lines = [];          // {i, t, text}
  let stderrTail = "";
  let stdout = Buffer.alloc(0);
  let exit = null;           // {code, signal, t}
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal, t: Date.now() - started };
      resolve(exit);
    });
    child.once("error", (err) => {
      exit = { code: null, signal: null, spawnError: String(err), t: Date.now() - started };
      resolve(exit);
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail += chunk;
    // Progress bars redraw with \r; a line is what ends in \n.
    let nl;
    while ((nl = stderrTail.indexOf("\n")) >= 0) {
      const raw = stderrTail.slice(0, nl);
      stderrTail = stderrTail.slice(nl + 1);
      const text = raw.split("\r").pop();
      lines.push({ i: lines.length, t: Date.now() - started, text });
      if (process.env.RELAYIUM_INTEROP_ECHO === "1") console.error(`  [${label}] ${text}`);
    }
  });
  child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
  // A write after the child exited must not crash the driver: the exit itself
  // is what the caller judges.
  child.stdin.on("error", () => {});

  const describe = () =>
    `${label} transcript tail:\n${lines.slice(-25).map((l) => `    ${l.text}`).join("\n")}`
    + (exit ? `\n    (exited ${JSON.stringify(exit)})` : "");

  /**
   * Wait for the first stderr line at index >= `from` matching `re`.
   * Resolves `{line, match}`. Fails when the bound runs out or the process
   * exits first — naming `what`, and quoting the transcript tail.
   */
  async function waitLine(re, what, { from = 0, timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = from; i < lines.length; i++) {
        const m = re.exec(lines[i].text);
        if (m) return { line: lines[i], match: m };
      }
      if (exit) throw new Error(`${label} exited before ${what}\n${describe()}`);
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${describe()}`);
      await sleep(50);
    }
  }

  /** How many stderr lines exist now: the `from` for "a line AFTER this point". */
  const mark = () => lines.length;

  /** Wait until stdout (the peer's words, raw) satisfies `pred(string)`. */
  async function waitStdout(pred, what, { timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = stdout.toString("utf8");
      if (pred(s)) return s;
      if (exit) throw new Error(`${label} exited before ${what}; stdout so far: ${JSON.stringify(s.slice(-500))}\n${describe()}`);
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; stdout so far: ${JSON.stringify(s.slice(-500))}\n${describe()}`);
      await sleep(50);
    }
  }

  /** One line of input: a message, or a `/command`. */
  function write(line) {
    if (line.includes("\n")) throw new Error("one input line cannot carry a newline");
    child.stdin.write(line + "\n");
  }

  function signal(sig) {
    if (exit) return false;
    try { return child.kill(sig); } catch { return false; }
  }

  async function waitExit(what, timeoutMs = 60_000) {
    const r = await Promise.race([exited, sleep(timeoutMs).then(() => null)]);
    if (!r) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} to exit (${what})\n${describe()}`);
    return r;
  }

  /** Bounded teardown for a failed run: TERM, then KILL. PID-exact. */
  async function kill() {
    if (exit) return;
    signal("SIGCONT");
    signal("SIGTERM");
    await Promise.race([exited, sleep(3_000)]);
    if (!exit) {
      signal("SIGKILL");
      await Promise.race([exited, sleep(2_000)]);
    }
  }

  return {
    child, lines, waitLine, waitStdout, write, signal, waitExit, kill, mark, describe,
    get stdout() { return stdout.toString("utf8"); },
    get stdoutHex() { return stdout.toString("hex"); },
    get exit() { return exit; },
    transcript: () => ({
      argv: args,
      stderr: lines.map((l) => l.text),
      stdout: stdout.toString("utf8"),
      exit,
    }),
  };
}

/** The line the CLI prints once a link is keyed (pair.go `linkUI.connected`). */
export const LINKED_RE = /^linked with (another relayium CLI|a Relayium app or the web page) \(end-to-end encrypted link\/1, (initiator|responder)\)$/;
/** The one verification line (pair.go `sasLinePrefix`), at column 0. */
export const SAS_RE = /^verification code \(SAS\): (\S+) — /;
/** A minting CLI hands the code off on this line (sendpair.go `printHandoff`). */
export const MINTED_RE = /^Code: (\S+)/;
/** Admission: `pair`'s own ready line (pair.go `linkUI.admitted`). */
export const ADMITTED_RE = /^connected\. Type a message and press Enter to send it\.$/;
