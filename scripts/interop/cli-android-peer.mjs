#!/usr/bin/env node
/**
 * **A12: the CLI half of the CLI ↔ Android emulator cell.**
 *
 * Driven by `scripts/interop/cli-android-acceptance.sh`. The Android half is
 * the app's own `TransferViewModel`, driven by the unchanged instrumentation
 * `InteropAcceptanceTest` — the same one `android-interop-acceptance.sh` runs
 * against a browser. That instrumentation speaks to its peer through an
 * in-band protocol of ordinary text messages, and this file plays the peer's
 * side of it with a real `relayium pair` process:
 *
 *   1. the CLI sends one message; the Android half answers with its own;
 *   2. the CLI `/send`s a flat multi-entry batch (a >192 KiB body, a zero-byte
 *      file, a small one) — saved by Android, or cancelled by Android on
 *      acceptance in a `receive`-cancel round;
 *   3. on Android's `relayium-e2e:send-again` the CLI `/send`s a second batch
 *      on the same link;
 *   4. Android sends two batches (`--accept` saves them) and a last message;
 *   5. the CLI sends `relayium-e2e:done`, and Android leaves.
 *
 * The `send`-cancel round of the browser cell is NOT played: it needs the peer
 * to hold its first durable write and SAY so in band while holding, which a
 * CLI process cannot do (pausing it would also silence it). That cell stays
 * browser-only and is reported as such.
 *
 * Everything observed goes to `--out`; the comparisons are made by
 * `scripts/interop/cli-android-oracle.py`.
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
const CODE_FILE = arg("--code-file");
if (!OUT || !CLI_BIN || !XDG || !ORIGIN || !CODE_FILE) {
  console.error("usage: cli-android-peer.mjs --plan F --out F --cli BIN --xdg DIR --origin URL --code-file F");
  process.exit(2);
}

const SEND_AGAIN = "relayium-e2e:send-again";
const DONE = "relayium-e2e:done";

/**
 * Every terminal line `relayium pair` prints for an OUTBOUND batch — the
 * families of `linkUI.report` (server/cmd/relayium/pair.go, lane "file"):
 * delivered / not sent / not delivered / not confirmed / cancelled after every
 * byte was sent, and the `file transfer: <code>` fallback for a code it does
 * not name. The receive-cancel round waits for ANY of them, so an outcome the
 * round does not accept ends it at once instead of after the whole bound.
 */
const OUTBOUND_TERMINAL_RE =
  /^(delivered: |not sent: |not delivered: |not confirmed: |cancelled after every byte was sent|file transfer: )/;
/** The only two terminal lines a receive-cancel round accepts (unchanged). */
const RECEIVE_CANCEL_ACCEPTED_RE =
  /^(not delivered: the other side stopped the transfer|not sent: the other side declined the files)$/;

const observed = { round: PLAN.round, codeRole: PLAN.codeRole, cancel: PLAN.cancel, code: "", steps: [], cli: null, complete: false };
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

async function run() {
  const args = ["pair", "--server", ORIGIN, "--accept", "--dest", PLAN.dest];
  const env = { XDG_CONFIG_HOME: XDG };
  if (PLAN.codeRole === "cli") {
    cli = startCli({ bin: CLI_BIN, args, env, label: "cli" });
    const { match } = await cli.waitLine(MINTED_RE, "the CLI to mint a code", { timeoutMs: 30_000 });
    observed.code = match[1];
  } else {
    observed.code = PLAN.code;
    cli = startCli({ bin: CLI_BIN, args: [...args, observed.code], env, label: "cli" });
  }
  // The shell starts the instrumentation only once it can read the code.
  writeFileSync(CODE_FILE, observed.code);
  step(`code ${observed.code} (minted by ${PLAN.codeRole === "cli" ? "the CLI" : "the account API"})`);

  const linked = await cli.waitLine(LINKED_RE, "the Android app to link", { timeoutMs: 240_000 });
  await cli.waitLine(SAS_RE, "the CLI's SAS line", { timeoutMs: 30_000 });
  await cli.waitLine(ADMITTED_RE, "admission", { timeoutMs: 60_000 });
  step(linked.line.text);

  cli.write(PLAN.cliMessage);
  await cli.waitStdout((s) => s.includes(PLAN.androidMessage + "\n"), "the Android message", { timeoutMs: 120_000 });
  step("text both ways");

  let from = cli.mark();
  cli.write(`/send ${PLAN.first.map((e) => JSON.stringify(e.src)).join(" ")}`);
  if (PLAN.cancel === "receive") {
    // Android cancels right after accepting. Whether the CLI sees that as a
    // STOP (bytes had started) or a DECLINE (the accept and the cancel both
    // landed before the first byte) is the receiver's timing, and both mean
    // "nothing of this batch was delivered"; the oracle accepts exactly one.
    //
    // Any OTHER terminal line is refused here, at once — it is never a pass.
    // Notably, the CLI labels a refusal that arrives after its last byte went
    // out "could not save the files" whatever the receiver's reason was (the
    // refusal frame carries none), so that line alone cannot tell a receiver's
    // cancel from a real save failure: the exact line is kept for diagnosis,
    // with whether Android had already asked for the retry. No second batch is
    // sent and the round is not complete.
    const { line } = await cli.waitLine(OUTBOUND_TERMINAL_RE,
      "Android to stop or decline the first batch", { from, timeoutMs: 180_000 });
    observed.firstBatchOutcome = line.text;
    if (!RECEIVE_CANCEL_ACCEPTED_RE.test(line.text)) {
      // A snapshot of what is already on stdout; the predicate answers at
      // once, so this adds no wait.
      let seen = false;
      await cli.waitStdout((s) => { seen = s.includes(SEND_AGAIN + "\n"); return true; },
        "a snapshot of the CLI's stdout", { timeoutMs: 0 });
      observed.sendAgainSeenAtRefusal = seen;
      throw new Error(`the first batch of a receive-cancel round ended "${line.text}", not a stop or a decline `
        + `(Android had ${seen ? "already" : "not yet"} asked for the retry)\n${cli.describe()}`);
    }
    step(`first batch refused by the receiving app: "${line.text}"`);
  } else {
    await cli.waitLine(/^delivered: the other side verified and saved the files$/, "Android to save the first batch", { from, timeoutMs: 180_000 });
    step("first batch delivered");
  }

  await cli.waitStdout((s) => s.includes(SEND_AGAIN + "\n"), "Android to ask for the second batch", { timeoutMs: 180_000 });
  from = cli.mark();
  cli.write(`/send ${PLAN.second.map((e) => JSON.stringify(e.src)).join(" ")}`);
  await cli.waitLine(/^delivered: the other side verified and saved the files$/, "Android to save the second batch", { from, timeoutMs: 180_000 });
  step("second batch delivered");

  await cli.waitStdout((s) => s.includes(PLAN.postMessage + "\n"), "Android's last message (after its two batches)", { timeoutMs: 300_000 });
  // Android sends that message only after the CLI verified both of its batches
  // (its `sendBatch` waits on the peer's COMPLETE), so both saves must already
  // be reported; the oracle still reads the tree off disk itself.
  const saved = cli.lines.filter((l) => /^saved: every file verified and written to disk in /.test(l.text)).length;
  if (saved !== 2) throw new Error(`the CLI reported ${saved} saved batch(es) before Android's last message, not 2\n${cli.describe()}`);
  step("Android's two batches saved and its last message shown");
  cli.write(DONE);
  const exit = await cli.waitExit("Android leaving after DONE", 180_000);
  step(`Android left; the CLI exited ${exit.code}`);
  observed.complete = true;
}

run().catch((err) => {
  console.error(`  ✗ ${err?.stack ?? err}`);
  process.exitCode = 1;
}).finally(async () => {
  if (cli) { await cli.kill(); observed.cli = cli.transcript(); }
  write();
  process.exit(process.exitCode ?? 0);
});
