import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import OfflinePage from "./OfflinePage.svelte";
import { setLang } from "./i18n.svelte";
import {
  currentRoute, setNavGuard, syncRouteFromLocation, CROSS_PATH, OFFLINE_PATH,
} from "./router.svelte";

// The comparison table has one copy, on the cross-network page, and this page
// links to it as `/cross-network#compare`. CrossPage reads that hash as it
// mounts, so what is pinned here is the URL the click ends on — under every
// answer the navigation guard can give.

let target: HTMLDivElement;
let app: unknown;

function url(): string {
  return location.pathname + location.search + location.hash;
}

function clickCompare(): MouseEvent {
  const link = target.querySelector<HTMLAnchorElement>(".compare-link a")!;
  expect(link, "the compare link must be rendered").toBeTruthy();
  expect(link.getAttribute("href")).toBe("/cross-network#compare");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  return click;
}

beforeEach(async () => {
  await setLang("en");
  history.replaceState({}, "", OFFLINE_PATH);
  syncRouteFromLocation();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(OfflinePage, { target });
  flushSync();
});

afterEach(() => {
  setNavGuard(null);
  if (app) {
    unmount(app as never);
    app = undefined;
  }
  target?.remove();
  history.replaceState({}, "", "/");
  syncRouteFromLocation();
});

describe("OfflinePage compare link", () => {
  it("lands on the comparison table when nothing guards the navigation", () => {
    const click = clickCompare();
    expect(click.defaultPrevented).toBe(true); // in-app navigation, not a page load
    expect(currentRoute()).toBe("cross");
    expect(url()).toBe(`${CROSS_PATH}#compare`);
  });

  it("still lands on the comparison table when the guard asks first and the user confirms", async () => {
    // A transfer in flight turns the guard's answer into a dialog, i.e. a
    // promise. The route has not moved by the time the click handler returns,
    // so a hash added by the handler itself would be too early to be right and
    // is therefore never added — and the reader arrives at the top of the page.
    let answer: (ok: boolean) => void = () => {};
    setNavGuard(() => new Promise<boolean>((r) => { answer = r; }));
    clickCompare();
    expect(currentRoute()).toBe("offline");
    expect(url()).toBe(OFFLINE_PATH); // no `#compare` on THIS page's entry while the question is open
    answer(true);
    await vi.waitFor(() => expect(currentRoute()).toBe("cross"));
    expect(url()).toBe(`${CROSS_PATH}#compare`);
  });

  it("leaves this page's entry clean when the user declines", async () => {
    const replace = vi.spyOn(history, "replaceState");
    const push = vi.spyOn(history, "pushState");
    setNavGuard(() => Promise.resolve(false));
    clickCompare();
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoute()).toBe("offline");
    expect(url()).toBe(OFFLINE_PATH);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    push.mockRestore();
    replace.mockRestore();
  });

  it("leaves this page's entry clean when the guard refuses outright", () => {
    setNavGuard(() => false);
    clickCompare();
    expect(currentRoute()).toBe("offline");
    expect(url()).toBe(OFFLINE_PATH);
  });
});
