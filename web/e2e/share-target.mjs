#!/usr/bin/env node
/**
 * End to end: a real multipart Web Share Target launch reaches the installed
 * production service worker, is parked in Cache Storage, drained into the live
 * outbox, and is inspectable before the sender chooses a device.
 *
 * The only synthetic part is the OS picker itself: a controlled page submits
 * the exact multipart form Chrome would launch from Android. Everything after
 * that boundary is the shipped service worker and app.
 */
import {
  argFlag, argPresent, fail, launchBrowser, newTab, ok, requireServer,
  setWideViewport, withWatchdog,
} from "./harness.mjs";

const BASE = argFlag("--url", "http://localhost:8099");
const DEBUG_PORT = 9446;
const GLOBAL_TIMEOUT_MS = 90_000;

async function shareTargetScenario(browser) {
  const tab = await newTab(browser, `${BASE}/`);
  await setWideViewport(tab);
  await tab.waitFor(
    "navigator.serviceWorker.controller !== null",
    "the production service worker to control the app",
  );

  await tab.evaluate(`(() => {
    const form = document.createElement("form");
    form.method = "POST";
    form.enctype = "multipart/form-data";
    form.action = "/share-target";

    const input = document.createElement("input");
    input.type = "file";
    input.name = "files";
    input.multiple = true;
    const transfer = new DataTransfer();
    transfer.items.add(new File([], "empty.txt", { type: "text/plain" }));
    transfer.items.add(new File([new Uint8Array(2048)], "报告 مرحبا.pdf", { type: "application/pdf" }));
    input.files = transfer.files;
    form.append(input);
    document.body.append(form);
    form.submit();
    return true;
  })()`);

  await tab.waitFor(
    "document.querySelectorAll('.pending-files .file-name').length === 2",
    "both shared files to appear before device selection",
  );

  const shown = await tab.evaluate(`(async () => ({
    url: location.href,
    summary: document.querySelector('.pending-files .summary')?.textContent?.trim(),
    names: [...document.querySelectorAll('.pending-files .file-name')].map((node) => node.textContent),
    sizes: [...document.querySelectorAll('.pending-files .file-size')].map((node) => node.textContent),
    peers: document.querySelectorAll('.peer').length,
    chooser: !!document.querySelector('.peers'),
    scrollable: document.querySelector('.pending-files .file-scroll')?.tabIndex,
    parked: (await (await caches.open('relayium-share')).keys())
      .filter((request) => request.url.includes('/__shared__/')).length,
  }))()`);

  if (
    shown.names?.join("|") !== "empty.txt|报告 مرحبا.pdf" ||
    shown.sizes?.join("|") !== "0 B|2.0 KB" ||
    !shown.summary?.includes("2") || !shown.summary?.includes("2.0 KB") ||
    shown.peers !== 0 || !shown.chooser || shown.scrollable !== 0 ||
    shown.parked !== 0 || shown.url.includes("share-target=")
  ) {
    throw new Error(`share-target pending-file contract failed: ${JSON.stringify(shown)}`);
  }
  if (tab.errors.length) throw new Error(`share-target page logged errors: ${tab.errors.join(" | ")}`);

  ok("multipart share target showed every local name and size before device choice");
  ok("the one-shot share token and parked cache entries were drained");
  await browser.send("Target.closeTarget", { targetId: tab.targetId });
}

async function main() {
  await requireServer(
    BASE,
    "start it with: cd web && npm run build, then " +
    "cd server && RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=:8099 go run .",
  );
  const session = await launchBrowser({ debugPort: DEBUG_PORT, keep: argPresent("--keep") });
  try {
    console.log(`\nShare Target E2E against ${BASE}`);
    await shareTargetScenario(session.browser);
    console.log("\n\x1b[32mShare Target E2E passed\x1b[0m\n");
  } catch (error) {
    fail("Share Target E2E", error);
  } finally {
    await session.close();
  }
}

await withWatchdog("Share Target E2E", GLOBAL_TIMEOUT_MS, main);
