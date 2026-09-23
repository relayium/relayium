#!/usr/bin/env node
/**
 * **A12: one round of the CLI ↔ macOS app cell.**
 *
 * Driven by `scripts/interop/cli-mac-acceptance.sh`, which owns the server, the
 * account and the macOS peer process (`LocalTransferPeer --role pair-link`: the
 * app's own `LinkWorkspaceModel` assembled by `AppEnvironment`, exactly as
 * `native-web-pairing-acceptance.sh` uses it against a browser). This file
 * drives the two live endpoints of one round:
 *
 *   * the Mac through its loopback, bearer-guarded control API (`/start`,
 *     `/drive`, `/observed`) — the bearer comes from the environment;
 *   * a real `relayium pair --accept` process.
 *
 * The Mac peer ACCEPTS every offered batch itself (`LinkCounterpart` — a
 * policy on the receiving side of a decision the other end makes) and offers
 * no decline or cancel through its control API, so this cell covers text,
 * files, a directory tree and consecutive batches in both directions, both code
 * roles and both link roles — and NOT reject/cancel, which stay browser- and
 * Android-proven. That limit is reported, not papered over.
 *
 * Everything observed goes to `--out`; `cli-mac-oracle.py` judges it.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import process from "node:process";
import { ADMITTED_RE, LINKED_RE, MINTED_RE, SAS_RE, startCli } from "./cli-process.mjs";

const arg = (name, dflt = "") => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};
const PLAN = JSON.parse(readFileSync(arg("--plan"), "utf8"));
const OUT = arg("--out");
const CLI_BIN = arg("--cli");
const XDG = arg("--xdg");
const ORIGIN = arg("--origin");
const MAC_PORT = Number(arg("--mac-port"));
const TOKEN = process.env.RELAYIUM_ACCEPTANCE_CONTROL_TOKEN ?? "";
if (!OUT || !CLI_BIN || !XDG || !ORIGIN || !MAC_PORT || !TOKEN) {
  console.error("usage: cli-mac-peer.mjs --plan F --out F --cli BIN --xdg DIR --origin URL --mac-port N (control bearer in RELAYIUM_ACCEPTANCE_CONTROL_TOKEN)");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function control(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${MAC_PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function waitMac(pred, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try { last = await control("GET", "/observed"); } catch (e) { last = { error: String(e) }; }
    if (pred(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the Mac: ${what}; last /observed: ${JSON.stringify(last).slice(0, 1500)}`);
    await sleep(400);
  }
}

const observed = { round: PLAN.round, codeRole: PLAN.codeRole, code: "", steps: [], mac: null, macStatus: null, cli: null, complete: false };
const write = () => {
  const tmp = `${OUT}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(observed, null, 2) + "\n");
  renameSync(tmp, OUT);
};
const step = (s) => { observed.steps.push(s); console.log(`  ✓ ${s}`); };

let cli = null;
for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.once(sig, () => { Promise.resolve(cli?.kill()).finally(() => { try { write(); } catch {} process.exit(code); }); });
}

const macFiles = (o) => (o.files ?? []);
const isOpen = (o) => String(o.linkPhase ?? "").startsWith("open(");

async function run() {
  const args = ["pair", "--server", ORIGIN, "--accept", "--dest", PLAN.dest];
  const env = { XDG_CONFIG_HOME: XDG };
  if (PLAN.codeRole === "mac") {
    await control("POST", "/start", { action: "create" });
    for (let i = 0; i < 100 && !observed.code; i++) {
      observed.code = (await control("GET", "/status")).code ?? "";
      if (!observed.code) await sleep(300);
    }
    if (!observed.code) throw new Error(`the Mac never minted a code: ${JSON.stringify(await control("GET", "/status"))}`);
    step(`the Mac minted ${observed.code}`);
    cli = startCli({ bin: CLI_BIN, args: [...args, observed.code], env, label: "cli" });
  } else {
    cli = startCli({ bin: CLI_BIN, args, env, label: "cli" });
    observed.code = (await cli.waitLine(MINTED_RE, "the CLI to mint", { timeoutMs: 30_000 })).match[1];
    step(`the CLI minted ${observed.code}`);
    await control("POST", "/start", { action: "join", code: observed.code });
  }

  const linked = await cli.waitLine(LINKED_RE, "the Mac to link", { timeoutMs: 120_000 });
  await cli.waitLine(SAS_RE, "the CLI's SAS line", { timeoutMs: 30_000 });
  await cli.waitLine(ADMITTED_RE, "admission", { timeoutMs: 60_000 });
  const opened = await waitMac(isOpen, "an OPEN link/1 workspace", 120_000);
  if (opened.legacyFallback) throw new Error(`the Mac fell back to the legacy wire: ${JSON.stringify(opened.legacyFallback)}`);
  step(linked.line.text);

  // text both ways
  await control("POST", "/drive", { command: "message", body: PLAN.macMessage });
  await cli.waitStdout((s) => s.includes(PLAN.macMessage + "\n"), "the Mac's message");
  cli.write(PLAN.cliMessage);
  await waitMac((o) => (o.messages ?? []).includes(PLAN.cliMessage), "the CLI's message");
  step("text both ways");

  // mac → cli: two consecutive single-file batches (the control API's shape)
  for (const [i, f] of PLAN.macFiles.entries()) {
    const from = cli.mark();
    await control("POST", "/drive", { command: "files", name: f.name, contents: f.contents });
    await cli.waitLine(/^saved: every file verified and written to disk in /, `the CLI to save the Mac's batch ${i + 1}`, { from, timeoutMs: 120_000 });
  }
  step("mac → cli: two consecutive batches saved");

  // cli → mac: flat files, then a directory tree
  for (const [label, srcs, count] of [
    ["flat", PLAN.cliBatches.flat.map((e) => e.src), PLAN.cliBatches.flat.length],
    ["dir", [PLAN.cliBatches.dir.src], PLAN.cliBatches.dir.entries.length],
  ]) {
    const before = macFiles(await control("GET", "/observed")).length;
    const from = cli.mark();
    cli.write(`/send ${srcs.map((p) => JSON.stringify(p)).join(" ")}`);
    await cli.waitLine(/^delivered: the other side verified and saved the files$/, `the Mac to save the CLI's ${label} batch`, { from, timeoutMs: 120_000 });
    await waitMac((o) => macFiles(o).length >= before + count, `the Mac's receipts for the ${label} batch`);
  }
  step("cli → mac: flat batch and directory tree delivered");

  observed.mac = await control("GET", "/observed");
  observed.macStatus = await control("GET", "/status").catch(() => null);
  cli.write("/quit");
  const exit = await cli.waitExit("/quit", 60_000);
  step(`the CLI quit (exit ${exit.code})`);
  observed.complete = true;
}

run().catch((err) => {
  console.error(`  ✗ ${err?.stack ?? err}`);
  process.exitCode = 1;
}).finally(async () => {
  if (!observed.mac) observed.mac = await control("GET", "/observed").catch((e) => ({ error: String(e) }));
  if (cli) { await cli.kill(); observed.cli = cli.transcript(); }
  write();
  process.exit(process.exitCode ?? 0);
});
