// The home page's "every claim here can be checked" block — the COMPONENT.
//
// FeatureStrip states the privacy claims; this block is the step after a claim:
// four things a visitor can do themselves, each with exactly one link.
//
// Whether the four SENTENCES are still true of the repository (the licence
// files, docs/protocol, the release workflow's attestation step, the README
// section the install row links to) is deliberately NOT pinned here. Those facts
// live outside `web/`, and `web.yml` starts on `web/**` alone, so a pin here
// would not run on the commit that breaks it. `scripts/test/
// home-trust-claims-test.mjs` owns them, in the workflow with no path filter.
import { beforeEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import HomeTrust from "./HomeTrust.svelte";
import { messages, setLang } from "./i18n.svelte";

beforeEach(() => {
  document.body.innerHTML = "";
});

async function render(lang: "en" | "zh") {
  await setLang(lang);
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(HomeTrust, { target });
  return { target, app };
}

describe("home trust block — component", () => {
  it("is one labelled section with four rows, each a heading, a sentence and exactly one link", async () => {
    const { target, app } = await render("en");
    const section = target.querySelector("section")!;
    const title = target.querySelector("h2")!;
    expect(section.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.textContent).toBe(messages.en.homeTrust.title);

    const rows = [...target.querySelectorAll("ul > li")];
    expect(rows).toHaveLength(4);
    for (const [i, row] of rows.entries()) {
      const item = messages.en.homeTrust.items[i]!;
      expect(row.querySelector("h3")?.textContent).toBe(item.title);
      expect(row.querySelector("p")?.textContent).toBe(item.desc);
      const links = row.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]!.textContent?.trim()).toBe(item.link);
      expect(links[0]!.getAttribute("href")).toBeTruthy();
    }
    unmount(app);
  });

  it("opens off-site links safely and keeps the on-site security page in the same tab", async () => {
    const { target, app } = await render("en");
    const links = [...target.querySelectorAll<HTMLAnchorElement>("ul > li a")];
    const external = links.filter((a) => /^https:\/\//.test(a.getAttribute("href")!));
    // Rows 1, 2 and 4 leave the site; row 3 is our own security page.
    expect(external).toHaveLength(3);
    for (const a of external) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\/github\.com\/relayium\/relayium/);
      expect(a.getAttribute("rel")).toBe("noopener");
      expect(a.getAttribute("target")).toBe("_blank");
    }
    const internal = links.filter((a) => !external.includes(a));
    expect(internal).toHaveLength(1);
    expect(internal[0]!.getAttribute("href")).toMatch(/security/);
    expect(internal[0]!.hasAttribute("target")).toBe(false);
    unmount(app);
  });

  it("renders the Simplified Chinese copy from the same structure", async () => {
    const { target, app } = await render("zh");
    expect(target.querySelector("h2")?.textContent).toBe("每一条都可以验证");
    expect(target.querySelectorAll("ul > li")).toHaveLength(4);
    unmount(app);
  });

  it("carries no audit statement and no vulnerability-report link (owner decision 2026-09-21)", async () => {
    for (const lang of ["en", "zh"] as const) {
      const { target, app } = await render(lang);
      expect(target.textContent).not.toMatch(/audit|审计/i);
      expect(target.innerHTML).not.toMatch(/advisories/);
      unmount(app);
    }
  });
});
