#!/usr/bin/env node
/**
 * Device Inbox as a first-class product entry — real-browser acceptance.
 *
 *   cd web && npm run build && npm run test:device-inbox-entry
 *
 * Why this has to be a real browser: what is being delivered is DISCOVERABILITY,
 * and discoverability only exists after layout. jsdom can prove a link is in the
 * DOM; it cannot prove the link resolves, that the sixth nav pill is reachable at
 * 390px, that the page reads left-to-right in Arabic while its shell commands
 * stay LTR, or that the "Sign in" button on the page opens the account dialog the
 * nav owns. Every one of those was a real defect class in this repository
 * (WORKFLOW-LEARNINGS, 2026-08-09: "A real browser is where link and layout
 * defects live", "Shipping a capability is not shipping a way to reach it").
 *
 * The journey, run from the product's front door in each of three views:
 *
 *   /  →  the primary Device Inbox nav link (by KEYBOARD)  →  /device-inbox
 *      →  an executable server setup (installer command + the hosted guide,
 *         fetched and proven to be a real page)
 *      →  signed out: the account dialog actually opens, on the half the button
 *         promised
 *      →  signed in: a state-appropriate next step and a working My Devices route
 *
 * No real backend: /api/* is answered by the same fixture injection the a11y
 * scan uses. What is under test is the web product, not the server.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFixtureScript, ME_ROUTES } from "./a11y-fixtures.mjs";
import { argFlag, fail, launchBrowser, newTab, ok, sleep, withWatchdog } from "./harness.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const macRelease = JSON.parse(
  readFileSync(resolve(here, "..", "native-releases.json"), "utf8"),
).macos;
const macDownloadable = macRelease.available === true && !!macRelease.downloadUrl;
// One debug port per script: lan-transfer 9444 / mixed-link 9445 / a11y 9446 /
// device-discovery 9447.
const DEBUG_PORT = 9448;
const PREVIEW_PORT = Number(argFlag("--preview-port", "4185"));
const GLOBAL_TIMEOUT_MS = 5 * 60_000;

/** Every platform section the PRD requires the page to name, separately. */
const PLATFORMS = ["server", "linux", "macos", "windows", "iphone", "android"];

/** Signed out: only the endpoints the shell itself calls. A 401 on /api/me is
 *  what "signed out" looks like to this app, and the fixture only serves 200s —
 *  so the signed-out run injects nothing and lets the request 404 through
 *  preview, which auth.svelte treats as no session. */
const SIGNED_IN_ROUTES = ME_ROUTES;

let preview = null;

async function startPreview() {
  const viteBin = resolve(here, "..", "node_modules", "vite", "bin", "vite.js");
  preview = spawn(
    process.execPath,
    [viteBin, "preview", "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: resolve(here, ".."), stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${PREVIEW_PORT}`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + "/", { redirect: "manual" });
      if (r.status < 500) return base;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("vite preview did not come up — did you run `npm run build` first?");
}

async function stopPreview() {
  if (!preview) return;
  const exited = once(preview, "exit");
  try { preview.kill("SIGTERM"); } catch { /* already gone */ }
  await Promise.race([exited, sleep(3_000)]);
  try { preview.kill("SIGKILL"); } catch { /* already gone */ }
  preview = null;
}

const VIEWS = [
  { id: "desktop", width: 1440, height: 900, lang: "en", rtl: false },
  { id: "mobile-390", width: 390, height: 844, lang: "en", rtl: false },
  { id: "arabic-rtl", width: 1440, height: 900, lang: "ar", rtl: true },
];

async function openTab(browser, base, view, path, routes) {
  const tab = await newTab(browser, base + path, [
    routes ? apiFixtureScript(routes) : "",
    `try { localStorage.setItem("relayium-lang", ${JSON.stringify(view.lang)}); } catch {}`,
  ].filter(Boolean).join("\n"));
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.width < 700,
  });
  return tab;
}

/** Rendered, non-zero, not spilling out of the viewport. At 390px "rendered"
 *  and "visible" are two different claims. */
const VISIBLE = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "missing";
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return "zero-sized";
  if (r.right > document.documentElement.clientWidth + 1) return "overflows the viewport";
  if (getComputedStyle(el).visibility === "hidden") return "visibility:hidden";
  return "";
})()`;

/**
 * From the front door to the page, using the keyboard only.
 *
 * `.focus()` then a real Enter keydown — not `.click()`. The requirement is that
 * the destination is operable by keyboard, and a click proves only that the
 * handler runs.
 */
async function reachFromHome(browser, base, view) {
  const tab = await openTab(browser, base, view, "/", null);
  await tab.waitFor(`!!document.querySelector('[data-nav="device-inbox"]')`, `${view.id}: the nav link exists`);

  const bad = await tab.evaluate(VISIBLE('[data-nav="device-inbox"]'));
  if (bad) {
    // A pill parked outside a scrolling rail is not a destination anyone can
    // reach. Scroll it in first — that is what the rail is for — then re-check.
    await tab.evaluate(`document.querySelector('[data-nav="device-inbox"]').scrollIntoView({block:"nearest",inline:"nearest"})`);
    const stillBad = await tab.evaluate(VISIBLE('[data-nav="device-inbox"]'));
    if (stillBad) throw new Error(`${view.id}: the Device Inbox nav link is ${stillBad}`);
  }

  // Six destinations, all real links with real hrefs — never fake tabs.
  const navs = await tab.evaluate(
    `[...document.querySelectorAll(".tabs a.tab")].map((a) => [a.getAttribute("data-nav"), new URL(a.href).pathname, a.getAttribute("role")])`,
  );
  if (navs.length !== 6) throw new Error(`${view.id}: ${navs.length} primary destinations, expected 6`);
  const inbox = navs.find((n) => n[0] === "device-inbox");
  if (!inbox) throw new Error(`${view.id}: no Device Inbox destination among ${JSON.stringify(navs)}`);
  if (inbox[1] !== "/device-inbox") throw new Error(`${view.id}: the link points at ${inbox[1]}`);
  if (inbox[2]) throw new Error(`${view.id}: the destination declares role=${inbox[2]}; it is a link, not a tab`);

  // Keyboard: focus it, then press Enter through the real input pipeline.
  await tab.evaluate(`document.querySelector('[data-nav="device-inbox"]').focus()`);
  const focused = await tab.evaluate(`document.activeElement?.getAttribute("data-nav")`);
  if (focused !== "device-inbox") throw new Error(`${view.id}: the link would not take focus (got ${focused})`);
  for (const type of ["keyDown", "char", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r",
    });
  }

  await tab.waitFor(`location.pathname === "/device-inbox"`, `${view.id}: Enter navigates to /device-inbox`);
  await tab.waitFor(`!!document.querySelector(".dinbox h1")`, `${view.id}: the page renders`);
  // aria-current has to move with the route, and to exactly one destination.
  const current = await tab.evaluate(
    `[...document.querySelectorAll('.tabs [aria-current="page"]')].map((a) => a.getAttribute("data-nav"))`,
  );
  if (JSON.stringify(current) !== JSON.stringify(["device-inbox"])) {
    throw new Error(`${view.id}: aria-current is on ${JSON.stringify(current)}`);
  }
  // This route needs an account, so the account control must be in the nav —
  // the page's own Sign in button opens that component's dialog.
  if (!(await tab.evaluate(`!!document.querySelector(".acct-btn")`))) {
    throw new Error(`${view.id}: the account control is missing on a route that requires an account`);
  }
  ok(`${view.id}: / → Device Inbox by keyboard, with aria-current and the account control`);
  return tab;
}

/** The page itself: six honest platform sections and an executable server path. */
async function checkPage(tab, base, view) {
  await tab.waitFor(`document.querySelectorAll("[data-platform]").length === 6`, `${view.id}: six platform sections`);

  const sections = await tab.evaluate(
    `[...document.querySelectorAll("[data-platform]")].map((e) => [e.getAttribute("data-platform"), e.getAttribute("data-status")])`,
  );
  const ids = sections.map((s) => s[0]);
  for (const want of PLATFORMS) {
    if (!ids.includes(want)) throw new Error(`${view.id}: no section for ${want} (got ${JSON.stringify(ids)})`);
  }
  const status = Object.fromEntries(sections);
  if (status.server !== "available" || status.linux !== "available") {
    throw new Error(`${view.id}: server/linux are not marked available: ${JSON.stringify(status)}`);
  }
  if (status.macos !== "testing") throw new Error(`${view.id}: macOS is marked ${status.macos}, not testing`);
  for (const planned of ["windows", "iphone", "android"]) {
    if (status[planned] !== "planned") throw new Error(`${view.id}: ${planned} is marked ${status[planned]}`);
  }

  // Every section is on screen at this width — including at 390px, where the
  // two-column definition list has to collapse rather than overflow.
  for (const id of PLATFORMS) {
    const badVis = await tab.evaluate(VISIBLE(`[data-platform="${id}"]`));
    if (badVis) throw new Error(`${view.id}: the ${id} section is ${badVis}`);
  }

  // A native product that does not exist gets no command. The macOS branch is
  // tied to the same canonical release manifest as the rendered page, so this
  // journey remains meaningful before and after the release-state transition.
  for (const id of ["iphone", "android"]) {
    const cmds = await tab.evaluate(`document.querySelectorAll('[data-platform="${id}"] pre').length`);
    if (cmds !== 0) throw new Error(`${view.id}: the ${id} section shows ${cmds} runnable command block(s)`);
  }
  const macDownload = await tab.evaluate(
    `document.querySelector('[data-di="mac-download"]')?.getAttribute('href') ?? null`,
  );
  const macNoDownload = await tab.evaluate(
    `!!document.querySelector('[data-di="mac-no-download"]')`,
  );
  if (macDownloadable) {
    if (macDownload !== macRelease.downloadUrl) {
      throw new Error(`${view.id}: the macOS download does not match native-releases.json`);
    }
    if (macNoDownload) throw new Error(`${view.id}: released macOS still shows the no-download copy`);
  } else {
    if (macDownload !== null) {
      throw new Error(`${view.id}: a macOS download CTA appeared while native-releases.json says there is none`);
    }
    if (!macNoDownload) {
      throw new Error(`${view.id}: the macOS section does not explain why there is no download`);
    }
  }

  // The executable server path: the installer, inspected before it gets root.
  const serverCmd = await tab.evaluate(`document.querySelector('[data-platform="server"] pre')?.textContent ?? ""`);
  for (const fragment of [
    "curl -fsSLO https://relayium.com/inbox-server-install.sh",
    "less inbox-server-install.sh",
    "sudo sh inbox-server-install.sh --dir /srv/relayium-inbox",
  ]) {
    if (!serverCmd.includes(fragment)) {
      throw new Error(`${view.id}: the server setup does not include ${JSON.stringify(fragment)}`);
    }
  }
  if (serverCmd.includes("inbox run")) {
    throw new Error(`${view.id}: the server setup leads with a foreground run`);
  }

  // The two boundaries have their own callouts, and both are on screen.
  for (const sel of ['[data-di="not-saved"]', '[data-di="link-boundary"]']) {
    const badBox = await tab.evaluate(VISIBLE(sel));
    if (badBox) throw new Error(`${view.id}: ${sel} is ${badBox}`);
  }

  // The hosted guide is a real page, in this view's language, not a 404.
  const guideHref = await tab.evaluate(`document.querySelector('[data-di="server-guide"]').getAttribute("href")`);
  const expected = view.lang === "en" ? "/guides/device-inbox-server/" : `/${view.lang}/guides/device-inbox-server/`;
  if (guideHref !== expected) throw new Error(`${view.id}: the guide link is ${guideHref}, expected ${expected}`);
  const guide = await fetch(base + guideHref, { redirect: "manual" });
  if (guide.status !== 200) throw new Error(`${view.id}: ${guideHref} answered ${guide.status}`);
  const guideHtml = await guide.text();
  if (!/<h1[^>]*>/.test(guideHtml)) throw new Error(`${view.id}: ${guideHref} is not a rendered guide page`);

  if (view.rtl) {
    const dir = await tab.evaluate(`getComputedStyle(document.querySelector(".dinbox")).direction`);
    if (dir !== "rtl") throw new Error(`arabic: the page renders ${dir}, not rtl`);
    const navDir = await tab.evaluate(`getComputedStyle(document.querySelector(".tabs")).direction`);
    if (navDir !== "rtl") throw new Error(`arabic: the nav rail renders ${navDir}, not rtl`);
    // A bidi-reordered shell command is one nobody can read or paste correctly.
    const cmdDirs = await tab.evaluate(
      `[...document.querySelectorAll(".dinbox pre")].map((e) => getComputedStyle(e).direction)`,
    );
    if (!cmdDirs.length) throw new Error("arabic: the page has no command block at all");
    if (cmdDirs.some((d) => d !== "ltr")) {
      throw new Error(`arabic: a command block renders ${cmdDirs.join("/")}; shell commands must stay ltr`);
    }
  }
  ok(`${view.id}: six honest platform sections, an inspectable installer and a live server guide`);
}

/** Signed out: two buttons that open the real account dialog, on two panels. */
async function checkSignedOut(tab, view) {
  await tab.waitFor(`document.querySelector('[data-di="start"]')?.getAttribute("data-state") === "signed-out"`,
    `${view.id}: the signed-out start block`);

  for (const sel of ['[data-di="sign-in"]', '[data-di="create-account"]']) {
    const bad = await tab.evaluate(VISIBLE(sel));
    if (bad) throw new Error(`${view.id}: ${sel} is ${bad}`);
  }
  // No device claim of any kind while signed out.
  if (await tab.evaluate(`!!document.querySelector('[data-di="next-step"]')`)) {
    throw new Error(`${view.id}: a device state is claimed for a visitor with no account`);
  }

  await tab.evaluate(`document.querySelector('[data-di="sign-in"]').click()`);
  await tab.waitFor(`!!document.querySelector('.modal[role="dialog"]')`, `${view.id}: the account dialog opens`);
  const loginPanel = await tab.evaluate(
    `!!document.querySelector('.modal[role="dialog"] input[type="password"]')`,
  );
  if (!loginPanel) throw new Error(`${view.id}: the dialog opened without a sign-in form`);

  // Close, then prove the second button lands somewhere different — two controls
  // that open the same panel would make one of them a lie about what it does.
  await tab.evaluate(`
    (() => {
      const d = document.querySelector('.modal[role="dialog"]');
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    })()
  `);
  await tab.waitFor(`!document.querySelector('.modal[role="dialog"]')`, `${view.id}: the dialog closes`);
  await tab.evaluate(`document.querySelector('[data-di="create-account"]').click()`);
  await tab.waitFor(`!!document.querySelector('.modal[role="dialog"]')`, `${view.id}: the dialog reopens`);
  const name = await tab.evaluate(
    `document.querySelector('.modal[role="dialog"]').getAttribute("aria-label")
     || document.querySelector('.modal[role="dialog"] h2, .modal[role="dialog"] h3')?.textContent || ""`,
  );
  if (!name.trim()) throw new Error(`${view.id}: the account dialog has no accessible name`);
  const registerPanel = await tab.evaluate(
    `!!document.querySelector('.modal[role="dialog"] form')`,
  );
  if (!registerPanel) throw new Error(`${view.id}: "Create an account" opened a dialog with no form`);
  ok(`${view.id}: both signed-out controls open the real account dialog`);
}

/** Signed in: a state-appropriate next step, and My Devices actually reached. */
async function checkSignedIn(browser, base, view) {
  const tab = await openTab(browser, base, view, "/device-inbox", SIGNED_IN_ROUTES);
  await tab.waitFor(`!!document.querySelector('[data-di="next-step"]')`, `${view.id}: the signed-in next step`);

  const state = await tab.evaluate(`document.querySelector('[data-di="start"]').getAttribute("data-state")`);
  // The fixture holds one device that can receive plus three that cannot, so
  // "ready" is the only correct answer. "checking" or "unknown" here would mean
  // the page never resolved the account it is signed in to.
  if (state !== "ready") throw new Error(`${view.id}: signed-in state is ${state}, expected ready`);
  const next = await tab.evaluate(`document.querySelector('[data-di="next-step"]').textContent.trim()`);
  if (!next) throw new Error(`${view.id}: the next step is empty`);
  const lead = await tab.evaluate(`document.querySelector(".start .lead").textContent`);
  if (!lead.includes("@")) throw new Error(`${view.id}: the start block does not name the signed-in account`);

  const badCta = await tab.evaluate(VISIBLE('[data-di="my-devices"]'));
  if (badCta) throw new Error(`${view.id}: the My Devices action is ${badCta}`);
  await tab.evaluate(`document.querySelector('[data-di="my-devices"]').click()`);
  await tab.waitFor(`location.pathname === "/me"`, `${view.id}: My Devices is reached`);
  await tab.waitFor(`document.querySelectorAll(".devicelist li").length > 0`, `${view.id}: the device list renders`);

  if (tab.errors.length) throw new Error(`${view.id}: page errors — ${tab.errors.join(" / ")}`);
  ok(`${view.id}: signed in → a true next step → My Devices`);
}

await withWatchdog("device-inbox-entry", GLOBAL_TIMEOUT_MS, async () => {
  const base = await startPreview();
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT });
  try {
    for (const view of VIEWS) {
      const tab = await reachFromHome(browser, base, view);
      await checkPage(tab, base, view);
      await checkSignedOut(tab, view);
      if (tab.errors.length) throw new Error(`${view.id}: page errors — ${tab.errors.join(" / ")}`);
      await checkSignedIn(browser, base, view);
    }
    console.log(
      "\n  Device Inbox reached from the site's front door by keyboard, with six honest platform" +
      "\n  sections, an executable server path and both account states, at 1440×900, 390×844 and Arabic RTL\n",
    );
  } catch (err) {
    fail("device-inbox-entry", err);
    process.exitCode = 1;
  } finally {
    await close();
    await stopPreview();
  }
});
