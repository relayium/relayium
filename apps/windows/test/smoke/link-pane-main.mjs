// The link pane, in a real renderer, driven through the real DOM.
//
// The realtime lane renders this screen for real. It cannot make it FAIL in
// most of the ways it can fail: no relay expires on cue, no signalling socket
// drops to order, no peer floods the text lane, and the publish helper hands
// back one reason rather than ten. All of that has copy, and none of it had
// ever been displayed.
//
// What only this can see: that a named ending REPLACES the status line rather
// than sitting beside it, that the two live-link warnings appear and then do
// not outlive the link, that Start again replaces Cancel and dismisses the
// ending, that each publish-failure reason is its own sentence, and that the
// text lane no longer goes silent for two of its six errors.
//
// The room and its workspace are synthetic in-page stand-ins: no main process,
// no transport, no peer.

import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const failures = [];
let checks = 0;
let step = "startup";
const at = (next) => {
  step = next;
};
const check = (name, ok, detail) => {
  checks += 1;
  if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`);
  // RETURNED, so `if (!check(...)) return;` means what it reads as.
  //
  // Not cosmetic. A guard written that way against a `check` returning
  // undefined makes its function return on the FIRST line, and the run stays
  // green — a scenario that never executes reports nothing. That happened in
  // `smoke-main.mjs`, where the idiom was borrowed from
  // `installed-acceptance.mjs`, whose `check` does return. Every one of these
  // files is read the same way by anyone writing a new scenario, so they now
  // answer the same way.
  return ok;
};
const equal = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const [bundleDir, userDataDir, shotDir] = process.argv.slice(2);
if (!bundleDir || !userDataDir) {
  process.stdout.write(
    `RELAYIUM_LINK_UI ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();


/** Every publish-failure reason the contract carries. */
const REASONS = [
  "unsupported", "helper-unavailable", "timeout", "cancelled", "cleanup-uncertain",
  "io-failed", "internal", "exists", "permission", "no-space", "in-use", "gone",
  "name-too-long",
];

/** Every named text-lane error. `""` is the lane having none. */
const TEXT_ERRORS = ["tooLong", "flooding", "unsupported", "peerBusy", "selfBusy", "failed", "refused"];

/** Capture the pane, refusing to claim a capture that shows nothing. */
async function shoot(page, name) {
  if (!shotDir) return;
  const image = await page.capturePage();
  const bitmap = image.toBitmap();
  if (bitmap.length === 0) {
    failures.push(`screenshot ${name}: empty capture`);
    return;
  }
  let distinct = false;
  for (let i = 4; i < bitmap.length; i += 1) {
    if (bitmap[i] !== bitmap[0] || bitmap[i + 1] !== bitmap[1] || bitmap[i + 2] !== bitmap[2]) {
      distinct = true;
      break;
    }
  }
  if (!distinct) {
    failures.push(`screenshot ${name}: a single flat colour shows nothing`);
    return;
  }
  writeFileSync(path.join(shotDir, `${name}.png`), image.toPNG());
  checks += 1;
}

const rendererErrors = [];

async function main() {
  await app.whenReady();
  const window_ = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const page = window_.webContents;
  page.on("console-message", (_e, level, message) => {
    if (level >= 2) rendererErrors.push(message);
  });
  page.on("render-process-gone", (_e, details) => {
    failures.push(`the renderer died: ${JSON.stringify(details)}`);
  });

  if (shotDir) mkdirSync(shotDir, { recursive: true });
  await window_.loadURL(pathToFileURL(path.join(bundleDir, "index.html")).toString());
  const js = (code) => page.executeJavaScript(code, true);

  await js(`
    window.__tick = () => new Promise((r) => setTimeout(r, 30));
    window.__text = (s) => { const e = document.querySelector(s); return e === null ? null : e.textContent.replace(/\\s+/g, " ").trim(); };
    window.__count = (s) => document.querySelectorAll(s).length;
    window.__attr = (s, n) => { const e = document.querySelector(s); return e === null ? null : e.getAttribute(n); };
    window.__click = async (s) => {
      const e = document.querySelector(s);
      if (e === null) return false;
      // A disabled control is NOT clicked, and saying so is the point. The
      // helper this was copied from returned true here, so the first run of
      // this file reported success for pressing a button that is disabled by
      // design. Fixed once already in the resident driver; the OS-entry one
      // still has the weak version. (No backticks in this comment: it lives
      // inside a template literal.)
      if (e.disabled === true) return false;
      e.click();
      await window.__tick();
      return true;
    };
    window.__set = async (fn, ...args) => { window.__linkHarness[fn](...args); await window.__tick(); };
    window.__texts = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent.replace(/\\s+/g, " ").trim());
    true;
  `);
  check("the harness mounted", await js(`typeof window.__linkHarness === "object"`));

  at("a live link");
  equal("the connected card renders", await js(`window.__count('[data-test="drop-refused"], .drop')`) >= 1, true);
  equal("no ending sentence on a live link", await js(`window.__count('[data-test="link-end-reason"]')`), 0);
  equal("and no warnings by default", await js(`window.__count('[data-test="link-relay-expiring"]')`), 0);
  equal("nor a recovery warning", await js(`window.__count('[data-test="link-no-recovery"]')`), 0);

  at("the two warnings are warnings");
  await js(`window.__set("setWarnings", true, true)`);
  equal("the relay warning appears", await js(`window.__count('[data-test="link-relay-expiring"]')`), 1);
  // A warning, not a state: everything below it still works.
  check("and the send controls are still there", (await js(`window.__count('.drop label.button')`)) >= 1);
  await js(`window.__set("setWarnings", false, false)`);
  equal("the recovery warning appears", await js(`window.__count('[data-test="link-no-recovery"]')`), 1);
  const recovery = await js(`window.__text('[data-test="link-no-recovery"]')`);
  check("and it says the link cannot be restored", /cannot be restored/i.test(recovery ?? ""), recovery);
  await shoot(page, "01-en-warnings");

  at("a warning does not outlive its link, IN the one tick where both are true");
  // The window this guard exists for, and the first version of this file did
  // not reach it: with the status already off `open`, the connected card is
  // gone and the warnings are absent whatever the guard says — removing
  // `!terminal` left every assertion green.
  //
  // `mixed-session.svelte.ts` sets `endReason` and only THEN calls `close()`,
  // so there is a tick where the reason is named and the status is still
  // `open`. That is where the guard earns its place.
  await js(`window.__set("setWarnings", true, false)`);
  await js(`window.__set("setEndReason", "relayExpired")`);
  equal("no relay warning once the link is named as ended", await js(`window.__count('[data-test="link-relay-expiring"]')`), 0);
  equal("no recovery warning either", await js(`window.__count('[data-test="link-no-recovery"]')`), 0);
  await js(`window.__set("setEndReason", "")`);
  await js(`window.__set("setWarnings", false, true)`);

  at("a warning does not outlive its link");
  // Both are guarded on `!terminal`. The workspace getters also answer safely
  // once the link is gone, so this proves the SURFACE holds the rule too.
  await js(`window.__set("setWarnings", true, false)`);
  // An ending arrives with a status that is no longer `open` — the teardown
  // publishes both. Setting only the reason would leave the pane on its
  // CONNECTED branch, where the ending card does not live, and the first run of
  // this file did exactly that and reported nulls for four assertions.
  await js(`window.__set("setStatus", "idle")`);
  await js(`window.__set("setEndReason", "relayExpired")`);
  equal("no relay warning under an ended link", await js(`window.__count('[data-test="link-relay-expiring"]')`), 0);
  equal("no recovery warning either", await js(`window.__count('[data-test="link-no-recovery"]')`), 0);
  await js(`window.__set("setWarnings", false, true)`);

  at("a named ending replaces the status line");
  equal("the ending is stated", await js(`window.__count('[data-test="link-end-reason"]')`), 1);
  // The whole point: not beside "Not connected", instead of it.
  equal("and the raw status word is gone", await js(`window.__count('[data-test="link-status"]')`), 0);
  const relayEnd = await js(`window.__text('[data-test="link-end-reason"]')`);
  check("it names the relay limit", /relay time limit/i.test(relayEnd ?? ""), relayEnd);

  await js(`window.__set("setEndReason", "signalingLost")`);
  const signalEnd = await js(`window.__text('[data-test="link-end-reason"]')`);
  check("a lost socket says something else entirely", signalEnd !== relayEnd, `${relayEnd} / ${signalEnd}`);
  check("and says it cannot be restored", /could not be restored/i.test(signalEnd ?? ""), signalEnd);
  await shoot(page, "02-en-ended");

  at("the way out of a terminal state");
  equal("Start again is offered", await js(`window.__count('[data-test="link-restart"]')`), 1);
  // Cancel stops something in progress. There is nothing in progress.
  equal("and Cancel is not", await js(`window.__count('[data-test="link-cancel"]')`), 0);
  check("it presses", await js(`window.__click('[data-test="link-restart"]')`));
  const afterRestart = await js(`window.__linkHarness.calls()`);
  equal("it dismisses the ending", afterRestart.dismissLinkEnd, 1);
  // NOT disconnect: that would set userStopped and offer to rebuild the very
  // link whose relay just expired.
  equal("and does NOT disconnect as well", afterRestart.disconnect, 0);

  at("a plain failure is terminal too");
  await js(`window.__set("setEndReason", "")`);
  await js(`window.__set("setStatus", "failed")`);
  equal("with no reason to name, the status word returns", await js(`window.__count('[data-test="link-status"]')`), 1);
  equal("and Start again is still what is offered", await js(`window.__count('[data-test="link-restart"]')`), 1);

  at("connecting is not terminal");
  await js(`window.__set("setStatus", "requesting")`);
  equal("Cancel comes back", await js(`window.__count('[data-test="link-cancel"]')`), 1);
  equal("and Start again goes", await js(`window.__count('[data-test="link-restart"]')`), 0);
  await js(`window.__set("setStatus", "open")`);

  at("every publish-failure reason is its own sentence");
  // The receipt renders inside a FINISHED incoming transfer's own card, on the
  // connected branch. Both have to be true or nothing is on screen.
  await js(`window.__set("setStatus", "open")`);
  await js(`window.__set("setRecvDone", true)`);
  const sentences = new Map();
  for (const reason of REASONS) {
    await js(`window.__set("setReceipt", ${JSON.stringify(reason)})`);
    const said = await js(`window.__text('[data-test="recv-failed"]')`);
    check(`${reason} says something`, (said ?? "").length > 0, `${reason}: ${said}`);
    sentences.set(reason, said);
  }
  // The three that used to share "Could not write to the folder you chose."
  const generic = sentences.get("io-failed");
  for (const reason of ["no-space", "in-use", "exists", "permission", "gone", "name-too-long"]) {
    check(`${reason} is not the generic write failure`, sentences.get(reason) !== generic, sentences.get(reason));
  }
  check(
    "a full disk names the disk",
    /free space/i.test(sentences.get("no-space") ?? ""),
    sentences.get("no-space"),
  );
  await shoot(page, "03-en-receipt");
  await js(`window.__set("setReceipt", null)`);
  await js(`window.__set("setRecvDone", false)`);

  at("the text lane no longer goes silent");
  for (const key of TEXT_ERRORS) {
    await js(`window.__set("setText", "failed", ${JSON.stringify(key)})`);
    const said = await js(`window.__text('[data-test="text-error"]')`);
    check(`${key} is said out loud`, (said ?? "").length > 0, `${key}: ${said}`);
  }
  await js(`window.__set("setText", "open", "")`);
  equal("and nothing is said when the lane is fine", await js(`window.__count('[data-test="text-error"]')`), 0);

  at("a connection that could not open says WHY");
  // The defect this scenario exists for: `mixed-text-session` already stores
  // the cause — `peerBusy` when the other device answered busy, `unsupported`
  // when its build cannot hold a conversation — and Windows already has both
  // sentences. They rendered on the message card, which is gated on the link
  // being OPEN, so at the moment the connection failed the correct sentence
  // was computed, stored, and on a card that could not be on screen.
  await js(`window.__set("setStatus", "failed")`);
  await js(`window.__set("setText", "peerBusy", "peerBusy")`);
  const busySaid = await js(`window.__text('[data-test="link-lane-reason"]')`);
  check("a busy peer is named", /busy/i.test(busySaid ?? ""), busySaid);
  // And it replaces the bare status word, as a named ending does.
  equal("the generic status word gives way", await js(`window.__count('[data-test="link-status"]')`), 0);

  // THIS device being engaged is the opposite advice, and used to be the same
  // sentence: "The other device is busy" for a link the user themselves holds.
  await js(`window.__set("setText", "peerBusy", "selfBusy")`);
  const selfSaid = await js(`window.__text('[data-test="link-lane-reason"]')`);
  check("and this PC being engaged says something else", selfSaid !== busySaid && (selfSaid ?? "").length > 0, selfSaid);
  check("naming THIS PC rather than the peer", /this pc/i.test(selfSaid ?? ""), selfSaid);

  await js(`window.__set("setText", "unsupported", "unsupported")`);
  const oldSaid = await js(`window.__text('[data-test="link-lane-reason"]')`);
  check("an older peer is named differently", oldSaid !== busySaid && (oldSaid ?? "").length > 0, oldSaid);

  // A lane error left over from an earlier conversation is NOT a caption for
  // this failure. Only the two that say why a connection did not open.
  await js(`window.__set("setText", "failed", "tooLong")`);
  equal("an unrelated lane error is not borrowed", await js(`window.__count('[data-test="link-lane-reason"]')`), 0);
  equal("and the status word comes back", await js(`window.__count('[data-test="link-status"]')`), 1);
  await js(`window.__set("setText", "open", "")`);
  await js(`window.__set("setStatus", "open")`);

  at("a conversation can be cleared without ending it");
  // `PeerWorkspace.clearText()` has existed in the shared code Windows uses
  // since the text lane shipped, the web renders a Clear button wired to it,
  // and macOS confirms before clearing. Windows offered nothing: the only way
  // to get messages off the screen was to end the link.
  await js(`window.__set("setText", "open", "")`);
  await js(`window.__set("setHistory", ["hello", "hi back"])`);
  equal("the transcript renders", await js(`window.__count('[data-test="history"] li')`), 2);
  equal("clear is offered", await js(`window.__count('[data-test="text-clear"]')`), 1);
  check("it presses", await js(`window.__click('[data-test="text-clear"]')`));
  // Confirmed, not immediate: an unrecoverable wipe beside a Send button is a
  // misclick away.
  equal("and asks first", await js(`window.__count('[data-test="text-clear-confirm"]')`), 1);
  equal("nothing cleared yet", (await js(`window.__linkHarness.calls()`)).clearText, 0);
  const warning = await js(`window.__text('[data-test="text-clear-body"]')`);
  check("saying it is local and cannot be undone", /this pc|cannot be undone/i.test(warning ?? ""), warning);
  check("declining leaves it alone", await js(`window.__click('[data-test="text-clear-cancel"]')`));
  equal("still there", await js(`window.__count('[data-test="history"] li')`), 2);
  equal("and still nothing cleared", (await js(`window.__linkHarness.calls()`)).clearText, 0);
  await js(`window.__click('[data-test="text-clear"]')`);
  check("confirming clears", await js(`window.__click('[data-test="text-clear-confirm"]')`));
  equal("the transcript is empty", await js(`window.__count('[data-test="history"] li')`), 0);
  equal("through the workspace, once", (await js(`window.__linkHarness.calls()`)).clearText, 1);
  // The distinction the feature exists for.
  equal("and the session is NOT ended", (await js(`window.__linkHarness.calls()`)).disconnect, 0);
  equal("the composer is still there", await js(`window.__count('[data-test="message"]')`), 1);
  await shoot(page, "07-en-cleared");

  at("verification gates both directions");
  await js(`window.__set("setVerification", true, "", false)`);
  equal("with no code yet, it waits", await js(`window.__count('[data-test="sas-pending"]')`), 1);
  // The bypass this replaces: an empty SAS used to open the gate.
  equal("and the send controls are NOT reachable", await js(`window.__count('.drop label.button')`), 0);
  await js(`window.__set("setVerification", true, "123456", false)`);
  equal("with a code, it asks", await js(`window.__count('[data-test="sas"]')`), 1);
  equal("still gated", await js(`window.__count('.drop label.button')`), 0);
  check("confirming opens it", await js(`window.__click('[data-test="sas-confirm"]')`));
  check("and the controls arrive", (await js(`window.__count('.drop label.button')`)) >= 1);
  await shoot(page, "04-en-verified");
  await js(`window.__set("setVerification", false, "", true)`);

  at("Chinese");
  await js(`window.__set("setStatus", "idle")`);
  await js(`window.__set("setEndReason", "relayExpired")`);
  await js(`window.__linkHarness.setLang("zh"); window.__tick()`);
  await js(`window.__tick()`);
  const zhEnd = await js(`window.__text('[data-test="link-end-reason"]')`);
  check("the ending renders in Chinese", /中继/.test(zhEnd ?? ""), zhEnd);
  const zhRestart = await js(`window.__text('[data-test="link-restart"]')`);
  check("and so does the way out", (zhRestart ?? "").length > 0 && !/Start again/.test(zhRestart ?? ""), zhRestart);
  await shoot(page, "05-zh-ended");
  await js(`window.__linkHarness.setLang("en"); window.__tick()`);
  await js(`window.__set("setEndReason", "")`);
  await js(`window.__set("setStatus", "open")`);

  at("responsive");
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  check(
    "narrow: nothing overflows horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
  );
  await shoot(page, "06-en-narrow-680");
  window_.setContentSize(1100, 900);
  await js(`window.__tick()`);

  check("the renderer logged no errors", rendererErrors.length === 0, rendererErrors.join(" | "));
}

main()
  .catch((err) => {
    failures.push(`the driver threw during "${step}": ${String(err?.stack ?? err)}`);
    for (const line of rendererErrors) failures.push(`renderer console: ${line}`);
  })
  .finally(() => {
    process.stdout.write(`RELAYIUM_LINK_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
