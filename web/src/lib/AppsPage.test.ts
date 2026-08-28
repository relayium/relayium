import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AppsPage from "./AppsPage.svelte";
import { messages, setLang } from "./i18n.svelte";
import { currentRoute, syncRouteFromLocation } from "./router.svelte";
import type { Platform } from "./platform";

type MacRelease = { available: boolean; downloadUrl: string | null };

let target: HTMLDivElement;
let app: unknown;

async function mountPage({
  macRelease = { available: false, downloadUrl: null },
  platformOverride = "unknown",
}: { macRelease?: MacRelease; platformOverride?: Platform } = {}) {
  await setLang("en");
  history.pushState({}, "", "/apps");
  syncRouteFromLocation();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(AppsPage, { target, props: { macRelease, platformOverride } });
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
    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli"]);
    expect(idsIn("future-apps-heading")).toEqual(["app-mac"]);

    const cards = target.querySelectorAll("article.app-card");
    expect(cards.length).toBe(3);
    for (const card of cards) {
      expect(card.classList.contains("ui-card")).toBe(true);
      expect(card.classList.contains("ui-stack")).toBe(true);
    }
    expect(target.querySelectorAll(".available-grid a.btn.btn-primary").length).toBe(2);
    expect(target.querySelectorAll(".future-grid a, .future-grid button").length).toBe(0);
    expect(target.querySelectorAll("button[disabled]").length).toBe(0);
    // Three platform cards plus the two decision columns below them.
    expect(target.querySelectorAll("article h3").length).toBe(5);

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

    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli", "app-mac"]);
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

    expect(idsIn("available-apps-heading")).toEqual(["app-web", "app-cli"]);
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
    for (const id of ["#app-ios", "#app-android", "#app-windows"]) {
      expect(target.querySelector(id), `${id} is back on the page`).toBeNull();
    }
    // …and the iOS visitor is still pointed somewhere real.
    const web = target.querySelector("#app-web")!;
    expect(web.classList.contains("is-platform")).toBe(true);
    expect(web.getAttribute("aria-describedby")).toBe("platform-note");
    expect(web.querySelector("a.btn")).toBeTruthy();
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
