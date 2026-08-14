import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import UpdateNotice from "./UpdateNotice.svelte";
import { loadLang, messages, setLang } from "./i18n.svelte";
import {
  markAppUpdatePending,
  markAppUpdateReloadReady,
  holdRefresh,
  resetAppUpdate,
  setReloadForTest,
} from "./app-update.svelte";
import { setOutbox, clearOutbox } from "./outbox.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  await setLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  resetAppUpdate();
  clearOutbox();
});

function show(props: Record<string, unknown> = {}) {
  app = mount(UpdateNotice, { target, props: { busy: false, ...props } });
  flushSync();
}
const bar = () => target.querySelector(".update-bar") as HTMLElement | null;
const button = () => target.querySelector(".update-bar button") as HTMLButtonElement | null;
const live = () => target.querySelector('[role="status"]') as HTMLElement;
const t = () => messages.en;

/** The state a real page reaches when a new build has installed and taken
 *  control: the only state in which Refresh does anything. */
function updateLanded() {
  markAppUpdatePending();
  markAppUpdateReloadReady();
  flushSync();
}

describe("UpdateNotice", () => {
  it("renders nothing but an empty live region until an update is announced", () => {
    show();
    expect(bar()).toBeNull();
    // The region itself is mounted up front: a live region and its first message
    // appearing in the same update is not announced reliably.
    expect(live()).toBeTruthy();
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().textContent?.trim()).toBe("");
  });

  it("appears when an update is announced, and offers an explicit refresh", () => {
    show();
    updateLanded();

    expect(bar()).toBeTruthy();
    expect(bar()!.textContent).toContain(t().appUpdate.ready);
    expect(button()!.textContent!.trim()).toBe(t().appUpdate.refresh);
    expect(button()!.disabled).toBe(false);
  });

  // The banner is a sibling of the live region, not a child of it: a live region
  // is for announcing text, and burying the only interactive control inside one
  // gets it read out where it cannot be acted on.
  it("keeps the interactive banner out of the live region, which carries fixed text only", () => {
    show();
    updateLanded();

    expect(live().contains(bar())).toBe(false);
    expect(live().querySelector("button")).toBeNull();
    expect(live().textContent!.trim()).toBe(t().appUpdate.ready);
  });

  // The one state Blocker 1 is about: the new build has installed but has not
  // taken control (a streaming download is holding it back). Telling the user
  // is right; offering them a refresh is not — it would kill the download and
  // reload onto the very same build.
  it("shows the notice but withholds the refresh while the update is only pending", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show();
    markAppUpdatePending();
    flushSync();

    expect(bar()).toBeTruthy();
    expect(bar()!.textContent).toContain(t().appUpdate.ready);
    expect(bar()!.textContent).toContain(t().appUpdate.busy);
    expect(button()!.disabled).toBe(true);
    button()!.click();
    expect(reload).not.toHaveBeenCalled();
  });

  it("enables the refresh reactively when the new worker takes control", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show();
    markAppUpdatePending();
    flushSync();
    expect(button()!.disabled).toBe(true);

    markAppUpdateReloadReady();
    flushSync();

    expect(button()!.disabled).toBe(false);
    expect(bar()!.textContent).not.toContain(t().appUpdate.busy);
    button()!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // A long-lived tab can see two deploys. Once a further build is waiting, the
  // action has to go away again: it is typically held back by a download a
  // reload would kill, and the reload would land on the older build anyway.
  it("takes the refresh away again when a further build installs behind the live one", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show();
    updateLanded();
    expect(button()!.disabled).toBe(false);

    markAppUpdatePending(); // a further build installs and is held in waiting
    flushSync();

    expect(bar()).toBeTruthy();
    expect(bar()!.textContent).toContain(t().appUpdate.busy);
    expect(button()!.disabled).toBe(true);
    button()!.click();
    expect(reload).not.toHaveBeenCalled();

    markAppUpdateReloadReady(); // …and then it takes control
    flushSync();
    expect(button()!.disabled).toBe(false);
    button()!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // A stored download or upload runs with no peer at all, so warnsOnLeave and
  // the outbox are both empty — exactly the state the notice would otherwise
  // read as "safe to refresh". The guard is what closes that.
  it("disables refresh while a local operation holds the guard, and re-enables it reactively", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show({ busy: false });
    updateLanded();
    expect(button()!.disabled).toBe(false);

    const release = holdRefresh();
    flushSync();

    expect(button()!.disabled).toBe(true);
    expect(bar()!.textContent).toContain(t().appUpdate.busy);
    button()!.click();
    expect(reload).not.toHaveBeenCalled();

    release(); // download finished / upload done or cancelled
    flushSync();

    expect(button()!.disabled).toBe(false);
    expect(bar()!.textContent).not.toContain(t().appUpdate.busy);
    button()!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stays disabled until the LAST overlapping operation lets go", () => {
    show({ busy: false });
    updateLanded();
    const a = holdRefresh();
    const b = holdRefresh();
    flushSync();
    expect(button()!.disabled).toBe(true);

    a();
    flushSync();
    expect(button()!.disabled).toBe(true);

    b();
    flushSync();
    expect(button()!.disabled).toBe(false);
  });

  it("carries no dismiss control — staleness must not be one click away", () => {
    show();
    updateLanded();
    expect(target.querySelectorAll("button")).toHaveLength(1);
  });

  it("does not reload by itself when the update lands", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show();
    updateLanded();
    expect(reload).not.toHaveBeenCalled();
  });

  it("disables refresh while the workspace warns on leave, and says what to finish first", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show({ busy: true });
    updateLanded();

    expect(bar()!.textContent).toContain(t().appUpdate.busy);
    expect(button()!.disabled).toBe(true);
    button()!.click(); // a disabled button cannot activate, belt and braces
    expect(reload).not.toHaveBeenCalled();
  });

  // Queued files are not part of `busy`: they survive a peer leaving and live
  // only in memory, so a reload would drop them with nothing having said so.
  it("disables refresh while files are queued in the outbox, and re-enables it reactively once they are gone", () => {
    const reload = vi.fn();
    setReloadForTest(reload);
    show({ busy: false });
    updateLanded();
    expect(button()!.disabled).toBe(false);

    setOutbox([{ file: new File(["x"], "queued.txt") }]);
    flushSync();
    expect(button()!.disabled).toBe(true);
    expect(bar()!.textContent).toContain(t().appUpdate.busy);
    button()!.click();
    expect(reload).not.toHaveBeenCalled();

    clearOutbox(); // sent, or the pairing was abandoned
    flushSync();

    expect(button()!.disabled).toBe(false);
    expect(bar()!.textContent).not.toContain(t().appUpdate.busy);
    button()!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("announces only its own fixed headline — no file names, peers or codes can reach the live region", () => {
    show({ busy: true });
    updateLanded();
    setOutbox([{ file: new File(["x"], "secret-name.txt") }]);
    flushSync();

    const text = live().textContent!.replace(/\s+/g, " ").trim();
    expect(text).toBe(t().appUpdate.ready.replace(/\s+/g, " ").trim());
  });

  it("follows the language switch", async () => {
    // This used to switch to Arabic and additionally assert the document went
    // RTL. Neither maintained language is RTL since the 2026-08-14 freeze, so
    // the direction half moved to Nav.test.ts, where the dir() contract and the
    // components' use of it are pinned without mounting an unreachable state.
    // The bar is laid out with logical properties only, so it needs no flip.
    await loadLang("zh");
    await setLang("zh");
    show();
    updateLanded();
    expect(bar()!.textContent).toContain(messages.zh.appUpdate.ready);
    expect(live().textContent!.trim()).toBe(messages.zh.appUpdate.ready);
    expect(live().textContent!.trim()).not.toBe(messages.en.appUpdate.ready);
    expect(document.documentElement.dir).toBe("ltr");
  });
});
