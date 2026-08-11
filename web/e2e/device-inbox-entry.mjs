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
 *      →  signed in: THIS account's real devices, on this page, with a working
 *         send control on each one that can receive — exercised by a genuine
 *         file drop and by keyboard activation of the picker, WITHOUT navigating
 *         anywhere. My Devices is checked as what it now is: a secondary route
 *         for renaming and revoking.
 *
 * It used to end by clicking through to /me, because that was where the send
 * controls lived. That is no longer the primary path and is no longer asserted
 * as one — a passing test for a journey the product does not want people to walk
 * is worse than no test, because it defends the detour.
 *
 * No real backend: /api/* is answered by the same fixture injection the a11y
 * scan uses. The drop therefore encrypts and uploads for real and the upload is
 * refused by `vite preview`, which is exactly the point of the assertion made
 * about it: the card must report an honest failure and must never claim
 * delivery. A real central, a real receiver and a real file on disk are
 * device-inbox.mjs's job.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFixtureScript, ME_DEVICES, ME_ROUTES } from "./a11y-fixtures.mjs";
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

/** The fixture's four devices, split the way the page must split them: two that
 *  can be sent to (online+automatic, offline+ask) and two that cannot
 *  (receiving off, enrolment revoked). Derived from the fixture rather than
 *  hard-coded, so adding a row there cannot silently weaken this. */
const SENDABLE = ME_DEVICES.devices.filter(
  (d) => d.Inbox && !d.Inbox.Revoked && d.Inbox.CanReceive && d.Inbox.AutoAccept !== "off",
);
const UNSENDABLE = ME_DEVICES.devices.filter((d) => !SENDABLE.includes(d));

/** Observe, never replace: a record of every `input.click()` so keyboard
 *  activation of the send button is provable without opening an OS picker. */
const PAGE_HOOKS = `
  window.__inbox = { picker: 0 };
  const realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === "file") { window.__inbox.picker++; return; }
    return realClick.call(this);
  };
`;

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

async function openTab(browser, base, view, path, routes, extra = "") {
  const tab = await newTab(browser, base + path, [
    routes ? apiFixtureScript(routes) : "",
    `try { localStorage.setItem("relayium-lang", ${JSON.stringify(view.lang)}); } catch {}`,
    extra,
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

/**
 * The shape of the page: the tool above the explanation, and a document that
 * does not scroll sideways.
 *
 * Both of these were real, measured defects on 2026-08-11, and NEITHER was
 * visible to the per-element checks below. `VISIBLE` asks whether a section's
 * own border box spills past the viewport; a block-level section's box never
 * does, because it is sized by its container. What actually overflowed was its
 * CONTENT — a grid item whose automatic minimum size is min-content, holding a
 * `white-space: pre` command block — so every platform section measured 390px
 * wide while the document measured 795px and every screen of this page scrolled
 * sideways. The document's own scrollWidth is the only measurement that sees it.
 */
async function checkShape(tab, view, label) {
  const shape = await tab.evaluate(`(() => {
    const doc = document.documentElement;
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    };
    return {
      clientWidth: doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      pageHeight: doc.scrollHeight,
      start: box('[data-di="start"]'),
      notSaved: box('[data-di="not-saved"]'),
      linkBoundary: box('[data-di="link-boundary"]'),
      platforms: box("#platforms"),
    };
  })()`);

  // One pixel of tolerance for sub-pixel rounding. 795 in a 390px viewport is
  // not rounding.
  if (shape.scrollWidth > shape.clientWidth + 1) {
    throw new Error(
      `${view.id} (${label}): the page scrolls sideways — the document is ${shape.scrollWidth}px wide inside a ${shape.clientWidth}px viewport`,
    );
  }

  if (shape.start === null) throw new Error(`${view.id}: there is no operational block on the page`);
  for (const [name, top] of [
    ["the uploaded-is-not-saved callout", shape.notSaved],
    ["the share-link boundary", shape.linkBoundary],
    ["the platform matrix", shape.platforms],
  ]) {
    if (top === null) throw new Error(`${view.id}: ${name} is missing from the page`);
    if (shape.start >= top) {
      throw new Error(
        `${view.id}: the operational block starts at ${shape.start}px, below ${name} at ${top}px — the explanation is back in front of the tool`,
      );
    }
  }

  // Why the order matters at all: a returning owner reaches the control without
  // a scrolling expedition. Two screens is the budget; the measured value
  // before this batch was 2,774px, or 3.3 screens at 390px.
  const budget = 2 * view.height;
  if (shape.start > budget) {
    throw new Error(
      `${view.id}: the operational block starts ${shape.start}px down, past the ${budget}px two-screen budget`,
    );
  }
  ok(`${view.id} (${label}): the tool is ${shape.start}px down a ${shape.pageHeight}px page, and nothing scrolls sideways`);
}

/** The page itself: six honest platform sections and an executable server path. */
async function checkPage(tab, base, view) {
  await tab.waitFor(`document.querySelectorAll("[data-platform]").length === 6`, `${view.id}: six platform sections`);

  // As the reader first meets it: collapsed.
  await checkShape(tab, view, "as it opens");

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

  // The disclosure is a summary of what is inside, so from here on everything
  // must be OPEN. Checking the collapsed page would be the easiest possible
  // false green: the defect this suite now guards against — a command block
  // inflating the document past the viewport — cannot appear while the block
  // that carries it is not laid out.
  await tab.evaluate(`(() => {
    for (const d of document.querySelectorAll("details[data-platform]")) d.open = true;
    return true;
  })()`);
  await sleep(200);

  // Every section is on screen at this width — including at 390px, where the
  // two-column definition list has to collapse rather than overflow.
  for (const id of PLATFORMS) {
    const badVis = await tab.evaluate(VISIBLE(`[data-platform="${id}"]`));
    if (badVis) throw new Error(`${view.id}: the ${id} section is ${badVis}`);
  }

  // …and the same measurement again, now that all six carry their commands.
  await checkShape(tab, view, "every platform expanded");

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
  if (!/<a class="cta" href="\/device-inbox">/.test(guideHtml)) {
    throw new Error(`${view.id}: ${guideHref} still sends the reader away from Device Inbox to operate it`);
  }

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

/**
 * A fragment now has to do two things, and only a browser can show both.
 *
 * Arriving at `/device-inbox#platform-server` must OPEN that section, not stop
 * at a closed summary; the SPA shell is empty when the document loads, so the
 * page owns this, not the browser (WORKFLOW-LEARNINGS, 2026-08-09: "A real
 * browser is where link and layout defects live").
 *
 * And an in-page link must still WRITE its fragment. The handler that opens the
 * disclosure could have cancelled the default action to take over the scroll —
 * that also cancels the fragment, and these links would quietly stop producing
 * a URL worth copying or a Back step they produced before.
 */
const inView = (top, view) => top >= -60 && top <= view.height * 0.5;

async function checkAnchors(browser, base, view) {
  const tab = await openTab(browser, base, view, "/device-inbox#platform-server", null);
  await tab.waitFor(
    `document.querySelectorAll("[data-platform]").length === 6`,
    `${view.id}: the page rendered for the fragment check`,
  );
  await sleep(300);

  const landed = await tab.evaluate(`(() => {
    const d = document.querySelector('[data-platform="server"]');
    const r = d.getBoundingClientRect();
    return JSON.stringify({ open: d.open, top: Math.round(r.top), others: [...document.querySelectorAll("details[data-platform]")].filter((x) => x.open).length });
  })()`);
  const arrived = JSON.parse(landed);
  if (!arrived.open) {
    throw new Error(`${view.id}: /device-inbox#platform-server left the server section closed`);
  }
  if (arrived.others !== 1) {
    throw new Error(`${view.id}: the fragment opened ${arrived.others} sections, not just the one it named`);
  }
  // Scrolled TO it, not merely opened somewhere below the fold. The band is
  // not [0, ∞): opening the disclosure changes the page's height under the
  // scroll that just happened, so the row settles a few pixels either side of
  // the top edge. It has to be AT the top, not merely on screen — a summary row
  // is 44px tall, so anything past -60 has scrolled the named section away.
  if (!inView(arrived.top, view)) {
    throw new Error(`${view.id}: the named section is ${arrived.top}px from the top of a ${view.height}px viewport`);
  }

  // The other direction: a platform's "send from this page" link back to the
  // tool, which must move the reader AND leave the fragment behind it.
  await tab.evaluate(`document.querySelector('[data-di="send-server"]').click()`);
  await sleep(300);
  const back = JSON.parse(await tab.evaluate(`(() => {
    const r = document.querySelector('[data-di="start"]').getBoundingClientRect();
    return JSON.stringify({ hash: location.hash, top: Math.round(r.top) });
  })()`));
  if (back.hash !== "#start") {
    throw new Error(`${view.id}: the send link left the URL at ${JSON.stringify(back.hash)} — the fragment was cancelled`);
  }
  if (!inView(back.top, view)) {
    throw new Error(`${view.id}: the send link left the operational block ${back.top}px from the top`);
  }

  if (tab.errors.length) throw new Error(`${view.id}: page errors — ${tab.errors.join(" / ")}`);
  ok(`${view.id}: a fragment opens the section it names, and an in-page link still writes one`);
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

/**
 * Signed in: this account's own devices, operable HERE.
 *
 * The whole point of the change this guards: a signed-in owner reaches a working
 * send target without a second navigation. So every assertion below happens on
 * /device-inbox, and the only thing done to /me is confirming that the secondary
 * management route still resolves.
 */
async function checkSignedIn(browser, base, view) {
  const tab = await openTab(browser, base, view, "/device-inbox", SIGNED_IN_ROUTES, PAGE_HOOKS);
  await tab.waitFor(`!!document.querySelector('[data-di="next-step"]')`, `${view.id}: the signed-in next step`);

  const state = await tab.evaluate(`document.querySelector('[data-di="start"]').getAttribute("data-state")`);
  // The fixture holds two devices that can receive plus two that cannot, so
  // "ready" is the only correct answer. "checking" or "unknown" here would mean
  // the page never resolved the account it is signed in to.
  if (state !== "ready") throw new Error(`${view.id}: signed-in state is ${state}, expected ready`);
  const next = await tab.evaluate(`document.querySelector('[data-di="next-step"]').textContent.trim()`);
  if (!next) throw new Error(`${view.id}: the next step is empty`);
  const lead = await tab.evaluate(`document.querySelector(".start .lead").textContent`);
  if (!lead.includes("@")) throw new Error(`${view.id}: the start block does not name the signed-in account`);

  // ── the rows themselves, on this page ──────────────────────────────────
  await tab.waitFor(
    `document.querySelectorAll('[data-di="devices"] li').length === ${ME_DEVICES.devices.length}`,
    `${view.id}: every supported device of this account is listed on the page`,
  );
  const rows = await tab.evaluate(`
    [...document.querySelectorAll('[data-di="devices"] li')].map((li) => ({
      name: li.querySelector(".devicename")?.textContent ?? "",
      sendzone: !!li.querySelector(".sendzone"),
      button: !!li.querySelector("button.sendbtn"),
      blocked: (li.querySelector(".inboxblocked")?.textContent ?? "").trim(),
      revoke: !!li.querySelector("button.del"),
      ref: (li.querySelector(".deviceref")?.textContent ?? "").trim(),
    }))
  `);
  for (const d of SENDABLE) {
    const row = rows.find((r) => r.name === d.Name);
    if (!row) throw new Error(`${view.id}: no row for the sendable device ${d.Name}`);
    if (!row.sendzone || !row.button) {
      throw new Error(`${view.id}: ${d.Name} can receive but has no send control on this page`);
    }
  }
  for (const d of UNSENDABLE) {
    const row = rows.find((r) => r.name === d.Name);
    if (!row) throw new Error(`${view.id}: the unsendable device ${d.Name} was dropped from the list`);
    if (row.sendzone) throw new Error(`${view.id}: ${d.Name} cannot receive but was offered a drop target`);
    if (!row.blocked) throw new Error(`${view.id}: ${d.Name} is unsendable with no reason given`);
  }
  // Identity survives the embedding: two machines can share a label, and the id
  // fragment is what tells a send target apart from its namesake.
  if (!rows.every((r) => r.ref)) {
    throw new Error(`${view.id}: a row lost its id fragment: ${JSON.stringify(rows.map((r) => r.ref))}`);
  }
  // Credential management does NOT: revoke is irreversible and would sit beside
  // a drop target.
  if (rows.some((r) => r.revoke)) {
    throw new Error(`${view.id}: a destructive revoke control reached the send surface`);
  }

  // Every send control is actually on screen at this width — at 390px and in
  // Arabic as much as at 1440px. A drop target that overflows the viewport is
  // not a drop target.
  const zoneVisible = await tab.evaluate(`(() => {
    const zones = [...document.querySelectorAll('[data-di="devices"] .sendzone')];
    if (!zones.length) return "no send zone at all";
    for (const z of zones) {
      const r = z.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return "a send zone is zero-sized";
      if (r.right > document.documentElement.clientWidth + 1) return "a send zone overflows the viewport";
    }
    return "";
  })()`);
  if (zoneVisible) throw new Error(`${view.id}: ${zoneVisible}`);

  // ── keyboard reaches the picker, on this page ──────────────────────────
  await tab.evaluate(`document.querySelector('[data-di="devices"] button.sendbtn').focus(); true`);
  if (!(await tab.evaluate(`document.activeElement?.classList.contains("sendbtn")`))) {
    throw new Error(`${view.id}: the send button would not take keyboard focus`);
  }
  for (const type of ["keyDown", "char", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: type === "char" ? "\r" : undefined,
    });
  }
  if (!(await tab.evaluate(`window.__inbox.picker`))) {
    throw new Error(`${view.id}: Enter on the focused send button did not open the file picker`);
  }

  // ── a genuine file drop, from this page ────────────────────────────────
  // Real File objects from the page's own realm, on the real drop target. The
  // browser encrypts and tries to upload for real; `vite preview` has no upload
  // endpoint, so what is asserted is that the card SAYS something true about
  // the failure rather than staying silent or claiming delivery.
  await tab.evaluate(`(() => {
    const zone = document.querySelector('[data-di="devices"] .sendzone');
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode("device inbox in-page drop")], "in-page.txt"));
    zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  // `.bad` is the class the card uses for a settled failure, so waiting for it
  // rather than for "any text" means this cannot be satisfied by catching a
  // mid-flight "Encrypting…" and calling that a reported outcome.
  await tab.waitFor(
    `(document.querySelector('[data-di="devices"] .sendstatus.bad')?.textContent ?? "").trim().length > 0`,
    `${view.id}: the drop ran through encryption and upload and reported an honest failure`,
    30_000,
  );
  const outcome = await tab.evaluate(
    `document.querySelector('[data-di="devices"] .sendstatus').textContent.trim()`,
  );
  // Nothing was ever saved anywhere here, so no wording that implies it may
  // appear. `.sendstatus.ok` is the class the card uses for a real delivery.
  const claimed = await tab.evaluate(
    `!!document.querySelector('[data-di="devices"] .sendstatus.ok')`,
  );
  if (claimed) throw new Error(`${view.id}: the card claimed delivery for a send that never landed: ${outcome}`);
  // The file name must never reach the DOM — the manifest is encrypted.
  if (await tab.evaluate(`document.body.textContent.includes("in-page.txt")`)) {
    throw new Error(`${view.id}: a dropped file name appeared on the page`);
  }

  // ── the secondary route, still a route ─────────────────────────────────
  const badManage = await tab.evaluate(VISIBLE('[data-di="my-devices"]'));
  if (badManage) throw new Error(`${view.id}: the manage-devices link is ${badManage}`);
  await tab.evaluate(`document.querySelector('[data-di="my-devices"]').click()`);
  await tab.waitFor(`location.pathname === "/me"`, `${view.id}: My Devices is still reachable for management`);
  await tab.waitFor(`document.querySelectorAll(".devicelist li").length > 0`, `${view.id}: the device list renders`);
  if (!(await tab.evaluate(`!!document.querySelector(".devicelist li button.del")`))) {
    throw new Error(`${view.id}: /me no longer offers revoke — management has nowhere left to happen`);
  }

  if (tab.errors.length) throw new Error(`${view.id}: page errors — ${tab.errors.join(" / ")}`);
  ok(`${view.id}: signed in → real devices, a real drop and a keyboard picker, all without leaving the page`);
}

await withWatchdog("device-inbox-entry", GLOBAL_TIMEOUT_MS, async () => {
  const base = await startPreview();
  const { browser, close } = await launchBrowser({ debugPort: DEBUG_PORT });
  try {
    for (const view of VIEWS) {
      const tab = await reachFromHome(browser, base, view);
      await checkPage(tab, base, view);
      await checkAnchors(browser, base, view);
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
