// The pending-selection pane, in a real renderer, driven through the real DOM.
//
// The unit cases prove the staging rules. Only this can see that the pane says
// nothing has been sent, that a refused burst is visible, that no absolute path
// reaches the screen, and that the layout survives 680.
//
// The bridge is synthetic and in-page: no main process and no filesystem.

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
    `RELAYIUM_OS_ENTRY ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();


const entry = (relativePath, size, token) => ({ token, name: relativePath.split("/").pop(), relativePath, size });
const stagedView = (over = {}) => ({
  kind: "staged",
  selectionId: "sel-1",
  entries: [entry("box/a.txt", 4096, "t1"), entry("box/deep/b.txt", 0, "t2")],
  rootNames: ["box"],
  totalBytes: 4096,
  stagedAt: 1,
  refusedSince: 0,
  ...over,
});
const emptyView = (refusal = null) => ({ kind: "empty", selectionId: "sel-0", refusal });

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
    window.__click = async (s) => { const e = document.querySelector(s); if (e === null) return false; e.click(); await window.__tick(); return true; };
    window.__push = async (v) => { window.__osEntryHarness.push(v); await window.__tick(); };
    true;
  `);
  check("the harness mounted", await js(`typeof window.__osEntryHarness === "object"`));

  at("empty renders nothing");
  await js(`window.__push(${JSON.stringify(emptyView())})`);
  equal("no pane without a selection", await js(`window.__count('[data-test="pending-selection"]')`), 0);
  equal("and no refusal either", await js(`window.__count('[data-test="pending-refused"]')`), 0);

  at("staged");
  await js(`window.__push(${JSON.stringify(stagedView())})`);
  equal("the pane renders", await js(`window.__count('[data-test="pending-selection"]')`), 1);
  const count = await js(`window.__text('[data-test="pending-count"]')`);
  check("it names the count and the root", (count ?? "").includes("2") && (count ?? "").includes("box"), count);
  // The whole point: nothing has been sent.
  const note = await js(`window.__text('[data-test="pending-note"]')`);
  check("it says nothing has been sent", /nothing has been sent/i.test(note ?? ""), note);
  equal("both entries are listed", await js(`window.__count('[data-test="pending-entry"]')`), 2);
  const paths = await js(`Array.from(document.querySelectorAll('[data-test="pending-entry"]')).map((e) => e.textContent)`);
  check("relative paths only", paths.every((p) => !/^[A-Za-z]:|^\//.test(p)), JSON.stringify(paths));
  check("an empty file is still shown", paths.some((p) => p.includes("deep/b.txt")), JSON.stringify(paths));
  await shoot(page, "01-en-staged");

  at("refused burst is visible");
  await js(`window.__push(${JSON.stringify(stagedView({ refusedSince: 2 }))})`);
  equal("the refusal is shown", await js(`window.__count('[data-test="pending-refused-held"]')`), 1);
  equal("with its count", await js(`window.__attr('[data-test="pending-refused-held"]', "data-count")`), "2");
  const held = await js(`window.__text('[data-test="pending-refused-held"]')`);
  check("it says the held ones are still waiting", /still waiting/i.test(held ?? ""), held);
  // And the selection it collided with is still on screen.
  equal("the held selection survives", await js(`window.__count('[data-test="pending-entry"]')`), 2);
  await shoot(page, "02-en-refused-burst");

  at("clear");
  await js(`window.__osEntryHarness.resetCalls()`);
  await js(`window.__osEntryHarness.setClear(${JSON.stringify(emptyView())})`);
  check("clear is offered", await js(`window.__click('[data-test="pending-clear"]')`));
  equal("and it asked main", (await js(`window.__osEntryHarness.calls()`)).clear, 1);
  equal("no read was ever demanded by the pane", (await js(`window.__osEntryHarness.calls()`)).reads.length, 0);

  at("refusals");
  for (const [refusal, probe] of [
    ["too-many", /more than/i],
    ["escapes-root", /shortcut or link/i],
    ["collision", /same name/i],
    ["unsupported-kind", /not an ordinary file/i],
  ]) {
    await js(`window.__push(${JSON.stringify(emptyView("PLACEHOLDER"))})`.replace("PLACEHOLDER", refusal));
    equal(`${refusal}: shown`, await js(`window.__attr('[data-test="pending-refused"]', "data-refusal")`), refusal);
    const text = await js(`window.__text('[data-test="pending-refusal"]')`);
    check(`${refusal}: says why`, probe.test(text ?? ""), text);
    // Total, never partial.
    const nothing = await js(`window.__text('[data-test="pending-nothing"]')`);
    check(`${refusal}: says nothing was staged`, /nothing was staged/i.test(nothing ?? ""), nothing);
  }
  await shoot(page, "03-en-refused");

  at("zh");
  await js(`window.__osEntryHarness.setLang("zh")`);
  await js(`window.__push(${JSON.stringify(stagedView({ refusedSince: 1 }))})`);
  const zhNote = await js(`window.__text('[data-test="pending-note"]')`);
  check("the pane is translated", /[\u4e00-\u9fff]/.test(zhNote ?? ""), zhNote);
  check("and says nothing has been sent, in Chinese", (zhNote ?? "").includes("还没有发送"), zhNote);
  const zhHeld = await js(`window.__text('[data-test="pending-refused-held"]')`);
  check("the refusal is translated", /[\u4e00-\u9fff]/.test(zhHeld ?? ""), zhHeld);
  await shoot(page, "04-zh-staged");

  at("responsive");
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  check(
    "narrow: nothing overflows horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
  );
  equal("narrow: entries still listed", await js(`window.__count('[data-test="pending-entry"]')`), 2);
  await shoot(page, "05-zh-narrow-680");
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
    process.stdout.write(`RELAYIUM_OS_ENTRY ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
