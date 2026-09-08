import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AppsPage from "./AppsPage.svelte";
import { messages, setLang } from "./i18n.svelte";
import { currentRoute, syncRouteFromLocation } from "./router.svelte";
import type { Platform } from "./platform";

type MacRelease = { available: boolean; downloadUrl: string | null };
type AndroidRelease = {
  available: boolean;
  versionName?: string;
  versionCode?: number;
  downloadUrl?: string;
};

/** A published Android release, used as the DEFAULT here so the macOS
 *  transitions below stay about macOS: with Android also unavailable, every
 *  "what is in the future group" assertion would be measuring two cards at
 *  once. The unavailable Android state has its own tests. */
const ANDROID_PUBLISHED: AndroidRelease = {
  available: true,
  versionName: "0.1.1",
  versionCode: 2,
  downloadUrl:
    "https://github.com/relayium/relayium/releases/download/android-v0.1.1/Relayium-0.1.1-2.apk",
};

let target: HTMLDivElement;
let app: unknown;

async function mountPage({
  macRelease = { available: false, downloadUrl: null },
  androidRel = ANDROID_PUBLISHED,
  platformOverride = "unknown",
}: {
  macRelease?: MacRelease;
  androidRel?: AndroidRelease;
  platformOverride?: Platform;
} = {}) {
  await setLang("en");
  history.pushState({}, "", "/apps");
  syncRouteFromLocation();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(AppsPage, { target, props: { macRelease, androidRel, platformOverride } });
  flushSync();
}

function idsIn(groupId: string): string[] {
  return [...target.querySelectorAll<HTMLElement>(`#${groupId} + .grid > article`)]
    .map((card) => card.id);
}

afterEach(() => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  history.pushState({}, "", "/");
  syncRouteFromLocation();
});

describe("AppsPage executable hierarchy", () => {
  // The page carries three cards: web, CLI and macOS. It carried six until
  // 2026-08-28, when the iOS, Android and Windows cards were removed — `apps/`
  // has no Android or Windows target at all and iOS development is paused with
  // no public listing, so half the grid advertised products a reader could not
  // get. The in-development GROUP survives with nothing in it, because the
  // unreleased-macOS manifest state still routes through it.
  it("groups the current Web/CLI actions ahead of an unreleased macOS card", async () => {
    await mountPage({ platformOverride: "mac" });
    const m = messages.en.appsPage;

    expect(target.querySelector("header.ui-page-head h1")?.textContent).toBe(m.heading);
    expect(target.querySelector("#available-apps-heading")?.textContent).toBe(m.availableBadge);
    expect(target.querySelector("#future-apps-heading")?.textContent).toBe(m.inDevelopmentBadge);
    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli", "app-android"]);
    expect(idsIn("future-apps-heading")).toEqual(["app-mac"]);

    const cards = target.querySelectorAll("article.app-card");
    expect(cards.length).toBe(4);
    for (const card of cards) {
      expect(card.classList.contains("ui-card")).toBe(true);
      expect(card.classList.contains("ui-stack")).toBe(true);
    }
    expect(target.querySelectorAll(".available-grid a.btn.btn-primary").length).toBe(3);
    expect(target.querySelectorAll(".future-grid a, .future-grid button").length).toBe(0);
    expect(target.querySelectorAll("button[disabled]").length).toBe(0);
    // Four platform cards plus the two decision columns below them.
    expect(target.querySelectorAll("article h3").length).toBe(6);

    // UA matching stays truthful but neutral: it marks the actual macOS card,
    // associates the localized note, and cannot manufacture an action.
    const mac = target.querySelector("#app-mac")!;
    expect(mac.classList.contains("is-platform")).toBe(true);
    expect(mac.getAttribute("aria-describedby")).toBe("platform-note");
    expect(mac.querySelector("a, button")).toBeNull();
  });

  it("moves a complete macOS release into Available with its exact manifest URL", async () => {
    const url = "https://relayium.test/apps/macos/Relayium.dmg";
    await mountPage({ macRelease: { available: true, downloadUrl: url }, platformOverride: "mac" });

    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli", "app-mac", "app-android"]);
    const link = target.querySelector<HTMLAnchorElement>("#app-mac a.btn.btn-primary")!;
    expect(link.href).toBe(url);
    expect(link.textContent?.trim()).toBe(messages.en.appsPage.cards.mac.cta);
    expect(target.querySelector("#app-mac")?.classList.contains("is-platform")).toBe(true);
    // Nothing is left in development, so the group is not drawn at all rather
    // than rendered as an empty heading over an empty grid.
    expect(target.querySelector("#future-apps-heading")).toBeNull();
    expect(target.querySelector(".future-grid")).toBeNull();
  });

  it("fails a half-filled macOS manifest closed", async () => {
    await mountPage({ macRelease: { available: true, downloadUrl: null }, platformOverride: "mac" });

    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli", "app-android"]);
    expect(idsIn("future-apps-heading")).toEqual(["app-mac"]);
    expect(target.querySelector("#app-mac a, #app-mac button")).toBeNull();
  });

  it("keeps an unavailable native card free of actions and distribution promises", async () => {
    // The macOS card in its pre-release state: the one card that can exist with
    // nothing to hand the reader.
    await mountPage({ platformOverride: "mac" });

    const card = target.querySelector("#app-mac")!;
    expect(card.querySelector("a, button"), "the card offers an action it cannot honour").toBeNull();
    expect(card.querySelector(".future-status")?.textContent).toBe(messages.en.appsPage.inDevelopmentBadge);
    // Rendered text, not the message table: a card with no download must not
    // read as one, and must not stand in for the store listing either.
    expect(card.textContent ?? "", "the card promises store distribution").not.toMatch(/app\s*store/i);
    expect(card.textContent ?? "", "the card promises a download").not.toMatch(/\bdownloads?\b/i);
  });

  it("renders no card for a platform this repository does not ship", async () => {
    await mountPage({ platformOverride: "ios" });
    for (const id of ["#app-ios", "#app-windows"]) {
      expect(target.querySelector(id), `${id} is back on the page`).toBeNull();
    }
    // …and the iOS visitor is still pointed somewhere real.
    const web = target.querySelector("#app-web")!;
    expect(web.classList.contains("is-platform")).toBe(true);
    expect(web.getAttribute("aria-describedby")).toBe("platform-note");
    expect(web.querySelector("a.btn")).toBeTruthy();
  });

  // ── the Android download's reachability ──────────────────────────────────
  //
  // Measured on a real render before this was fixed: at 320px with an Android
  // user agent the Android card began 1293px down and its download button
  // 1928px, behind three cards about other machines. A highlight the reader has
  // to scroll past three cards to reach is not doing anything.
  it("puts the Android card first for an Android visitor", async () => {
    await mountPage({ platformOverride: "android" });
    expect(idsIn("available-apps-heading")[0]).toBe("app-android");
    // Highlighted, and carrying a real action rather than a marker.
    const card = target.querySelector("#app-android")!;
    expect(card.classList.contains("is-platform")).toBe(true);
    expect(card.querySelector("a.btn.btn-primary")).toBeTruthy();
  });

  it("leaves every other platform's order alone", async () => {
    // Scoped deliberately: this is not a recommendation engine, and reordering
    // for everyone would change what the grid means for readers it was already
    // serving correctly.
    for (const platform of ["mac", "linux", "windows", "ios", "unknown"] as const) {
      await mountPage({ platformOverride: platform });
      expect(idsIn("available-apps-heading")[0], platform).toBe("app-web");
      // Tear down between iterations. `afterEach` only unmounts the LAST mount,
      // so a loop that remounts without this leaves live components subscribed
      // to the shared language and route state — which then throws inside the
      // NEXT test's mount and leaves its target empty, failing a test that has
      // nothing to do with this one.
      unmount(app as never);
      app = undefined;
      target.remove();
    }
  });

  it("keeps the browser first for an Android visitor with nothing to download", async () => {
    // With no published APK the Android card is not in the available group at
    // all, and the honest answer for that reader is still the web app.
    await mountPage({ platformOverride: "android", androidRel: { available: false } });
    expect(idsIn("available-apps-heading")[0]).toBe("app-web");
    expect(target.querySelector("#app-web")?.classList.contains("is-platform")).toBe(true);
    expect(target.querySelector("#app-android a, #app-android button")).toBeNull();
  });

  it("reaches the Android action before its limitations, and keeps them in the card", async () => {
    await mountPage({ platformOverride: "android" });
    const card = target.querySelector("#app-android")!;
    const nodes = [...card.children];
    const ctaAt = nodes.findIndex((n) => n.matches("a.btn"));
    const limitsAt = nodes.findIndex((n) => n.matches("ul.limits"));
    const reqAt = nodes.findIndex((n) => n.matches("p.req"));
    expect(ctaAt, "the card has no action").toBeGreaterThan(-1);
    expect(limitsAt, "the limitations left the card").toBeGreaterThan(-1);
    // Requirements before the button, limitations after it — the reader knows
    // what it needs before acting, and the boundaries are still right there.
    expect(reqAt).toBeLessThan(ctaAt);
    expect(ctaAt).toBeLessThan(limitsAt);
    // All four limits survive the move; this is the honesty half of the card.
    expect(card.querySelectorAll("ul.limits li").length).toBe(
      messages.en.appsPage.cards.android.limitations.length,
    );
    expect(card.textContent ?? "").toMatch(/Google Play/);
  });

  it("makes the long install command a named, keyboard-scrollable LTR region", async () => {
    await mountPage({ platformOverride: "linux" });

    const command = target.querySelector<HTMLElement>('[role="region"].cmd')!;
    expect(command.getAttribute("dir")).toBe("ltr");
    expect(command.tabIndex).toBe(0);
    expect(command.getAttribute("aria-labelledby")).toBe("cli-install-label");
    expect(target.querySelector("#cli-install-label")?.textContent).toBe(messages.en.appsPage.cliInstallLabel);
    expect(command.textContent).toBe("curl -fsSL https://relayium.com/install.sh | sh");
  });

  it("keeps Web and CLI as real route-preserving links", async () => {
    await mountPage();
    const web = target.querySelector<HTMLAnchorElement>("#app-web a")!;
    const cli = target.querySelector<HTMLAnchorElement>("#app-cli a")!;
    expect(new URL(web.href).pathname).toBe("/");
    expect(new URL(cli.href).pathname).toBe("/cli");

    cli.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    flushSync();
    expect(currentRoute()).toBe("cli");
  });
});
