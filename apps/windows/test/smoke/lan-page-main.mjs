// The same-network page, in a real renderer, driven through the real DOM.
//
// Nothing drove this screen before. The realtime lane pairs by CODE, and the
// bootstrap smoke only asserts `lan-start` is ABSENT when signed out. So every
// state here was compile-checked and never displayed.
//
// What only this can see: that a peer whose hello lacks `link/1` gets a
// SENTENCE rather than a greyed button, that "no devices yet" and "cannot reach
// Relayium" are different screens rather than one, that Connect is not offered
// twice for a peer an intent already blocks, and that the two sentences about
// who else can be at this address actually appear beside the list they
// describe.
//
// The room is a synthetic in-page stand-in: no main process, no socket, no
// rendezvous.

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
    `RELAYIUM_LAN_UI ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();


const PEERS = [
  { id: "peer-aaaa", name: "Kitchen laptop" },
  { id: "peer-bbbb", name: "Old netbook" },
];

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
    window.__set = async (fn, ...args) => { window.__lanHarness[fn](...args); await window.__tick(); };
    window.__texts = (s) => Array.from(document.querySelectorAll(s)).map((e) => e.textContent.replace(/\\s+/g, " ").trim());
    true;
  `);
  check("the harness mounted", await js(`typeof window.__lanHarness === "object"`));

  at("receiving off");
  await js(`window.__set("setReceiving", false)`);
  equal("off offers the way on", await js(`window.__count('[data-test="lan-start"]')`), 1);
  equal("and shows no roster", await js(`window.__count('[data-test="lan-safety"]')`), 0);
  const offBody = await js(`window.__text(".dim")`);
  check("it says what off actually means", /cannot be seen/i.test(offBody ?? ""), offBody);
  await shoot(page, "01-en-off");

  at("joining");
  await js(`window.__set("setReceiving", true)`);
  await js(`window.__set("setConnection", "connecting", false)`);
  await js(`window.__set("setPeers", [])`);
  equal("joining is not an empty roster", await js(`window.__count('[data-test="lan-empty"]')`), 0);
  equal("and not offline either", await js(`window.__count('[data-test="lan-offline"]')`), 0);

  at("offline is its own screen");
  await js(`window.__set("setConnection", "offline")`);
  equal("offline says so", await js(`window.__count('[data-test="lan-offline"]')`), 1);
  equal("and offers a retry", await js(`window.__count('[data-test="lan-retry"]')`), 1);
  // The distinction the page exists to keep: an empty room and a socket that
  // never opened are not the same screen.
  equal("and is NOT the empty roster", await js(`window.__count('[data-test="lan-empty"]')`), 0);
  check("the retry is wired", await js(`window.__click('[data-test="lan-retry"]')`));
  equal("and reaches the room", (await js(`window.__lanHarness.calls()`)).retry, 1);
  await shoot(page, "02-en-offline");

  at("joined but empty");
  await js(`window.__set("setConnection", "joined")`);
  equal("the empty roster says so", await js(`window.__count('[data-test="lan-empty"]')`), 1);
  equal("with no safety line, because there is no list", await js(`window.__count('[data-test="lan-safety"]')`), 0);
  equal("and no names disclaimer either", await js(`window.__count('[data-test="lan-names"]')`), 0);

  at("a roster, and what it says about itself");
  await js(`window.__set("setPeers", ${JSON.stringify(PEERS)})`);
  equal("both peers are listed", await js(`window.__count('[data-test="lan-connect"]')`), 2);
  // The sentences added in 4db88d5e9, which nothing had ever rendered.
  equal("the safety line appears with the list", await js(`window.__count('[data-test="lan-safety"]')`), 1);
  const safety = await js(`window.__text('[data-test="lan-safety"]')`);
  check(
    "and it names the three ways a stranger gets on it",
    ["carrier", "VPN", "gateway"].every((term) => (safety ?? "").includes(term)),
    safety,
  );
  equal("the names disclaimer appears too", await js(`window.__count('[data-test="lan-names"]')`), 1);
  const names = await js(`window.__text('[data-test="lan-names"]')`);
  check("and it names the real setting", (names ?? "").includes("verification code"), names);
  check("with nothing left uninterpolated", !(names ?? "").includes("{setting}"), names);
  // Both belong to the list: above it and below it, not floating on a page
  // with nothing to describe.
  const order = await js(`
    (() => {
      const all = Array.from(document.querySelectorAll('[data-test="lan-safety"], ul.devices, [data-test="lan-names"]'));
      // The tag for the list, not its class: Svelte appends a scoped class and
      // the first version of this check compared against one.
      return all.map((e) => e.getAttribute("data-test") ?? e.tagName.toLowerCase()).join(",");
    })()
  `);
  equal("the safety line is above the list and the disclaimer below it", order, "lan-safety,ul,lan-names");
  await shoot(page, "03-en-roster");

  at("a peer that cannot hold a link");
  await js(`window.__set("setUnsupported", ["peer-bbbb"])`);
  equal("it loses its button", await js(`window.__count('[data-test="lan-connect"]')`), 1);
  const sentences = await js(`window.__texts(".devices li .small")`);
  check(
    "and gains a sentence rather than a greyed control",
    sentences.length === 1 && sentences[0].length > 0,
    JSON.stringify(sentences),
  );
  await js(`window.__set("setUnsupported", [])`);

  at("connect reaches the room, once");
  await js(`window.__set("setBlocked", ["peer-aaaa"])`);
  const first = await js(`window.__click('.devices li:first-child [data-test="lan-connect"]')`);
  // `__click` returns false for a disabled control, which is the point: a
  // helper that reported success here would hide a dead button.
  check("a blocked peer's button does not act", first === false, String(first));
  await js(`window.__set("setBlocked", [])`);
  check("an unblocked one does", await js(`window.__click('.devices li:first-child [data-test="lan-connect"]')`));
  const calls = await js(`window.__lanHarness.calls()`);
  equal("exactly one connect, for the peer that was clicked", JSON.stringify(calls.connectTo), '["peer-aaaa"]');

  at("stopped by the user, with the peer still there");
  await js(`window.__set("setUserStopped", true)`);
  equal("it says disconnected", await js(`window.__count('[data-test="lan-disconnected"]')`), 1);
  equal("and offers reconnect", await js(`window.__count('[data-test="lan-reconnect"]')`), 1);
  // Not "no devices": the peer is right there, and the fence is why nothing is
  // happening.
  equal("and is not the empty roster", await js(`window.__count('[data-test="lan-empty"]')`), 0);
  await js(`window.__set("setUserStopped", false)`);

  at("reconnecting after a successful join");
  await js(`window.__set("setConnection", "reconnecting", true)`);
  equal("says reconnecting", await js(`window.__count('[data-test="lan-reconnecting"]')`), 1);
  // Before the first join it is "joining", not "reconnecting" — a first attempt
  // has nothing to reconnect to.
  await js(`window.__set("setConnection", "reconnecting", false)`);
  equal("but not before the first join", await js(`window.__count('[data-test="lan-reconnecting"]')`), 0);
  await js(`window.__set("setConnection", "joined")`);

  at("Chinese");
  await js(`window.__lanHarness.setLang("zh"); window.__tick()`);
  await js(`window.__tick()`);
  const zhSafety = await js(`window.__text('[data-test="lan-safety"]')`);
  check(
    "the safety line renders in Chinese",
    ["运营商", "VPN", "网关"].every((term) => (zhSafety ?? "").includes(term)),
    zhSafety,
  );
  const zhNames = await js(`window.__text('[data-test="lan-names"]')`);
  check("and so does the disclaimer, interpolated", !(zhNames ?? "").includes("{setting}") && (zhNames ?? "").length > 0, zhNames);
  await shoot(page, "04-zh-roster");
  await js(`window.__lanHarness.setLang("en"); window.__tick()`);

  at("responsive");
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  check(
    "narrow: nothing overflows horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
  );
  equal("narrow: both peers still listed", await js(`window.__count('.devices li')`), 2);
  await shoot(page, "05-en-narrow-680");
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
    process.stdout.write(`RELAYIUM_LAN_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
