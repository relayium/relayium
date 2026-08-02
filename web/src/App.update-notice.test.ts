import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import App from "./App.svelte";
import { loadLang, setLang, messages } from "./lib/i18n.svelte";
import { markAppUpdatePending, markAppUpdateReloadReady, resetAppUpdate } from "./lib/app-update.svelte";
import { setOutbox, clearOutbox } from "./lib/outbox.svelte";
import { syncRouteFromLocation, currentRoute } from "./lib/router.svelte";

// App is mounted for real here, which is the only way to check that the update
// notice is genuinely global: it has to survive the route branches inside
// <main>, including the deep-link download route that renders before <Nav>.
//
// jsdom leaves window.isSecureContext undefined, so App takes its "unsupported
// browser" path and never opens a socket or fetches ICE — exactly the inert
// mount this test wants.

let target: HTMLDivElement;
let app: unknown;

async function mountApp(path = "/") {
  history.replaceState(null, "", path);
  syncRouteFromLocation();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(App, { target });
  flushSync();
  await Promise.resolve(); // let the lazily-imported route settle
  flushSync();
}

const bar = () => target.querySelector(".update-bar") as HTMLElement | null;
const refresh = () => bar()?.querySelector("button") as HTMLButtonElement | undefined;

/** The state a real page reaches when a new build has installed and taken
 *  control — the only one in which the refresh action is offered. */
function updateLanded() {
  markAppUpdatePending();
  markAppUpdateReloadReady();
  flushSync();
}

beforeEach(async () => {
  await loadLang("en");
  await setLang("en");
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target?.remove();
  resetAppUpdate();
  clearOutbox();
  history.replaceState(null, "", "/");
  syncRouteFromLocation();
});

describe("App update notice", () => {
  it("shows nothing until an update is announced", async () => {
    await mountApp();
    expect(bar()).toBeNull();
  });

  it("appears on the transfer route, outside every route branch", async () => {
    await mountApp();

    updateLanded();

    expect(bar()).toBeTruthy();
    expect(bar()!.textContent).toContain(messages.en.appUpdate.ready);
    // Route-independent by construction: it is not inside <main>, where every
    // route branch lives, so no route can render it away.
    expect(target.querySelector("main .update-bar")).toBeNull();
  });

  // Installed but not in control (a streaming download is holding activation
  // back): the bar is there so the user knows, the action is not.
  it("shows a pending update globally without offering a refresh", async () => {
    await mountApp();

    markAppUpdatePending();
    flushSync();

    expect(bar()!.textContent).toContain(messages.en.appUpdate.ready);
    expect(bar()!.textContent).toContain(messages.en.appUpdate.busy);
    expect(refresh()!.disabled).toBe(true);
  });

  it("appears on the download route too, which renders before the nav", async () => {
    await mountApp("/d/abc123");
    expect(currentRoute()).toBe("download");

    updateLanded();

    expect(bar()).toBeTruthy();
  });

  it("refuses to offer a refresh while files are queued for a peer", async () => {
    await mountApp();
    updateLanded();
    expect(refresh()!.disabled).toBe(false);

    setOutbox([{ file: new File(["x"], "queued.txt") }]);
    flushSync();

    expect(refresh()!.disabled).toBe(true);
    expect(bar()!.textContent).toContain(messages.en.appUpdate.busy);

    clearOutbox();
    flushSync();
    expect(refresh()!.disabled).toBe(false);
  });
});
