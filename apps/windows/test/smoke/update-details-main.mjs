// The update pane, in a real renderer, driven through the real DOM.
//
// Drives all EIGHTEEN states plus both reason pairs, in English and Simplified
// Chinese, at 1100 and 680 width. The unit cases prove the mapping and the
// catalogue; only this can see that a state renders, that a gate actually
// disables a button, and that the progress bar is drawn from pushed bytes.
//
// The bridge behind the controller is synthetic and in-page: no main process, no
// feed, no disk. This process deletes nothing — the wrapper owns both temporary
// directories.

import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const failures = [];
let checks = 0;
/**
 * Where the driver is.
 *
 * Carried into the thrown report: "Script failed to execute" with no step and
 * no renderer console is a failure nobody can act on.
 */
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
    `RELAYIUM_UPDATE_UI ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

const CANDIDATE = {
  version: "1.4.0",
  build: 1400,
  sizeBytes: 8 * 1024 * 1024,
  hasNotes: true,
  sha256: "a".repeat(64),
};

const gates = (over = {}) => ({
  canCheck: true,
  canDownload: false,
  canInstall: false,
  canReveal: false,
  canOpenNotes: false,
  busy: false,
  ...over,
});

const view = (state, over = {}) => ({
  state,
  actions: gates(over.actions),
  residue: over.residue ?? { kind: "unread" },
  currentVersion: "1.3.9",
});

/** The eighteen kinds, plus both reason pairs. The acceptance set. */
const STATES = [
  ["disabled-engineering", view({ kind: "disabled", reason: "engineering-build" }, { actions: { canCheck: false } })],
  ["disabled-no-pin", view({ kind: "disabled", reason: "no-pin" }, { actions: { canCheck: false } })],
  ["idle", view({ kind: "idle", lastCheckedAt: 1_789_000_000 })],
  ["idle-never", view({ kind: "idle", lastCheckedAt: null })],
  ["checking", view({ kind: "checking" }, { actions: { busy: true, canCheck: false } })],
  ["up-to-date", view({ kind: "up-to-date", checkedAt: 1_789_000_000 })],
  ["check-failed-retryable", view({ kind: "check-failed", reason: "network", retryable: true })],
  ["check-failed-terminal", view({ kind: "check-failed", reason: "malformed", retryable: false }, { actions: { canCheck: false } })],
  ["feed-untrusted", view({ kind: "feed-untrusted" }, { actions: { canCheck: false } })],
  ["update-available", view({ kind: "update-available", candidate: CANDIDATE }, { actions: { canDownload: true, canOpenNotes: true } })],
  ["downloading", view({ kind: "downloading", candidate: CANDIDATE, receivedBytes: 2 * 1024 * 1024 }, { actions: { busy: true, canCheck: false } })],
  ["verify-failed", view({ kind: "verify-failed", candidate: CANDIDATE, reason: "integrity" })],
  ["ready", view({ kind: "ready", candidate: CANDIDATE }, { actions: { canInstall: true } })],
  ["ready-unsigned", view({ kind: "ready-unsigned", candidate: CANDIDATE }, { actions: { canReveal: true } })],
  ["publisher-mismatch", view({ kind: "publisher-mismatch", candidate: CANDIDATE }, { actions: { canCheck: false } })],
  ["verifier-unavailable", view({ kind: "verifier-unavailable", candidate: CANDIDATE }, { actions: { canCheck: false } })],
  ["installing", view({ kind: "installing", candidate: CANDIDATE }, { actions: { busy: true, canCheck: false } })],
  ["install-deferred", view({ kind: "install-deferred", candidate: CANDIDATE, reason: "no-consent-adapter" })],
  ["revealed", view({ kind: "revealed", candidate: CANDIDATE })],
  ["journal-unavailable", view({ kind: "journal-unavailable", reason: "corrupt" })],
  ["blocked-residue", view({ kind: "blocked", reason: "unresolved-residue", count: 4 }, { actions: { canCheck: false } })],
  ["blocked-staging", view({ kind: "blocked", reason: "staging-unowned", count: 0 }, { actions: { canCheck: false } })],
];

async function shoot(page, name) {
  if (!shotDir) return;
  const image = await page.capturePage();
  const bitmap = image.toBitmap();
  if (bitmap.length === 0) {
    failures.push(`screenshot ${name}: empty capture`);
    return;
  }
  let distinct = false;
  for (let i = 4; i < bitmap.length; i += 4) {
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

/** Collected outside `main` so the catch above can still read them. */
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
  const errors = rendererErrors;
  page.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  page.on("render-process-gone", (_e, details) => {
    failures.push(`the renderer died: ${JSON.stringify(details)}`);
  });

  if (shotDir) mkdirSync(shotDir, { recursive: true });
  await window_.loadURL(pathToFileURL(path.join(bundleDir, "index.html")).toString());
  const js = (code) => page.executeJavaScript(code, true);

  await js(`
    window.__tick = () => new Promise((r) => setTimeout(r, 25));
    window.__text = (sel) => { const el = document.querySelector(sel); return el === null ? null : el.textContent.replace(/\\s+/g, " ").trim(); };
    window.__count = (sel) => document.querySelectorAll(sel).length;
    window.__attr = (sel, n) => { const el = document.querySelector(sel); return el === null ? null : el.getAttribute(n); };
    window.__disabled = (sel) => { const el = document.querySelector(sel); return el === null ? null : el.disabled === true; };
    window.__click = async (sel) => { const el = document.querySelector(sel); if (el === null) return false; el.click(); await window.__tick(); return true; };
    window.__push = async (v) => { window.__updateHarness.push(v); await window.__tick(); };
    // Helpers rather than inline statements: \`executeJavaScript\` evaluates a
    // CLASSIC script, where a top-level \`await\` is a SyntaxError — which
    // surfaces only as "Script failed to execute".
    window.__loadNow = async () => { await window.__updateHarness.load(); await window.__tick(); };
    window.__remountNow = async () => { await window.__updateHarness.remount(); await window.__tick(); };
    true;
  `);
  check("the harness mounted", await js(`typeof window.__updateHarness === "object"`));

  // --- every state renders, in both languages ------------------------------
  at("all states EN/zh");
  for (const lang of ["en", "zh"]) {
    await js(`window.__updateHarness.setLang(${JSON.stringify(lang)})`);
    const seen = new Map();
    for (const [label, snapshot] of STATES) {
      await js(`window.__push(${JSON.stringify(snapshot)})`);
      const title = await js(`window.__text('[data-test="update-title"]')`);
      const body = await js(`window.__text('[data-test="update-body"]')`);
      check(`${lang}/${label}: renders a title`, typeof title === "string" && title.length > 0, title);
      equal(`${lang}/${label}: the pane names the state`, await js(`window.__attr('[data-test="update-details"]', "data-state")`), snapshot.state.kind);
      // Distinct where a person must be able to tell two states apart. Recorded
      // per language so a missing translation cannot pass by matching English.
      const key = `${title} ${body ?? ""}`;
      if (seen.has(key)) {
        failures.push(`${lang}: ${label} is word-for-word identical to ${seen.get(key)}`);
      }
      checks += 1;
      seen.set(key, label);
    }
  }

  // --- the claims that must never appear -----------------------------------
  await js(`window.__updateHarness.setLang("en")`);
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "revealed")[1])})`);
  const revealedEn = await js(`window.__text('[data-test="update-details"]')`);
  check("revealed never claims an update happened (en)", !/has been updated|is up to date/i.test(revealedEn ?? ""), revealedEn);
  await shoot(page, "01-en-revealed");
  await js(`window.__updateHarness.setLang("zh")`);
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "revealed")[1])})`);
  const revealedZh = await js(`window.__text('[data-test="update-details"]')`);
  check("revealed never claims an update happened (zh)", /尚未更新/.test(revealedZh ?? "") && !/已成功更新/.test(revealedZh ?? ""), revealedZh);
  check("the zh pane is actually translated", /[一-鿿]/.test(revealedZh ?? ""));

  // --- action gates are obeyed ---------------------------------------------
  await js(`window.__updateHarness.setLang("en")`);
  await js(`window.__updateHarness.resetCalls()`);

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "feed-untrusted")[1])})`);
  equal("feed-untrusted offers no check", await js(`window.__disabled('[data-test="update-check"]')`), true);
  equal("feed-untrusted offers no retry at all", await js(`window.__count('[data-test="update-retry"]')`), 0);
  await js(`window.__click('[data-test="update-check"]')`);

  // Both trust outcomes are terminal: no check, no retry, no install, no reveal.
  // A client that re-offered one here would be relaxing a trust decision to
  // avoid a dead-looking screen.
  at("terminal affordances");
  for (const label of ["publisher-mismatch", "verifier-unavailable"]) {
    await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === label)[1])})`);
    equal(`${label}: the check button is disabled`, await js(`window.__disabled('[data-test="update-check"]')`), true);
    equal(`${label}: offers no retry`, await js(`window.__count('[data-test="update-retry"]')`), 0);
    equal(`${label}: offers no install`, await js(`window.__count('[data-test="update-install"]')`), 0);
    equal(`${label}: offers no reveal`, await js(`window.__count('[data-test="update-reveal"]')`), 0);
    equal(`${label}: offers no download`, await js(`window.__count('[data-test="update-download"]')`), 0);
    await js(`window.__click('[data-test="update-check"]')`);
  }
  equal(
    "no terminal state sent an action",
    JSON.stringify((await js(`window.__updateHarness.calls()`)).act),
    JSON.stringify([]),
  );
  await shoot(page, "08-en-publisher-mismatch");

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "check-failed-terminal")[1])})`);
  equal("a non-retryable failure offers no retry", await js(`window.__count('[data-test="update-retry"]')`), 0);

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "check-failed-retryable")[1])})`);
  equal("a retryable failure offers one", await js(`window.__count('[data-test="update-retry"]')`), 1);

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "ready-unsigned")[1])})`);
  equal("ready-unsigned offers no install", await js(`window.__count('[data-test="update-install"]')`), 0);
  equal("ready-unsigned offers a reveal", await js(`window.__disabled('[data-test="update-reveal"]')`), false);

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "ready")[1])})`);
  equal("ready offers no reveal", await js(`window.__count('[data-test="update-reveal"]')`), 0);
  check("ready installs", await js(`window.__click('[data-test="update-install"]')`));
  await shoot(page, "02-en-ready");

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "disabled-no-pin")[1])})`);
  equal("disabled offers no check button at all", await js(`window.__count('[data-test="update-check"]')`), 0);
  equal("disabled draws no spinner", await js(`window.__count('[data-test="update-indeterminate"]')`), 0);
  await shoot(page, "03-en-disabled-no-pin");

  const acted = await js(`window.__updateHarness.calls()`);
  equal("only the enabled action was sent", JSON.stringify(acted.act), JSON.stringify(["install"]));

  // --- progress is pushed, never interpolated ------------------------------
  at("progress");
  const downloading = STATES.find((s) => s[0] === "downloading")[1];
  await js(`window.__push(${JSON.stringify(downloading)})`);
  equal("the bar is drawn against the signed length", await js(`window.__attr('[data-test="update-progress"]', "aria-valuenow")`), "25");
  await shoot(page, "04-en-downloading");
  const before = await js(`window.__attr('[data-test="update-progress"]', "aria-valuenow")`);
  await js(`new Promise((r) => setTimeout(r, 300))`);
  equal("no timer advances it", await js(`window.__attr('[data-test="update-progress"]', "aria-valuenow")`), before);

  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "checking")[1])})`);
  equal("checking draws an indeterminate bar, not a determinate one", await js(`window.__count('[data-test="update-progress"]')`), 0);
  equal("and it is marked as such", await js(`window.__count('[data-test="update-indeterminate"]')`), 1);

  // --- residue never claims clean when it was not read ---------------------
  at("residue truth");
  for (const [label, residue, forbidden] of [
    ["unread", { kind: "unread" }, /No leftover/i],
    ["failed", { kind: "failed" }, /No leftover/i],
  ]) {
    await js(`window.__push(${JSON.stringify(view({ kind: "idle", lastCheckedAt: null }, { residue }))})`);
    const text = await js(`window.__text('[data-test="update-residue"]')`);
    equal(`residue/${label} is labelled`, await js(`window.__attr('[data-test="update-residue"]', "data-residue")`), residue.kind);
    check(`residue/${label} never reads as clean`, !forbidden.test(text ?? ""), text);
  }
  await js(`window.__push(${JSON.stringify(view({ kind: "idle", lastCheckedAt: null }, { residue: { kind: "read", total: 0, ambiguous: 0 } }))})`);
  check("a successful empty read may say clean", /No leftover/i.test((await js(`window.__text('[data-test="update-residue"]')`)) ?? ""));

  // --- a failed request is rendered, in both languages ---------------------
  //
  // The controller used to swallow every rejection, so a broken channel looked
  // exactly like a quiet app. These drive the real notice.
  at("failure notice EN/zh");
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "blocked-staging")[1])})`);
  for (const lang of ["en", "zh"]) {
    await js(`window.__updateHarness.setLang(${JSON.stringify(lang)})`);
    await js(`window.__updateHarness.setRejects({ state: true })`);
    await js(`window.__loadNow()`);
    equal(`${lang}: a failed read is shown`, await js(`window.__count('[data-test="update-request-failed"]')`), 1);
    equal(`${lang}: it is labelled a read failure`, await js(`window.__attr('[data-test="update-request-failed"]', "data-failure")`), "read");
    const notice = await js(`window.__text('[data-test="update-request-failed"]')`);
    check(`${lang}: the notice says something`, (notice ?? "").length > 0, notice);
    if (lang === "zh") check("the failure notice is translated", /[一-鿿]/.test(notice ?? ""), notice);
    equal(`${lang}: it offers a retry`, await js(`window.__count('[data-test="update-request-retry"]')`), 1);
  }

  // On a pane that has ALREADY seen a view, a later failure preserves what main
  // last said — `confirmed` is latched, and correctly so.
  at("known view preserved across a later failure");
  equal(
    "a confirmed pane keeps its state across a failed read",
    await js(`window.__attr('[data-test="update-details"]', "data-state")`),
    "blocked",
  );

  // The FIRST-read case needs a genuinely fresh controller and mount: staging it
  // on a pane that has accepted pushes would assert against a pane that
  // legitimately knows its state.
  at("fresh mount, first read fails");
  await js(`window.__updateHarness.setRejects({ state: true })`);
  await js(`window.__remountNow()`);
  await js(`window.__loadNow()`);
  equal(
    "a fresh pane whose first read failed is not confirmed",
    await js(`window.__count('[data-test="update-check"]')`),
    0,
  );
  const unconfirmed = await js(`window.__text('[data-test="update-title"]')`);
  check("it says the status is not known", /尚未获知/.test(unconfirmed ?? ""), unconfirmed);
  equal(
    "and it does not claim the build is disabled",
    await js(`window.__attr('[data-test="update-details"]', "data-state")`),
    "disabled",
  );
  check(
    "the disabled sentence is NOT what it renders",
    !/无法使用更新|没有更新签名密钥/.test((await js(`window.__text('[data-test="update-body"]')`)) ?? ""),
    await js(`window.__text('[data-test="update-body"]')`),
  );
  equal("the failure notice is shown on the fresh pane", await js(`window.__count('[data-test="update-request-failed"]')`), 1);
  await shoot(page, "09-zh-unconfirmed-read-failed");

  // A fresh mount whose first read SUCCEEDS is confirmed and renders the state.
  at("fresh mount, first read succeeds");
  await js(`window.__updateHarness.setRejects({ state: false })`);
  await js(`window.__updateHarness.push(${JSON.stringify(STATES.find((s) => s[0] === "idle")[1])})`);
  await js(`window.__remountNow()`);
  await js(`window.__loadNow()`);
  equal("a confirmed fresh pane offers its check", await js(`window.__count('[data-test="update-check"]')`), 1);
  equal("and no failure notice", await js(`window.__count('[data-test="update-request-failed"]')`), 0);

  await js(`window.__updateHarness.setLang("en")`);
  await js(`window.__loadNow()`);
  await shoot(page, "10-en-request-failed");

  // A push clears a stale notice: main is speaking again.
  await js(`window.__updateHarness.setRejects({ state: false })`);
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "idle")[1])})`);
  equal("a push clears the notice", await js(`window.__count('[data-test="update-request-failed"]')`), 0);
  equal("and the pane is confirmed again", await js(`window.__count('[data-test="update-check"]')`), 1);

  // Dismiss removes it without retrying.
  await js(`window.__updateHarness.setRejects({ state: true })`);
  await js(`window.__loadNow()`);
  await js(`window.__updateHarness.resetCalls()`);
  check("dismiss works", await js(`window.__click('[data-test="update-request-dismiss"]')`));
  equal("the notice is gone", await js(`window.__count('[data-test="update-request-failed"]')`), 0);
  equal("dismiss did not re-issue anything", (await js(`window.__updateHarness.calls()`)).state, 0);
  await js(`window.__updateHarness.setRejects({ state: false })`);
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "idle")[1])})`);

  // --- responsive ----------------------------------------------------------
  await js(`window.__push(${JSON.stringify(STATES.find((s) => s[0] === "update-available")[1])})`);
  at("responsive");
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  check(
    "narrow: nothing overflows horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
  );
  await shoot(page, "05-en-narrow-680");
  await js(`window.__updateHarness.setLang("zh")`);
  await js(`window.__tick()`);
  await shoot(page, "06-zh-narrow-680");
  window_.setContentSize(1100, 900);
  await js(`window.__tick()`);
  await shoot(page, "07-zh-update-available");

  check("the renderer logged no errors", errors.length === 0, errors.join(" | "));
}

main()
  .catch((err) => {
    failures.push(`the driver threw during "${step}": ${String(err?.stack ?? err)}`);
    // The renderer's own console is the other half of the diagnosis.
    for (const line of rendererErrors) failures.push(`renderer console: ${line}`);
  })
  .finally(() => {
    process.stdout.write(`RELAYIUM_UPDATE_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
