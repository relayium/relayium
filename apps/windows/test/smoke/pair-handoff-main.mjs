// The pairing handoff, in a real renderer, driven through the real DOM.
//
// The unit cases prove the link rule, the generation discipline and the
// encoder. Only this can see that a real QR paints, that a "Copied" disappears
// when the code changes, and that the layout still works at 680.
//
// The bridge is synthetic and in-page: no main process and no clipboard.

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
    `RELAYIUM_PAIR_UI ${JSON.stringify({ failures: ["missing task-owned directory arguments"], checks: 0 })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

const ORIGIN = "https://relayium.test";
const live = (code, generation) => ({
  kind: "live",
  code,
  expiresAt: 9_999_999_999,
  link: `${ORIGIN}/cross-network#c=${code}`,
  generation,
});
const idle = (generation) => ({ kind: "idle", generation });

const rendererErrors = [];

/**
 * Capture just the QR, at its own bounds.
 *
 * Named with the code it must decode to, so the PNG can be decoded
 * independently — by a scanner this build does not depend on — and checked
 * against a known answer. The full-pane captures are for looking at; this one
 * is for decoding.
 */
async function shootQr(page, js, name) {
  if (!shotDir) return;
  const rect = await js(`
    (() => {
      const el = document.querySelector('[data-test="pair-qr"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()
  `);
  if (rect === null || rect.width < 8 || rect.height < 8) {
    failures.push(`qr capture ${name}: no QR element to capture`);
    return;
  }
  const image = await page.capturePage(rect);
  const png = image.toPNG();
  if (png.length === 0) {
    failures.push(`qr capture ${name}: empty capture`);
    return;
  }
  writeFileSync(path.join(shotDir, `${name}.png`), png);
  checks += 1;
}

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

  // Helpers, not inline statements: `executeJavaScript` evaluates a CLASSIC
  // script, where a top-level `await` is a SyntaxError.
  await js(`
    window.__tick = () => new Promise((r) => setTimeout(r, 40));
    window.__text = (s) => { const e = document.querySelector(s); return e === null ? null : e.textContent.replace(/\\s+/g, " ").trim(); };
    window.__count = (s) => document.querySelectorAll(s).length;
    window.__attr = (s, n) => { const e = document.querySelector(s); return e === null ? null : e.getAttribute(n); };
    window.__disabled = (s) => { const e = document.querySelector(s); return e === null ? null : e.disabled === true; };
    window.__click = async (s) => { const e = document.querySelector(s); if (e === null) return false; e.click(); await window.__tick(); return true; };
    window.__push = async (v) => { window.__pairHarness.push(v); await window.__tick(); await window.__tick(); };
    window.__copyNow = async () => { await window.__click('[data-test="pair-copy"]'); await window.__tick(); };
    window.__encode = (link) => window.__pairHarness.encode(link);
    true;
  `);
  check("the harness mounted", await js(`typeof window.__pairHarness === "object"`));

  // --- idle renders nothing ------------------------------------------------
  at("idle renders nothing");
  await js(`window.__push(${JSON.stringify(idle(0))})`);
  equal("no handoff without a live code", await js(`window.__count('[data-test="pair-handoff"]')`), 0);

  // --- a live code renders a REAL QR --------------------------------------
  at("live code renders a real QR");
  await js(`window.__push(${JSON.stringify(live("483920", 1))})`);
  equal("the handoff renders", await js(`window.__count('[data-test="pair-handoff"]')`), 1);
  equal("a QR image is present", await js(`window.__count('[data-test="pair-qr"]')`), 1);
  const src = await js(`window.__attr('[data-test="pair-qr"]', "src")`);
  check("it is a PNG data URL", (src ?? "").startsWith("data:image/png;base64,"), (src ?? "").slice(0, 40));
  check("the image actually decoded", await js(`
    (() => { const i = document.querySelector('[data-test="pair-qr"]'); return i !== null && i.complete && i.naturalWidth > 0; })()
  `), "naturalWidth was 0");
  equal("the link is shown", await js(`window.__text('[data-test="pair-link"]')`), `${ORIGIN}/cross-network#c=483920`);
  check("the link has no query", !(await js(`window.__text('[data-test="pair-link"]')`) ?? "").includes("?"));
  await shoot(page, "01-en-live");
  // The decodable artefact. Its filename states the answer a scanner must give.
  await shootQr(page, js, "05-qr-only-expects-https-relayium-test-cross-network-hash-c-483920");

  // --- the rendered QR is the image for the link this driver EXPECTS -------
  //
  // SCOPE, stated precisely: this does NOT decode the image. It compares the
  // rendered PNG to one produced by encoding, INDEPENDENTLY of the product's
  // QR path, the link this driver built for itself. Byte equality means the
  // pane is showing the image this encoder produces for that exact string.
  //
  // A scanner result is a different claim, and it is not made here. The tight
  // capture below exists so it can be made separately, by decoding the actual
  // pixels with a tool this build does not depend on.
  at("QR payload");
  const expected = `${ORIGIN}/cross-network#c=483920`;
  const reference = await js(`window.__encode(${JSON.stringify(expected)})`);
  check("the reference encode produced an image", (reference ?? "").startsWith("data:image/png;base64,"));
  equal("the rendered QR is byte-identical to an independent encode of the expected link", src, reference);
  // And the comparison discriminates: a different payload is a different image.
  const otherRef = await js(`window.__encode(${JSON.stringify(`${ORIGIN}/cross-network#c=111111`)})`);
  check("a different link produces a different image", otherRef !== reference, "encoder output was not payload-sensitive");
  // A query-form link must not be what is on screen.
  const queryRef = await js(`window.__encode(${JSON.stringify(`${ORIGIN}/cross-network?c=483920`)})`);
  check("the QR is not the query form", queryRef !== src, "the rendered QR matched a ?c= link");

  // --- copy sends only the token ------------------------------------------
  at("copy token");
  await js(`window.__pairHarness.resetCalls()`);
  await js(`window.__pairHarness.setCopyOutcome(${JSON.stringify({ kind: "copied", generation: 1 })})`);
  await js(`window.__copyNow()`);
  equal(
    "only the closed token crossed",
    JSON.stringify((await js(`window.__pairHarness.calls()`)).copy),
    JSON.stringify(["copy-join-link"]),
  );
  equal("the confirmation shows", await js(`window.__count('[data-test="pair-copied"]')`), 1);
  await shoot(page, "02-en-copied");

  // --- the confirmation and the QR belong to ONE link ----------------------
  at("artefacts follow the generation");
  const before = await js(`window.__attr('[data-test="pair-qr"]', "src")`);
  await js(`window.__push(${JSON.stringify(live("111111", 2))})`);
  equal("the stale confirmation is gone", await js(`window.__count('[data-test="pair-copied"]')`), 0);
  equal("the link is the new one", await js(`window.__text('[data-test="pair-link"]')`), `${ORIGIN}/cross-network#c=111111`);
  const after = await js(`window.__attr('[data-test="pair-qr"]', "src")`);
  check("the QR was re-encoded for the new link", after !== before && (after ?? "").startsWith("data:image/png"), "QR did not change");
  equal("the generation is on the element", await js(`window.__attr('[data-test="pair-handoff"]', "data-generation")`), "2");

  // --- expiry and failure are their own sentences --------------------------
  at("copy outcomes");
  await js(`window.__pairHarness.setCopyOutcome(${JSON.stringify({ kind: "expired" })})`);
  await js(`window.__copyNow()`);
  equal("expiry says so", await js(`window.__count('[data-test="pair-copy-expired"]')`), 1);
  equal("and does not claim a copy", await js(`window.__count('[data-test="pair-copied"]')`), 0);

  await js(`window.__pairHarness.setRejects({ copy: true })`);
  await js(`window.__push(${JSON.stringify(live("222222", 3))})`);
  await js(`window.__copyNow()`);
  equal("a broken channel says so", await js(`window.__count('[data-test="pair-copy-failed"]')`), 1);
  await js(`window.__pairHarness.setRejects({ copy: false })`);

  // --- expiry removes BOTH the QR and the copy ----------------------------
  //
  // Expiry is main's: it stops publishing a live view. What this asserts is
  // that the pane holds nothing of its own once that happens — no QR image, no
  // link, no copy button for a code that has run out.
  at("expiry");
  await js(`window.__push(${JSON.stringify(live("999999", 6))})`);
  equal("a live code before expiry", await js(`window.__count('[data-test="pair-qr"]')`), 1);
  await js(`window.__push(${JSON.stringify(idle(7))})`);
  equal("expiry removes the QR", await js(`window.__count('[data-test="pair-qr"]')`), 0);
  equal("expiry removes the copy button", await js(`window.__count('[data-test="pair-copy"]')`), 0);
  equal("expiry removes the link", await js(`window.__count('[data-test="pair-link"]')`), 0);

  // --- leaving clears everything ------------------------------------------
  at("leaving clears");
  await js(`window.__push(${JSON.stringify(idle(4))})`);
  equal("the handoff is gone", await js(`window.__count('[data-test="pair-handoff"]')`), 0);
  equal("with it the QR", await js(`window.__count('[data-test="pair-qr"]')`), 0);

  // --- Simplified Chinese ---------------------------------------------------
  at("zh");
  await js(`window.__pairHarness.setLang("zh")`);
  await js(`window.__push(${JSON.stringify(live("483920", 5))})`);
  const zhHint = await js(`window.__text('[data-test="pair-scan-hint"]')`);
  check("the scan hint is translated", /[一-鿿]/.test(zhHint ?? ""), zhHint);
  const zhNote = await js(`window.__text('[data-test="pair-link-note"]')`);
  check("the fragment note is translated", /[一-鿿]/.test(zhNote ?? "") && (zhNote ?? "").includes("#"), zhNote);
  equal("the link itself is not translated", await js(`window.__text('[data-test="pair-link"]')`), `${ORIGIN}/cross-network#c=483920`);
  await shoot(page, "03-zh-live");

  // --- responsive -----------------------------------------------------------
  at("responsive");
  window_.setContentSize(680, 900);
  await js(`window.__tick()`);
  await js(`window.__tick()`);
  check(
    "narrow: nothing overflows horizontally",
    await js(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
    `${await js(`document.documentElement.scrollWidth`)} vs ${await js(`document.documentElement.clientWidth`)}`,
  );
  equal("narrow: the QR is still there", await js(`window.__count('[data-test="pair-qr"]')`), 1);
  await shoot(page, "04-zh-narrow-680");
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
    process.stdout.write(`RELAYIUM_PAIR_UI ${JSON.stringify({ failures, checks })}\n`);
    app.exit(failures.length === 0 ? 0 : 1);
  });
