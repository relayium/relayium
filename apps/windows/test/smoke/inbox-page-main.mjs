// The Device Inbox, in a real renderer, driven through the real DOM.
//
// Not a mock of the page. It loads the bundle the wrapper compiled from
// `src/renderer/pages/InboxPage.svelte` and its two real controllers with the
// ordinary Svelte CLIENT build, then reads the actual DOM and clicks the actual
// buttons.
//
// ## What only this can catch
//
// The controller cases prove the guards and the state machine. They cannot see:
//
//   * a retained row that renders an OS errno instead of a sentence — which is
//     what shipped until 2026-09-12, and what every type check accepted;
//   * a phase whose copy is present in the catalogue and never reached;
//   * two different outcomes rendering the same sentence, so a person cannot
//     tell a saved delivery from a failed one;
//   * a row keyed so a release re-creates it instead of removing it;
//   * a Chinese screen that is quietly English because a key resolves to its
//     fallback.
//
// The send half is mounted but NOT driven: its bridge rejects every call, so a
// scenario that strayed into it fails loudly rather than passing on a stub.
//
// ## What it touches
//
// The two task-owned directories the wrapper passes in, which the wrapper
// removes once these Chromium handles are certainly closed.

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const failures = [];
let checks = 0;
const check = (name, ok, detail) => {
  checks += 1;
  if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`);
  // RETURNED, so `if (!check(...)) return;` means what it reads as. See the
  // note in `account-details-main.mjs`: a `check` returning undefined turns
  // that idiom into an unconditional return, and the run stays green.
  return ok;
};
const equal = (name, actual, expected) =>
  check(
    name,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const [bundleDir, userDataDir] = process.argv.slice(2);
if (!bundleDir || !userDataDir) {
  process.stdout.write(
    `RELAYIUM_INBOX_UI ${JSON.stringify({
      failures: ["missing task-owned directory arguments"],
      checks: 0,
    })}\n`,
  );
  process.exit(1);
}
app.setPath("userData", userDataDir);

/** One retained handle, as `InboxRetainedView` declares it. */
const retained = (key, residue) => ({ key, taskID: `task-${key}`, residue });

/** One journal row, as `InboxReceiptView` declares it. */
const receipt = (taskID, phase, over = {}) => ({
  taskID,
  phase,
  total: 3,
  published: phase === "partial" ? 1 : 3,
  text: false,
  updatedAt: 1_700_000_000,
  serverTerminal: false,
  ...over,
});

async function main() {
  await app.whenReady();
  const window_ = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const page = window_.webContents;
  page.on("render-process-gone", (_e, details) => {
    failures.push(`the renderer died: ${JSON.stringify(details)}`);
  });

  await window_.loadURL(pathToFileURL(path.join(bundleDir, "index.html")).toString());
  const js = (code) => page.executeJavaScript(code, true);

  // A tiny query surface. Everything below reads the DOM through it, never the
  // controller: a field that is right while the screen is wrong is the failure
  // these cases exist to catch.
  await js(`
    window.__tick = () => new Promise((r) => setTimeout(r, 30));
    window.__text = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : el.textContent.replace(/\\s+/g, " ").trim();
    };
    window.__all = (sel) =>
      [...document.querySelectorAll(sel)].map((el) => el.textContent.replace(/\\s+/g, " ").trim());
    window.__count = (sel) => document.querySelectorAll(sel).length;
    window.__click = async (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      el.click();
      await window.__tick();
      return true;
    };
    window.__push = async (view) => {
      window.__inboxHarness.push(view);
      await window.__tick();
      await window.__tick();
    };
    true;
  `);

  if (!check("the harness mounted", await js(`typeof window.__inboxHarness === "object"`))) {
    return;
  }
  await js(`window.__inboxHarness.setLang("en")`);

  // --- Every InboxStatus member puts something on screen -------------------
  //
  // The page renders these through an `{#if status.kind === ...}` chain, and
  // Svelte gives if-chains NO exhaustiveness check. TypeScript cannot help
  // either: a tenth member would simply match no branch and the status area
  // would render nothing, with a green build and a green unit suite. Driving
  // every member is the only mechanism that catches it, which is the reason
  // this list is exhaustive and not a sample.
  //
  // `disabled` is handled structurally rather than by a status line: when the
  // user has not asked to receive, the whole surface is the offer to turn it
  // on, so its evidence is the enable button.
  const STATUSES = [
    ["unavailable", { status: { kind: "unavailable", reason: "internal" } }, "inbox-unavailable"],
    ["needs-account", { status: { kind: "needs-account" } }, "inbox-sign-in"],
    ["account-unreadable", { status: { kind: "account-unreadable" } }, "inbox-store-unreadable"],
    ["disabled", { status: { kind: "disabled" }, enabled: false, policy: "off" }, "inbox-enable"],
    ["folder-missing", { status: { kind: "folder-missing" } }, "inbox-folder-missing"],
    ["starting", { status: { kind: "starting" } }, "inbox-starting"],
    ["receiving", { status: { kind: "receiving" } }, "inbox-receiving"],
    ["idle", { status: { kind: "idle", pending: 0 } }, "inbox-idle"],
    [
      "blocked",
      { status: { kind: "blocked", reason: "storage-unreadable", residue: "none", pending: 0 } },
      "inbox-blocked",
    ],
    [
      "offline",
      { status: { kind: "offline", reason: "transport", retryInSeconds: 30 } },
      "inbox-offline",
    ],
  ];
  const statusTexts = {};
  for (const [name, view, hook] of STATUSES) {
    await js(`window.__push(${JSON.stringify(view)})`);
    const text = await js(`window.__text("[data-test=${hook}]")`);
    if (!check(`${name} renders ${hook}`, typeof text === "string", String(text))) continue;
    check(`${name} says something`, text.length > 0, `${hook} is empty`);
    statusTexts[name] = text;
  }
  // Nine sentences for nine states. Two reading the same would mean a person
  // cannot tell two situations apart — the failure this page's own comments
  // call out ("the same screen for two opposite situations").
  const distinct = new Set(Object.values(statusTexts));
  check(
    "the statuses do not read as each other",
    distinct.size === Object.keys(statusTexts).length,
    JSON.stringify(statusTexts),
  );
  // The sign-in offer is wired, not merely drawn.
  await js(`window.__push(${JSON.stringify({ status: { kind: "needs-account" } })})`);
  await js(`window.__click("[data-test=inbox-sign-in]")`);
  equal("the sign-in offer calls back", (await js(`window.__inboxHarness.calls()`)).signIn, 1);

  // --- Nothing retained shows no card -------------------------------------
  await js(`window.__push({ retained: [] })`);
  equal("no retained card when nothing is retained", await js(`window.__count("[data-test=inbox-retained]")`), 0);

  // --- Each residue state says its own thing ------------------------------
  const sentences = {};
  for (const state of ["present", "none", "unknown"]) {
    await js(`window.__push({ retained: [${JSON.stringify(retained("k1", state))}] })`);
    const text = await js(`window.__text("[data-test=inbox-retained-residue]")`);
    if (!check(`${state} renders a sentence`, typeof text === "string" && text.length > 0, String(text))) {
      continue;
    }
    sentences[state] = text;
    // The defect this replaced: the row's whole label was `error.code`.
    check(
      `${state} is prose, not a code`,
      / /.test(text) && !/^[A-Z]{3,}$/.test(text),
      text,
    );
    check(`${state} names no errno`, !/\bE[A-Z]{2,}\b/.test(text), text);
  }
  check(
    "the three residue states read differently",
    new Set(Object.values(sentences)).size === 3,
    JSON.stringify(sentences),
  );
  // The one a person most needs distinguished: files ARE there vs unknown.
  check(
    "present and unknown are not the same sentence",
    sentences.present !== undefined && sentences.present !== sentences.unknown,
    JSON.stringify([sentences.present, sentences.unknown]),
  );

  // --- Chinese is Chinese -------------------------------------------------
  await js(`window.__inboxHarness.setLang("zh")`);
  await js(`window.__push({ retained: [${JSON.stringify(retained("k1", "present"))}] })`);
  const zhText = await js(`window.__text("[data-test=inbox-retained-residue]")`);
  check("the Chinese retained row is Chinese", /[一-鿿]/.test(String(zhText)), String(zhText));
  check("and is not the English one", zhText !== sentences.present, String(zhText));
  await js(`window.__inboxHarness.setLang("en")`);

  // --- Retry releases THIS row, and the row goes ---------------------------
  await js(`window.__push({ retained: [${JSON.stringify(retained("k7", "present"))}] })`);
  equal("one retained row", await js(`window.__count("[data-test=inbox-retained] li")`), 1);
  check("the retry button is there", await js(`window.__click("[data-test=inbox-release]")`));
  await js(`window.__tick()`);
  const released = await js(`window.__inboxHarness.calls()`);
  equal("release was called with this row's key", JSON.stringify(released.release), JSON.stringify(["k7"]));
  equal(
    "a released row leaves the screen",
    await js(`window.__count("[data-test=inbox-retained]")`),
    0,
  );

  // --- A release that FAILS keeps the row ----------------------------------
  await js(`window.__inboxHarness.setReleaseOk(false)`);
  await js(`window.__push({ retained: [${JSON.stringify(retained("k8", "unknown"))}] })`);
  await js(`window.__click("[data-test=inbox-release]")`);
  await js(`window.__tick()`);
  equal(
    "a failed release does not pretend the row is gone",
    await js(`window.__count("[data-test=inbox-retained] li")`),
    1,
  );
  await js(`window.__inboxHarness.setReleaseOk(true)`);

  // --- A blocked delivery says WHICH problem --------------------------------
  //
  // `InboxStatus.blocked` has always carried its reason and the page rendered
  // one sentence over all sixteen of them, so a full disk, a receive folder
  // that had gone away and a delivery the person declined themselves all read
  // the same. Wording is macOS's; what is proved here is that the reason
  // reaches the screen at all, and that reasons a person acts on differently
  // read differently.
  //
  // The state is not one main produces today — `InboxFacade.state()` never
  // returns `blocked` — so this drives a surface before anything can reach it.
  // That is deliberate and is the only way to check it at all: the alternative
  // is finding out from the first user who does reach it.
  const blockedFor = async (reason) => {
    await js(`window.__push(${JSON.stringify({
      status: { kind: "blocked", reason: "PLACEHOLDER", residue: "none", pending: 0 },
    }).replace('"PLACEHOLDER"', JSON.stringify(reason))})`);
    return js(`window.__text("[data-test=inbox-blocked]")`);
  };
  const declined = await blockedFor("cancelled");
  const noFolder = await blockedFor("storage-unreadable");
  const badBytes = await blockedFor("verification-failed");
  const noKey = await blockedFor("key-unavailable");
  const network = await blockedFor("transport");
  for (const [name, text] of [["declined", declined], ["no folder", noFolder],
                              ["bad bytes", badBytes], ["no key", noKey], ["network", network]]) {
    check(`blocked/${name} says something`, typeof text === "string" && text.length > 0, String(text));
  }
  check(
    "five reasons a person acts on differently read differently",
    new Set([declined, noFolder, badBytes, noKey, network]).size === 5,
    JSON.stringify({ declined, noFolder, badBytes, noKey, network }),
  );
  // The one that used to be indistinguishable and is the most actionable: a
  // delivery the person themselves declined is not a fault to investigate.
  check(
    "a declined delivery does not read as a fault",
    /declin/i.test(String(declined)),
    String(declined),
  );

  // --- The notice a FAILED act produces ------------------------------------
  //
  // `InboxNotice.failed` had no case in the page's switch and reached
  // `default: return t("inboxFailed")`. It reads correctly, which is why
  // nothing noticed; the default was load-bearing for a real member, and that
  // is what defeats exhaustiveness. Named explicitly now, and DRIVEN here so
  // the naming is not only a compile-time claim.
  await js(`window.__inboxHarness.setReleaseOk(false)`);
  await js(`window.__push({ retained: [${JSON.stringify(retained("k9", "present"))}] })`);
  await js(`window.__click("[data-test=inbox-release]")`);
  await js(`window.__tick()`);
  const failedNotice = await js(`window.__text("[data-test=inbox-notice]")`);
  check(
    "a failed act says so, rather than rendering nothing",
    typeof failedNotice === "string" && failedNotice.length > 0,
    String(failedNotice),
  );
  check(
    "and says it in words, not as a code",
    / /.test(String(failedNotice)) && !/\binternal\b/.test(String(failedNotice)),
    String(failedNotice),
  );
  await js(`window.__inboxHarness.setReleaseOk(true)`);
  await js(`window.__click("[data-test=inbox-notice-dismiss]")`);

  // --- Every journal phase renders its own sentence ------------------------
  const PHASES = ["claimed", "publishing", "published", "partial", "acked", "failed"];
  await js(
    `window.__inboxHarness.setReceipts(${JSON.stringify(PHASES.map((p, i) => receipt(`t${i}`, p)))})`,
  );
  await js(`window.__push({ retained: [] })`);
  const phaseTexts = await js(`window.__all("[data-test=inbox-receipt-phase]")`);
  equal("every phase rendered a row", phaseTexts.length, PHASES.length);
  check(
    "no phase rendered an empty sentence",
    phaseTexts.every((s) => typeof s === "string" && s.length > 0),
    JSON.stringify(phaseTexts),
  );
  // `acked`, `partial` and `failed` are the three outcomes a person acts on
  // differently. The old fallback made an unrecognised phase read as "Needs a
  // decision"; these prove the real ones are told apart.
  const byPhase = Object.fromEntries(PHASES.map((p, i) => [p, phaseTexts[i]]));
  check("saved and failed read differently", byPhase.acked !== byPhase.failed, JSON.stringify(byPhase));
  check("saved and partial read differently", byPhase.acked !== byPhase.partial, JSON.stringify(byPhase));
  check(
    "claimed and publishing are both 'working', which is deliberate",
    byPhase.claimed === byPhase.publishing,
    JSON.stringify(byPhase),
  );
  check(
    "no phase reads as the removed fallback",
    !phaseTexts.some((s) => /needs a decision/i.test(String(s))),
    JSON.stringify(phaseTexts),
  );
}

main()
  .catch((err) => {
    failures.push(`the driver threw: ${String(err?.stack ?? err)}`);
  })
  .finally(() => {
    process.stdout.write(`RELAYIUM_INBOX_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length > 0 ? 1 : 0);
  });
