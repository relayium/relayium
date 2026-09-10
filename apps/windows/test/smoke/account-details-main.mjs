// The account screen, in a real renderer, driven through the real DOM.
//
// This is not a mock of the component. It loads the bundle the wrapper compiled
// from `src/renderer/pages/AccountDetails.svelte` and
// `src/renderer/account/account-controller.svelte.ts` with the ordinary Svelte
// CLIENT build, and then clicks the actual buttons: Rename, Cancel, Save, Sign
// out, the confirmation's two answers, the retry on a failed card.
//
// ## What only this can catch
//
// The unit cases prove the controller's guards and the formatter's arithmetic.
// They cannot see:
//
//   * a meter drawn for a quota that has no limit — the "100% full" failure;
//   * a Cancel wired to the same handler as Save;
//   * a confirmation whose self-revoke branch never renders its warning;
//   * a failed usage card that also blanks the profile beside it;
//   * a Chinese UI that is quietly English because a catalogue key is missing;
//   * a layout that stops reflowing at a narrow window.
//
// Each of those is a passing unit board and a broken screen.
//
// ## What it touches
//
// Nothing belonging to the person running it. The page is a task-owned bundle in
// a temporary directory, the Electron profile is a task-owned temporary
// directory, the window is never shown, and the bridge behind the controller is
// a SYNTHETIC in-page object that reaches no network, no main process and no
// account. This process deletes nothing: the wrapper owns both directories and
// removes them once these Chromium handles are certainly closed.

import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const failures = [];
let checks = 0;
const check = (name, ok, detail) => {
  checks += 1;
  if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`);
};
const equal = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const [bundleDir, userDataDir, shotDir] = process.argv.slice(2);
if (!bundleDir || !userDataDir) {
  process.stdout.write(
    `RELAYIUM_ACCOUNT_UI ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

// ---------------------------------------------------------------------------
// Fixtures. Plain contract shapes; nothing here is read from a server.
// ---------------------------------------------------------------------------

const GIB = 1024 ** 3;

const PROFILE = {
  email: "someone@relayium.test",
  displayName: "Someone",
  emailVerified: true,
  hasPassword: true,
  linkedMethods: ["password", "google"],
  planId: "pro",
  subscriptionStatus: "active",
  subscriptionEnd: 1_800_000_000,
  hasBilling: true,
  billingCycle: "monthly",
  scheduledPlanId: "",
  scheduledCycle: "",
  entitlementProvider: "stripe",
  appleRenewal: { available: false },
};

const PLAN = {
  id: "pro",
  name: "Pro",
  // 0 is UNLIMITED. The screen must say so and must not draw a meter.
  storageBytes: 0,
  trafficBytes: 8 * GIB,
  retentionSecs: 7 * 86_400,
  isTop: false,
  subscriptionStatus: "active",
  subscriptionEnd: 1_800_000_000,
  billingCycle: "monthly",
  scheduledPlanId: "",
  scheduledPlanName: "",
  scheduledCycle: "",
  entitlementProvider: "stripe",
  appleRenewal: { available: false },
};

const USAGE = {
  period: "202609",
  resetsAt: 1_790_000_000,
  // The EFFECTIVE cap, deliberately different from the plan's nominal 8 GB:
  // the meter must be drawn against this one.
  traffic: { used: 2 * GIB, cap: 4 * GIB },
  storage: { used: 3 * GIB, cap: 0 },
  plan: PLAN,
};

const DEVICES = [
  {
    id: "dev-aaaa1111",
    name: "Office PC",
    kind: "windows",
    createdAt: 1_700_000_000,
    lastSeenAt: 1_780_000_000,
    current: true,
    enrolled: true,
  },
  {
    id: "dev-bbbb2222",
    name: "Laptop",
    kind: "windows",
    createdAt: 1_710_000_000,
    lastSeenAt: 1_781_000_000,
    current: false,
    enrolled: false,
  },
];

const READY = {
  epoch: 1,
  signedIn: true,
  profile: { kind: "ready", value: PROFILE },
  usage: { kind: "ready", value: USAGE },
  devices: { kind: "ready", value: DEVICES },
};

const LOADING = {
  epoch: 1,
  signedIn: false,
  profile: { kind: "loading" },
  usage: { kind: "loading" },
  devices: { kind: "loading" },
};

const signedOut = (epoch) => ({
  epoch,
  signedIn: false,
  profile: { kind: "failed", failure: { kind: "signed-out" } },
  usage: { kind: "failed", failure: { kind: "signed-out" } },
  devices: { kind: "failed", failure: { kind: "signed-out" } },
});

/** Profile and devices fine; usage refused. The partial-failure case. */
const USAGE_FAILED = {
  ...READY,
  usage: { kind: "failed", failure: { kind: "refused", status: 500 } },
};

/** Both quotas unlimited — the case that must never render a percentage. */
const ALL_UNLIMITED = {
  ...READY,
  usage: {
    kind: "ready",
    value: { ...USAGE, traffic: { used: 5 * GIB, cap: 0 }, storage: { used: 3 * GIB, cap: 0 } },
  },
};

const ROW_A = '[data-test="device-row"][data-device="dev-aaaa1111"]';
const ROW_B = '[data-test="device-row"][data-device="dev-bbbb2222"]';

/**
 * Capture what the screen actually looks like, and refuse to claim a capture
 * that is blank.
 *
 * A hidden window can return a uniform image on some platforms, and a run that
 * wrote 400KB of one colour and called it a screenshot would be worse than one
 * that took none — it would look like evidence. So every capture is checked for
 * more than one distinct pixel before it is counted.
 */
async function shoot(page, name) {
  if (!shotDir) return;
  const image = await page.capturePage();
  const bitmap = image.toBitmap();
  if (bitmap.length === 0) {
    failures.push(`screenshot ${name}: the capture was empty`);
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
    failures.push(`screenshot ${name}: the capture was a single flat colour, so it shows nothing`);
    return;
  }
  writeFileSync(path.join(shotDir, `${name}.png`), image.toPNG());
  checks += 1;
}

async function main() {
  // Electron refuses to build a window before this resolves, and the refusal is
  // a throw rather than a wait.
  await app.whenReady();
  const window_ = new BrowserWindow({
    show: false,
    width: 1100,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const page = window_.webContents;
  const errors = [];
  page.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  page.on("render-process-gone", (_e, details) => {
    failures.push(`the renderer died: ${JSON.stringify(details)}`);
  });

  if (shotDir) mkdirSync(shotDir, { recursive: true });
  await window_.loadURL(pathToFileURL(path.join(bundleDir, "index.html")).toString());

  const js = (code) => page.executeJavaScript(code, true);

  // A tiny query surface, injected once. Everything below reads the DOM through
  // it — never the controller — because a field that is right while the screen
  // is wrong is the failure these cases exist to catch.
  await js(`
    window.__tick = () => new Promise((r) => setTimeout(r, 25));
    window.__text = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : el.textContent.replace(/\\s+/g, " ").trim();
    };
    window.__count = (sel) => document.querySelectorAll(sel).length;
    window.__click = async (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      el.click();
      await window.__tick();
      return true;
    };
    window.__type = async (sel, value) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await window.__tick();
      return true;
    };
    window.__key = async (sel, key) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await window.__tick();
      return true;
    };
    window.__push = async (view) => { window.__accountHarness.push(view); await window.__tick(); };
    window.__attr = (sel, name) => {
      const el = document.querySelector(sel);
      return el === null ? null : el.getAttribute(name);
    };
    window.__disabled = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : el.disabled === true;
    };
    window.__tracks = (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return 0;
      return getComputedStyle(el).gridTemplateColumns.trim().split(/\\s+/).length;
    };
    true;
  `);

  check("the harness mounted", await js(`typeof window.__accountHarness === "object"`));

  // --- Signed out renders nothing -----------------------------------------
  await js(`window.__push(${JSON.stringify(signedOut(1))})`);
  equal(
    "signed out renders no details at all",
    await js(`window.__count('[data-test="account-details"]')`),
    0,
  );

  // --- Loading is 'reading', never an empty account ------------------------
  await js(`window.__push(${JSON.stringify({ ...LOADING, epoch: 2 })})`);
  equal("loading is rendered as reading", await js(`window.__count('[data-test="account-loading"]')`), 1);
  equal("loading renders no device list", await js(`window.__count('[data-test="device-list"]')`), 0);

  // --- A complete account, in English --------------------------------------
  await js(`window.__accountHarness.setLang("en"); window.__push(${JSON.stringify({ ...READY, epoch: 3 })})`);

  equal("the profile name renders", await js(`window.__text('[data-test="profile-name"]')`), "Someone");
  check(
    "the email renders with its verification state",
    (await js(`window.__text('[data-test="profile-email"]')`))?.includes("someone@relayium.test"),
  );
  // Exact, not `includes`: the server already puts "password" in this list, so
  // a client that adds it again renders "Password · password".
  equal(
    "the sign-in methods render exactly once each",
    await js(`window.__text('[data-test="profile-methods"]')`),
    "Password · Google",
  );

  equal("the plan name renders", await js(`window.__text('[data-test="plan-name"]')`), "Pro");
  // The provider's wire token, in words. "active" on screen is the token, not a
  // sentence, and in a Chinese UI it is a bare English word.
  equal(
    "the subscription status renders as a label, not as a wire token",
    await js(`window.__text('[data-test="subscription-status"]')`),
    "Active",
  );
  equal(
    "a device kind renders in the platform's own casing",
    await js(`window.__text('${ROW_A} [data-test="device-kind"]')`),
    "Windows",
  );
  // 0 is unlimited, and the word is what appears — never "0 B".
  equal(
    "an unlimited plan ceiling says unlimited",
    await js(`window.__text('[data-test="plan-storage"]')`),
    "Unlimited",
  );
  equal(
    "the plan's NOMINAL traffic is stated as the plan's",
    await js(`window.__text('[data-test="plan-traffic"]')`),
    "8.0 GB",
  );
  equal("retention renders in days", await js(`window.__text('[data-test="plan-retention"]')`), "7 days");

  // --- The meter is drawn against the EFFECTIVE cap ------------------------
  equal(
    "the traffic meter exists",
    await js(`window.__count('[data-test="usage-traffic"] [role="progressbar"]')`),
    1,
  );
  equal(
    "the meter is drawn against the effective cap, not the plan's nominal one",
    await js(`window.__attr('[data-test="usage-traffic"] [role="progressbar"]', "aria-valuenow")`),
    "50",
  );
  check(
    "the meter states the two byte figures it is drawn from",
    (await js(`window.__attr('[data-test="usage-traffic"] [role="progressbar"]', "aria-valuetext")`))?.includes(
      "4.0 GB",
    ),
  );

  // --- A cap of 0 draws NO meter and no percentage -------------------------
  equal(
    "an unlimited quota draws no meter",
    await js(`window.__count('[data-test="usage-storage"] [role="progressbar"]')`),
    0,
  );
  check(
    "an unlimited quota says it has no limit",
    (await js(`window.__text('[data-test="usage-storage"]')`))?.includes("no limit"),
  );

  await js(`window.__push(${JSON.stringify({ ...ALL_UNLIMITED, epoch: 4 })})`);
  equal(
    "an entirely unlimited account draws no meter anywhere",
    await js(`window.__count('[data-test="account-details"] [role="progressbar"]')`),
    0,
  );
  check(
    "an entirely unlimited account never shows a percentage",
    !(await js(`window.__text('[data-test="account-details"]')`))?.includes("%"),
    "a percentage was rendered for a quota with no denominator",
  );

  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 5 })})`);
  await shoot(page, "01-en-complete-account");

  // --- Devices --------------------------------------------------------------
  equal("both devices render", await js(`window.__count('[data-test="device-row"]')`), 2);
  equal(
    "exactly one row is marked as this PC",
    await js(`window.__count('[data-test="device-current"]')`),
    1,
  );
  equal(
    "the current mark is on the current row",
    await js(`window.__count('${ROW_A} [data-test="device-current"]')`),
    1,
  );
  equal(
    "an enrolled device says so, and one that is not does not",
    await js(
      `window.__count('${ROW_A} [data-test="device-enrolled"]') * 10 + window.__count('${ROW_B} [data-test="device-enrolled"]')`,
    ),
    10,
  );
  equal(
    "the id suffix disambiguates same-named machines",
    await js(`window.__text('${ROW_B} [data-test="device-suffix"]')`),
    "#2222",
  );

  // --- Rename: cancel does not send ----------------------------------------
  await js(`window.__accountHarness.resetCalls()`);
  check("the rename button opens the editor", await js(`window.__click('${ROW_B} [data-test="device-rename"]')`));
  await shoot(page, "02-en-rename-editor");
  equal("the editor is open on that row", await js(`window.__count('${ROW_B} [data-test="rename-prompt"]')`), 1);
  equal(
    "the editor is seeded with the row's current name",
    await js(`document.querySelector('${ROW_B} [data-test="rename-input"]').value`),
    "Laptop",
  );
  check("cancel closes the editor", await js(`window.__click('${ROW_B} [data-test="rename-cancel"]')`));
  equal("the editor is gone", await js(`window.__count('[data-test="rename-prompt"]')`), 0);
  equal(
    "cancelling sent nothing",
    (await js(`window.__accountHarness.calls()`)).rename.length,
    0,
  );

  // --- Rename: Escape also cancels -----------------------------------------
  await js(`window.__click('${ROW_B} [data-test="device-rename"]')`);
  await js(`window.__key('${ROW_B} [data-test="rename-input"]', "Escape")`);
  equal("Escape closes the editor", await js(`window.__count('[data-test="rename-prompt"]')`), 0);
  equal("Escape sent nothing", (await js(`window.__accountHarness.calls()`)).rename.length, 0);

  // --- Rename: an over-long name cannot be submitted ------------------------
  await js(`window.__click('${ROW_B} [data-test="device-rename"]')`);
  await js(`window.__type('${ROW_B} [data-test="rename-input"]', "\\u{1F600}".repeat(65))`);
  equal(
    "an over-long name says how far over it is",
    await js(`window.__text('${ROW_B} [data-test="rename-too-long"]')`),
    "1 characters over the limit",
  );
  equal("Save is disabled for it", await js(`window.__disabled('${ROW_B} [data-test="rename-save"]')`), true);
  await js(`window.__click('${ROW_B} [data-test="rename-save"]')`);
  equal(
    "a disabled Save sends nothing",
    (await js(`window.__accountHarness.calls()`)).rename.length,
    0,
  );

  // --- Rename: saving sends the normalised name, and the row updates --------
  await js(`window.__type('${ROW_B} [data-test="rename-input"]', "  Travel   laptop  ")`);
  equal(
    "the rune counter reflects what was typed",
    await js(`window.__text('${ROW_B} [data-test="rename-count"]')`),
    "19/64",
  );
  await js(`window.__accountHarness.setRenameOutcome({ kind: "renamed", name: "Travel laptop" })`);
  check("Save sends", await js(`window.__click('${ROW_B} [data-test="rename-save"]')`));
  const renameCalls = (await js(`window.__accountHarness.calls()`)).rename;
  equal("exactly one rename was sent", renameCalls.length, 1);
  equal("it named the row's id", renameCalls[0]?.id, "dev-bbbb2222");
  equal("it sent the normalised name", renameCalls[0]?.name, "Travel laptop");
  equal("the editor closed after saving", await js(`window.__count('[data-test="rename-prompt"]')`), 0);

  // Main publishes the new list; the row must actually re-render.
  const renamed = {
    ...READY,
    epoch: 5,
    devices: { kind: "ready", value: [DEVICES[0], { ...DEVICES[1], name: "Travel laptop" }] },
  };
  await js(`window.__push(${JSON.stringify(renamed)})`);
  equal(
    "the renamed row renders its new name",
    await js(`window.__text('${ROW_B} [data-test="device-name"]')`),
    "Travel laptop",
  );

  // --- Rename: Enter submits ------------------------------------------------
  await js(`window.__accountHarness.resetCalls()`);
  await js(`window.__click('${ROW_B} [data-test="device-rename"]')`);
  await js(`window.__type('${ROW_B} [data-test="rename-input"]', "Keyboard only")`);
  await js(`window.__key('${ROW_B} [data-test="rename-input"]', "Enter")`);
  equal(
    "Enter submits the editor",
    (await js(`window.__accountHarness.calls()`)).rename[0]?.name,
    "Keyboard only",
  );

  // --- Revoke: the self warning says the whole consequence ------------------
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 6 })})`);
  await js(`window.__accountHarness.resetCalls()`);
  check("the sign-out button opens a confirmation", await js(`window.__click('${ROW_A} [data-test="device-revoke"]')`));
  const selfQuestion = await js(`window.__text('${ROW_A} [data-test="revoke-question"]')`);
  check(
    "revoking THIS PC warns that this app will be signed out",
    selfQuestion?.includes("this PC") && selfQuestion?.includes("signed out"),
    selfQuestion,
  );
  await shoot(page, "03-en-self-revoke-warning");
  check("declining closes it", await js(`window.__click('${ROW_A} [data-test="revoke-cancel"]')`));
  equal("declining sent nothing", (await js(`window.__accountHarness.calls()`)).revoke.length, 0);

  // A different device asks a different, shorter question.
  await js(`window.__click('${ROW_B} [data-test="device-revoke"]')`);
  const otherQuestion = await js(`window.__text('${ROW_B} [data-test="revoke-question"]')`);
  check(
    "revoking another device names that device",
    otherQuestion?.includes("Laptop") && otherQuestion !== selfQuestion,
    otherQuestion,
  );

  // --- Revoke: one row busy, the others untouched ---------------------------
  await js(`window.__accountHarness.takeHold()`);
  await js(`window.__click('${ROW_B} [data-test="revoke-confirm"]')`);
  equal("the working row says so", await js(`window.__count('${ROW_B} [data-test="device-busy"]')`), 1);
  equal(
    "the other row keeps its actions",
    await js(`window.__count('${ROW_A} [data-test="device-rename"]')`),
    1,
  );
  await js(`window.__accountHarness.releaseHold(); window.__tick()`);
  await js(`window.__tick()`);
  equal("exactly one revoke was sent", (await js(`window.__accountHarness.calls()`)).revoke.length, 1);

  // --- An unknown outcome offers a re-READ, never a re-send -----------------
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 7 })})`);
  await js(`window.__accountHarness.resetCalls()`);
  await js(`window.__accountHarness.setRevokeOutcome({ kind: "uncertain" })`);
  await js(`window.__click('${ROW_B} [data-test="device-revoke"]')`);
  await js(`window.__click('${ROW_B} [data-test="revoke-confirm"]')`);
  await js(`window.__tick()`);
  equal(
    "the row reports it as unknown, not as a failure",
    await js(`window.__attr('${ROW_B} [data-test="device-outcome"]', "data-outcome")`),
    "uncertain",
  );
  equal(
    "it offers a re-check",
    await js(`window.__count('${ROW_B} [data-test="device-recheck"]')`),
    1,
  );
  const afterUncertain = await js(`window.__accountHarness.calls()`);
  equal("it did NOT re-send the revoke", afterUncertain.revoke.length, 1);
  check(
    "it re-read the device list instead",
    afterUncertain.refresh.includes("devices"),
    JSON.stringify(afterUncertain.refresh),
  );
  check("the row is still there to re-check", (await js(`window.__count('${ROW_B}')`)) === 1);
  await shoot(page, "04-en-uncertain-outcome");

  // --- Partial failure keeps the sections that worked ----------------------
  await js(`window.__push(${JSON.stringify({ ...USAGE_FAILED, epoch: 8 })})`);
  equal(
    "the profile beside a failed usage read is untouched",
    await js(`window.__text('[data-test="profile-name"]')`),
    "Someone",
  );
  equal("the device list is untouched", await js(`window.__count('[data-test="device-row"]')`), 2);
  equal("the usage card reports its own failure", await js(`window.__count('[data-test="usage-failed"]')`), 1);
  equal("the failed usage card has its own retry", await js(`window.__count('[data-test="usage-retry"]')`), 1);
  equal(
    "no meter is drawn for a read that did not happen",
    await js(`window.__count('[data-test="account-details"] [role="progressbar"]')`),
    0,
  );
  check(
    "the plan card states the known tier AND that the details are missing",
    (await js(`window.__text('[data-test="plan-partial"]')`))?.includes("pro"),
  );
  check(
    "a failed read never becomes a zero, an unlimited or a free plan",
    !(await js(`window.__text('[data-test="usage-failed"]')`))?.includes("Unlimited"),
  );

  await shoot(page, "05-en-partial-failure");
  await js(`window.__accountHarness.resetCalls()`);
  check("the usage retry retries only usage", await js(`window.__click('[data-test="usage-retry"]')`));
  equal(
    "and it refreshed that one section",
    JSON.stringify((await js(`window.__accountHarness.calls()`)).refresh),
    JSON.stringify(["usage"]),
  );

  // --- The one way out of the app ------------------------------------------
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 9 })})`);
  await js(`window.__accountHarness.resetCalls()`);
  check("the manage button exists", await js(`window.__click('[data-test="manage-account"]')`));
  equal(
    "it names a closed destination, never a URL",
    JSON.stringify((await js(`window.__accountHarness.calls()`)).manage),
    JSON.stringify(["account-management"]),
  );
  await js(`window.__accountHarness.setManageOk(false)`);
  await js(`window.__click('[data-test="manage-account"]')`);
  equal(
    "a refused open is reported rather than silent",
    await js(`window.__count('[data-test="manage-failed"]')`),
    1,
  );

  // --- Keyboard reachability ------------------------------------------------
  equal(
    "every row action is a real button",
    await js(`
      Array.from(document.querySelectorAll('[data-test="device-rename"], [data-test="device-revoke"], [data-test="manage-account"], [data-test="usage-retry"]'))
        .every((el) => el.tagName === "BUTTON")
    `),
    true,
  );
  await js(`window.__click('${ROW_B} [data-test="device-rename"]')`);
  equal(
    "the rename field has exactly one label",
    await js(`document.querySelector('${ROW_B} [data-test="rename-input"]').labels.length`),
    1,
  );
  equal(
    "the confirmation is announced as one",
    await js(`
      window.__click('${ROW_A} [data-test="device-revoke"]').then(() =>
        window.__attr('${ROW_A} [data-test="revoke-prompt"]', "role"))
    `),
    "alertdialog",
  );
  await js(`window.__click('${ROW_A} [data-test="revoke-cancel"]')`);

  // --- Simplified Chinese ---------------------------------------------------
  await js(`window.__accountHarness.setLang("zh")`);
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 10 })})`);
  equal("the document language follows", await js(`document.documentElement.lang`), "zh-Hans");
  const zhStorage = await js(`window.__text('[data-test="plan-storage"]')`);
  equal("an unlimited ceiling is translated", zhStorage, "无限制");
  const zhRetention = await js(`window.__text('[data-test="plan-retention"]')`);
  check("retention is translated", /天/.test(zhRetention ?? ""), zhRetention);
  const zhStatus = await js(`window.__text('[data-test="subscription-status"]')`);
  check(
    "the subscription status is translated rather than left as an English token",
    /[一-鿿]/.test(zhStatus ?? "") && !/active/i.test(zhStatus ?? ""),
    zhStatus,
  );
  await js(`window.__click('${ROW_A} [data-test="device-revoke"]')`);
  const zhSelf = await js(`window.__text('${ROW_A} [data-test="revoke-question"]')`);
  check(
    "the self-revoke warning is translated, not silently English",
    /[一-鿿]/.test(zhSelf ?? "") && !/this PC/i.test(zhSelf ?? ""),
    zhSelf,
  );
  await shoot(page, "06-zh-self-revoke-warning");
  await js(`window.__click('${ROW_A} [data-test="revoke-cancel"]')`);
  await shoot(page, "07-zh-complete-account");
  check(
    "the whole screen is free of untranslated fallbacks",
    !/Sign out of this account|Unnamed device|Try again/.test(
      (await js(`window.__text('[data-test="account-details"]')`)) ?? "",
    ),
  );

  // --- An unrecognised status keeps its truth and its language --------------
  await js(`window.__push(${JSON.stringify({
    ...READY,
    epoch: 12,
    profile: { kind: "ready", value: { ...PROFILE, subscriptionStatus: "some_future_state" } },
  })})`);
  const zhUnknown = await js(`window.__text('[data-test="subscription-status"]')`);
  check(
    "an unknown status keeps the raw token inside a translated sentence",
    zhUnknown?.includes("some_future_state") && /[一-鿿]/.test(zhUnknown ?? ""),
    zhUnknown,
  );
  await shoot(page, "10-zh-unrecognised-status");
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 13 })})`);

  // --- Responsive at a narrow window ---------------------------------------
  equal("wide: the fact list is two columns", await js(`window.__tracks('[data-test="profile-facts"]')`), 2);
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  equal(
    "narrow: the fact list reflows to one column",
    await js(`window.__tracks('[data-test="profile-facts"]')`),
    1,
  );
  await shoot(page, "08-zh-narrow-680");
  check(
    "narrow: nothing overflows the window horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
    `scrollWidth ${await js(`document.documentElement.scrollWidth`)} vs ${await js(`document.documentElement.clientWidth`)}`,
  );
  window_.setContentSize(1100, 900);
  await js(`window.__tick()`);

  // --- English again, so the run does not depend on its own order ----------
  await js(`window.__accountHarness.setLang("en")`);
  await js(`window.__push(${JSON.stringify({ ...READY, epoch: 11 })})`);
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await shoot(page, "09-en-narrow-680");
  window_.setContentSize(1100, 900);

  check("the renderer logged no errors", errors.length === 0, errors.join(" | "));
}

main()
  .catch((err) => {
    failures.push(`the driver threw: ${String(err?.stack ?? err)}`);
  })
  .finally(() => {
    process.stdout.write(`RELAYIUM_ACCOUNT_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
