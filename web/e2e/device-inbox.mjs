#!/usr/bin/env node
/**
 * Device Inbox, end to end, with nothing simulated on either side.
 *
 *   cd web && npm run build && npm run test:device-inbox
 *
 * What actually runs: a real Relayium server (built from ./server, its own
 * SQLite file and blob directory), a real `relayium inbox` worker with real
 * X25519 keys it generated itself, and a real headless Chrome driving the Web
 * sender. Nothing is stubbed — the browser encrypts, uploads and seals for real,
 * and the file that lands on disk is compared byte for byte with what was sent.
 *
 * The five properties it exists to prove, in order:
 *
 *   1. **Uploaded is not saved.** With the worker stopped, the browser reports a
 *      queued delivery and the receive directory stays EMPTY. A UI that said
 *      "sent" here would be lying, and only a real receiver can show it.
 *   2. **Offline queues.** The device is offline while the file is sent, and the
 *      card says so rather than refusing the send.
 *   3. **The worker comes online and completes it.** It claims, unseals with its
 *      own private key, downloads, verifies and atomically commits. The
 *      plaintext on disk matches the plaintext the browser encrypted — which is
 *      the whole cryptographic path, browser to disk, in one assertion.
 *   4. **The browser observes `saved`.** Not inferred locally: the sender's poll
 *      sees central's own `saved` after the device asserted its commit.
 *   5. **A terminal task is not replayed.** A second worker pass leaves exactly
 *      one file — no `name (2)`, no second copy. Create-request idempotency is
 *      covered separately by the sender and server suites.
 *
 * Plus the interaction paths a component test cannot reach: a genuine DOM drop
 * carrying real `File` objects, keyboard activation of the send button, and the
 * ordinary stored-upload result exposing both terminal download paths — including
 * the verified temporary CLI route on a 390px viewport.
 *
 * The browser half runs on the Device Inbox page, not /me. That is the page the
 * product tells people to send from, so it is the page this proves can do it:
 * the drop, the queue, the worker's commit and the browser observing `saved`
 * all happen without ever visiting My Devices. /me renders the same components
 * with credential management switched on, and keeps its own coverage in the
 * component suites and the accessibility scan.
 *
 * Isolated and self-cleaning: every path is under one temporary directory, the
 * account is created by this script, and the whole tree is removed at the end.
 * It never touches production and holds no production data.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argFlag, argPresent, launchBrowser, newTab, ok, fail, sleep, withWatchdog } from "./harness.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const webDir = resolve(here, "..");
const serverDir = resolve(here, "../../server");

// Its own debug port, like every other script here: each one only pkills the
// browser on its own port, so two scripts never shoot each other.
const DEBUG_PORT = 9447;
const PORT = Number(argFlag("--port", "8123"));
const BASE = `http://127.0.0.1:${PORT}`;
const GLOBAL_TIMEOUT_MS = 10 * 60_000;
const KEEP = argPresent("--keep");

// The exact bytes that must come out the far end. Deliberately not ASCII-only:
// the manifest is JSON inside AES-GCM, and a mangled encoding would show up
// here rather than as a vague size mismatch.
const FILE_NAME = "quarterly report (final).txt";
const FILE_BODY = "device inbox end to end — 端到端 — \0ÿ binary-ish tail";

let tmp = "";
let serverProc = null;
const cleanups = [];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

async function api(path, { method = "GET", body, cookie, token } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, text, json };
}

/** What a user would see in the receive directory.
 *
 *  The receiver keeps its own staging area and journal there (`.relayium-*`),
 *  which it owns and which is not a delivery. Filtering by the dot prefix is
 *  narrow enough that a real second copy — `name (2).txt`, the receiver's
 *  collision rule — still fails the duplicate assertion below. */
const delivered = (dir) => readdirSync(dir).filter((n) => !n.startsWith("."));

/** Wait until `check()` returns truthy, or throw naming what never happened. */
async function until(what, check, timeoutMs = 60_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── the server and the CLI ────────────────────────────────────────────────

async function startServer() {
  const bin = join(tmp, "relayium-server");
  const cli = join(tmp, "relayium");
  run("go", ["build", "-o", bin, "."], { cwd: serverDir });
  run("go", ["build", "-o", cli, "./cmd/relayium"], { cwd: serverDir });
  ok("built the server and the CLI from source");

  const blobs = join(tmp, "blobs");
  mkdirSync(blobs, { recursive: true });
  const logPath = join(tmp, "server.log");
  const logs = [];
  serverProc = spawn(bin, [], {
    cwd: tmp,
    env: {
      ...process.env,
      RELAYIUM_ADDR: `127.0.0.1:${PORT}`,
      RELAYIUM_DB: join(tmp, "relayium.db"),
      RELAYIUM_BLOB_DIR: blobs,
      RELAYIUM_BASE_URL: BASE,
      RELAYIUM_STATIC: join(webDir, "dist"),
      // No env file from the developer's own checkout may leak in.
      RELAYIUM_ENV_FILE: join(tmp, "no-such.env"),
      RELAYIUM_TURN_SECRET: "",
      RELAYIUM_NODE_TOKEN: "",
      RELAYIUM_RELEASE_CHECK: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 400) logs.shift();
  };
  serverProc.stdout.on("data", capture);
  serverProc.stderr.on("data", capture);
  cleanups.push(() => {
    writeFileSync(logPath, logs.join(""));
    serverProc?.kill("SIGTERM");
  });

  await until(
    `the server to answer /healthz (log: ${logPath})`,
    async () => (await fetch(`${BASE}/healthz`).then((r) => r.text()).catch(() => "")).trim() === "ok",
    60_000,
  );
  ok(`server up on ${BASE}`);
  return { cli, serverLog: () => logs.join("") };
}

/** Create an account and return its session cookie.
 *
 *  Registration deliberately issues no session: the address has to be verified
 *  first. With no SMTP configured the server's LogMailer prints the link, which
 *  is where this reads it from — the same flow a real user walks, not a
 *  test-only shortcut that could hide a change to it. */
async function createAccount(serverLog) {
  const email = `inbox-e2e-${Date.now()}@relayium.test`;
  const password = "device-inbox-e2e-passphrase";
  const { res, text } = await api("/api/auth/register", { method: "POST", body: { email, password } });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${text}`);

  const token = await until(
    "the verification link to appear in the server log",
    () => {
      const m = new RegExp(`verify email for ${email}: \\S*[?&]token=([A-Za-z0-9_%-]+)`).exec(serverLog());
      return m ? decodeURIComponent(m[1]) : null;
    },
    30_000,
  );
  const verified = await api("/api/auth/email/verify", { method: "POST", body: { token, password } });
  if (!verified.res.ok) throw new Error(`verify failed: ${verified.res.status} ${verified.text}`);
  const setCookie = verified.res.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((c) => c.split(";")[0]).find((c) => c.includes("="));
  if (!session) throw new Error(`verification returned no session cookie: ${verified.text}`);
  ok(`account created and verified (${email})`);
  return { cookie: session, email };
}

/** Run the real device-code flow and write the CLI's credentials file. */
async function authorizeCli(cookie, configDir) {
  const start = await api("/api/cli/device/start", { method: "POST", body: {} });
  if (!start.res.ok) throw new Error(`device start failed: ${start.res.status} ${start.text}`);
  const approve = await api("/api/cli/device/approve", {
    method: "POST",
    cookie,
    body: { user_code: start.json.user_code },
  });
  if (!approve.res.ok) throw new Error(`device approve failed: ${approve.res.status} ${approve.text}`);
  const poll = await api("/api/cli/device/poll", {
    method: "POST",
    body: { device_code: start.json.device_code },
  });
  if (poll.json?.status !== "ok") throw new Error(`device poll: ${poll.text}`);

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, "credentials"),
    JSON.stringify({ server: BASE, access_token: poll.json.access_token, account_email: poll.json.account_email }, null, 2),
    { mode: 0o600 },
  );
  ok("CLI authorized through the real device-code flow");
  return poll.json.access_token;
}

// ── the browser ───────────────────────────────────────────────────────────

/** Instrumentation injected before the page's own scripts.
 *
 *  Two hooks, both about OBSERVING rather than replacing behaviour: a record of
 *  every `input.click()` (so keyboard activation of the send button is provable
 *  without opening a real OS picker), and a `File` factory the drop step uses so
 *  the dropped objects are genuine `File` instances from the page's own realm. */
const PAGE_HOOKS = `
  window.__inbox = { picker: 0 };
  const realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === "file") { window.__inbox.picker++; return; }
    return realClick.call(this);
  };
`;

/** Everything below happens inside the Device Inbox page's own operational
 *  block, so a selector that accidentally matched some other list would fail
 *  rather than quietly test a different surface. */
const BLOCK = '[data-di="devices"]';

async function openDeviceInbox(browser, cookie) {
  const tab = await newTab(browser, "about:blank", PAGE_HOOKS);
  const [name, value] = cookie.split("=");
  await tab.send("Network.enable", {});
  await tab.send("Network.setCookie", { name, value, domain: "127.0.0.1", path: "/" });
  await tab.send("Page.navigate", { url: `${BASE}/device-inbox` });
  await tab.waitFor(
    `!!document.querySelector('${BLOCK} li button.open')`,
    "the Device Inbox page itself to list an openable device",
  );
  if (await tab.evaluate(`!!document.querySelector('${BLOCK} li .sendzone')`)) {
    throw new Error("the device directory mounted send controls before a device was opened");
  }
  if (await tab.evaluate(`!!document.querySelector('${BLOCK} li button.del')`)) {
    throw new Error("a destructive revoke control is sitting in the device directory");
  }

  await tab.evaluate(`document.querySelector('${BLOCK} li button.open').focus(); true`);
  if (!(await tab.evaluate(`document.activeElement?.classList.contains('open')`))) {
    throw new Error("the device Open button did not take keyboard focus");
  }
  for (const type of ["keyDown", "char", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: type === "char" ? "\r" : undefined,
    });
  }
  await tab.waitFor(
    `!!document.querySelector('[data-di="device-workspace-heading"]') && !!document.querySelector('${BLOCK} li .sendzone')`,
    "keyboard activation to open the target device workspace and its send controls",
  );
  return tab;
}

/** A real DOM drop: a `DataTransfer` built in the page, carrying a real `File`. */
const dropScript = (name, body) => `(async () => {
  const zone = document.querySelector('${BLOCK} li .sendzone');
  const dt = new DataTransfer();
  dt.items.add(new File([new TextEncoder().encode(${JSON.stringify(body)})], ${JSON.stringify(name)}));
  zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

const statusScript = `document.querySelector('${BLOCK} li .sendstatus')?.textContent?.trim() ?? ''`;

// ── the run ───────────────────────────────────────────────────────────────

async function main() {
  tmp = mkdtempSync(join(tmpdir(), "relayium-inbox-e2e-"));
  const configDir = join(tmp, "cli-config");
  const receiveDir = join(tmp, "received");
  mkdirSync(receiveDir, { recursive: true });

  const { cli, serverLog } = await startServer();
  const { cookie } = await createAccount(serverLog);
  await authorizeCli(cookie, configDir);

  // Enrol the device: this generates the X25519 keypair, writes the private half
  // to disk BEFORE publishing the public half, and registers the capabilities.
  run(cli, ["inbox", "enable", "--dir", receiveDir, "--config-dir", configDir]);
  ok("device inbox enabled (real keys, real enrolment)");

  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT, keep: KEEP });
  try {
    const tab = await openDeviceInbox(browser, cookie);

    // ── 0. the journey needs no second page ──────────────────────────────
    // Asserted before anything else, because everything after it is only
    // meaningful if this page is where the work happens. The page must also
    // carry no revoke here: it is one mis-aimed click from a drop target, and
    // it belongs to My Devices.
    if (await tab.evaluate(`!!document.querySelector('${BLOCK} li button.del')`)) {
      throw new Error("a destructive revoke control is sitting on the send surface");
    }
    if (await tab.evaluate(`location.pathname !== "/device-inbox"`)) {
      throw new Error("the send target was only reachable after leaving /device-inbox");
    }

    // ── 2. offline queues ────────────────────────────────────────────────
    // No worker is running, so the device never heartbeated: it is offline and
    // must still be a valid target.
    const offlineText = await tab.evaluate(`document.querySelector('${BLOCK} li').textContent`);
    if (!/Offline/.test(offlineText)) throw new Error(`card does not say the device is offline: ${offlineText}`);
    if (!/queue/i.test(offlineText)) throw new Error("card does not say the file will queue while offline");
    ok("an offline device is still offered as a target on /device-inbox, and says the file queues");

    // ── the picker remains reachable inside the workspace ───────────────
    await tab.evaluate(`document.querySelector('${BLOCK} li .sendbtn').focus(); true`);
    const focused = await tab.evaluate("document.activeElement?.classList.contains('sendbtn')");
    if (!focused) throw new Error("the send button did not take keyboard focus");
    // The Open action above is the real keyboard-navigation contract added by
    // Stage 3. Invoke this native button through the page for the picker hook:
    // a trusted CDP Enter can open Chrome's headless OS chooser despite the
    // input.click observer, blocking every later evaluate. DeviceCard.test owns
    // the separate Enter -> input.click assertion.
    await tab.evaluate(`document.querySelector('${BLOCK} li .sendbtn').click(); true`);
    const pickerOpens = await tab.evaluate("window.__inbox.picker");
    if (!pickerOpens) throw new Error("the workspace send button did not open the file picker");
    ok("the workspace keeps a focusable file picker control — drag is never required");

    // ── 1. a real drop, and uploaded is NOT saved ────────────────────────
    await tab.evaluate(dropScript(FILE_NAME, FILE_BODY));
    await tab.waitFor(
      `/Uploaded to Relayium/.test(${statusScript})`,
      "the sender to report the ciphertext uploaded",
    );
    const queuedStatus = await tab.evaluate(statusScript);
    if (/Saved on the device/.test(queuedStatus)) {
      throw new Error(`the sender claimed delivery before any device took the task: ${queuedStatus}`);
    }
    if (delivered(receiveDir).length !== 0) {
      throw new Error("something landed in the receive directory before the worker ever ran");
    }
    ok(`a real drop uploaded ciphertext and did NOT claim delivery — "${queuedStatus}"`);

    // The account's own file list must not show it: a task-purpose object has no
    // link, no list row and no public endpoint (protocol §24).
    const files = await api("/api/files", { cookie });
    if ((files.json?.files ?? []).length !== 0) {
      throw new Error(`the delivery ciphertext appeared in the account file list: ${files.text}`);
    }
    ok("the delivery ciphertext is absent from the account file list");

    // ── 3. the worker comes online and completes it ──────────────────────
    run(cli, ["inbox", "run", "--once", "--config-dir", configDir]);
    const landed = delivered(receiveDir);
    if (landed.length !== 1 || landed[0] !== FILE_NAME) {
      throw new Error(`expected exactly ${JSON.stringify(FILE_NAME)} in the receive directory, got ${JSON.stringify(landed)}`);
    }
    const onDisk = readFileSync(join(receiveDir, FILE_NAME), "utf8");
    if (onDisk !== FILE_BODY) {
      throw new Error("the plaintext on disk is not the plaintext the browser encrypted");
    }
    ok("the worker unsealed, verified and atomically saved the browser's file, byte for byte");

    // ── 4. the browser observes saved ────────────────────────────────────
    await tab.waitFor(
      `/Saved on the device/.test(${statusScript})`,
      "the sender's poll to observe central's own saved state",
      90_000,
    );
    const savedStatus = await tab.evaluate(statusScript);
    if (/not saved on the device yet/.test(savedStatus)) {
      throw new Error(`the card still says the file is not saved: ${savedStatus}`);
    }
    ok(`the browser observed the device's own commit — "${savedStatus}"`);

    // ── 5. a terminal task is not replayed ───────────────────────────────
    run(cli, ["inbox", "run", "--once", "--config-dir", configDir]);
    const after = delivered(receiveDir);
    if (after.length !== 1 || after[0] !== FILE_NAME) {
      // A second copy would arrive as `name (2).txt` — the receiver's collision
      // rule — so an exact one-entry match is what proves nothing was delivered
      // twice, not merely that the count did not grow.
      throw new Error(`a second worker pass duplicated the delivery: ${JSON.stringify(after)}`);
    }
    ok("a repeated worker pass delivered nothing twice");

    // The device space is navigation inside this page, not a trap. Returning
    // removes the send controls from the directory again and never exposes a
    // credential-management action there.
    await tab.evaluate(`document.querySelector('[data-di="device-back"]').click()`);
    await tab.waitFor(
      `!document.querySelector('[data-di="device-workspace-heading"]') && !!document.querySelector('${BLOCK} li button.open')`,
      "Back to return to the device directory",
    );
    if (await tab.evaluate(`!!document.querySelector('${BLOCK} .sendzone, ${BLOCK} button.del')`)) {
      throw new Error("returning to the device directory left send or revoke controls mounted");
    }
    ok("Back returns to the device directory without exposing send or revoke controls there");

    // ── product entry: an ordinary link upload explains BOTH CLI paths ─────
    // This is the sender's page, not the recipient /d/ page. The owner found
    // the no-persistent-install route only existed after opening the recipient
    // link, so the person who just created the link had no way to tell anyone
    // it existed. Exercise the real upload against the same real central and
    // inspect the built UI at phone width.
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await tab.send("Page.navigate", { url: `${BASE}/offline-transfer` });
    await tab.waitFor("!!document.querySelector('.stored .pick')", "stored upload picker");
    await tab.evaluate(`(() => {
      const zone = document.querySelector('.stored .pick');
      const dt = new DataTransfer();
      dt.items.add(new File([new TextEncoder().encode('temporary downloader product path')], 'terminal-path.txt'));
      zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await tab.waitFor("!!document.querySelector('.stored details.temp-cli')", "sender result no-install entry", 60_000);
    const terminalResult = await tab.evaluate(`(() => {
      const details = document.querySelector('.stored details.temp-cli');
      const summary = details?.querySelector('summary');
      const before = summary?.getBoundingClientRect();
      details.open = true;
      const blocks = [...details.querySelectorAll('pre')].map((e) => e.textContent ?? '');
      const leaked = [...document.querySelectorAll('.stored a[href], .stored img[src]')]
        .some((e) => (e.getAttribute('href') ?? e.getAttribute('src') ?? '').includes('#k='));
      return {
        summary: summary?.textContent?.trim() ?? '',
        visible: !!before && before.width > 0 && before.height > 0 && before.right <= document.documentElement.clientWidth + 1,
        saysCiphertext: /ciphertext/i.test(details.textContent ?? ''),
        posix: blocks.some((s) => s.includes('openssl dgst') && s.includes("trap 'rm -rf") && s.includes('#k=')),
        windows: blocks.some((s) => s.includes('relayium.exe') && s.includes('Remove-Item') && s.includes('#k=')),
        leaked,
      };
    })()`);
    if (!terminalResult.visible || !terminalResult.summary) {
      throw new Error(`sender no-install entry is not discoverable at 390px: ${JSON.stringify(terminalResult)}`);
    }
    if (!terminalResult.saysCiphertext || !terminalResult.posix || !terminalResult.windows || terminalResult.leaked) {
      throw new Error(`sender terminal guidance is incomplete or leaks the key: ${JSON.stringify(terminalResult)}`);
    }
    ok("stored-upload result exposes installed and verified temporary CLI paths at 390px");

    if (tab.errors.length) throw new Error(`page console errors:\n${tab.errors.join("\n")}`);
  } finally {
    await close();
  }
}

await withWatchdog("device-inbox e2e", GLOBAL_TIMEOUT_MS, async () => {
  try {
    await main();
    console.log("\n  device inbox: browser → central → CLI → disk, verified end to end\n");
  } catch (err) {
    fail("device-inbox e2e", err);
  } finally {
    for (const c of cleanups.reverse()) {
      try { c(); } catch { /* best effort */ }
    }
    await sleep(300);
    if (tmp && !KEEP) {
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* a temp directory left behind is harmless */ }
    } else if (tmp) {
      console.log(`  kept: ${tmp}`);
    }
    if (!existsSync(join(webDir, "dist", "index.html"))) {
      console.error("  note: web/dist is missing — run `npm run build` first");
    }
  }
});
