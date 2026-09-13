// The menu a shipped build offers, and the two ways it could be wrong.
//
// Before this existed the app called nothing, so Electron installed its own
// default: a menu bar whose View submenu offered Reload, Force Reload and
// Toggle Developer Tools to every user of a product that claims it cannot read
// their files. The obvious fix — remove the menu — is the second way to be
// wrong: on Windows the Edit roles are what bind Ctrl+C, Ctrl+V, Ctrl+X,
// Ctrl+A and Ctrl+Z, so a build with no menu is a build a person cannot paste a
// link into. Both failures are asserted here, because a fix for one is a
// plausible way to cause the other.

import { describe, expect, it } from "vitest";
import { DEVELOPER_ROLES, applicationMenuTemplate, type MenuItemTemplate } from "../../src/main/app-menu.js";
import { EN, ZH_HANS, translator } from "../../src/main/l10n.js";

const flatten = (items: readonly MenuItemTemplate[]): MenuItemTemplate[] =>
  items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

const rolesIn = (items: readonly MenuItemTemplate[]): string[] =>
  flatten(items)
    .map((item) => item.role)
    .filter((role): role is string => role !== undefined);

const en = translator("en");

describe("what a shipped build offers", () => {
  const shipped = applicationMenuTemplate(en, false);

  // The defect this file was written for.
  it("offers no way to reload the app or open its developer tools", () => {
    for (const role of DEVELOPER_ROLES) {
      expect(rolesIn(shipped), role).not.toContain(role);
    }
    // Named as well as listed: a role added under another spelling would pass
    // the loop above while putting the same thing on screen.
    expect(rolesIn(shipped).join(",")).not.toMatch(/reload|devtools|inspect/i);
  });

  // The regression a one-line "fix" would have caused.
  it("still binds every text-editing accelerator", () => {
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(rolesIn(shipped), role).toContain(role);
    }
  });

  it("keeps the window and display items a desktop app is expected to have", () => {
    for (const role of ["quit", "minimize", "close", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) {
      expect(rolesIn(shipped), role).toContain(role);
    }
  });

  it("labels every item it shows, in both maintained languages", () => {
    for (const locale of ["en", "zh"] as const) {
      const t = translator(locale === "en" ? "en" : "zh-Hans");
      for (const item of flatten(applicationMenuTemplate(t, true))) {
        if (item.type === "separator") continue;
        expect(item.label, `${locale} ${item.role ?? "submenu"}`).toBeTruthy();
        expect(item.label!.trim().length, `${locale} ${item.role ?? "submenu"}`).toBeGreaterThan(0);
        // A missing catalog entry resolves to undefined and would render as
        // "undefined" rather than failing, which is the worst of both.
        expect(item.label, `${locale} ${item.role ?? "submenu"}`).not.toBe("undefined");
      }
    }
  });

  // Access keys are how a menu bar is used without a mouse on Windows. A top
  // level without one is a menu a keyboard user cannot open.
  it("gives every top-level menu a Windows access key", () => {
    for (const item of applicationMenuTemplate(en, true)) {
      expect(item.label, item.label).toMatch(/&/);
    }
  });
});

describe("what an engineering build adds", () => {
  it("adds the developer items, and ONLY those", () => {
    const shipped = applicationMenuTemplate(en, false);
    const engineering = applicationMenuTemplate(en, true);
    for (const role of DEVELOPER_ROLES) {
      expect(rolesIn(engineering), role).toContain(role);
    }
    // Everything a user sees is identical, so what a developer tests is what a
    // user gets. The added submenu is the whole difference.
    const shippedRoles = rolesIn(shipped);
    const added = rolesIn(engineering).filter((role) => !shippedRoles.includes(role));
    expect([...added].sort()).toEqual([...DEVELOPER_ROLES].sort());
    expect(engineering.length).toBe(shipped.length + 1);
  });
});

describe("the catalog behind it", () => {
  it("carries every menu key in both languages", () => {
    const keys = Object.keys(EN).filter((key) => key.startsWith("menu."));
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const key of keys) {
      expect(ZH_HANS[key as keyof typeof ZH_HANS], key).toBeTruthy();
      // Untranslated copy is easy to ship and hard to see. Labels that are
      // deliberately the same in both languages would show up here as a
      // deliberate exception; today there are none.
      expect(ZH_HANS[key as keyof typeof ZH_HANS], key).not.toBe(EN[key as keyof typeof EN]);
    }
  });
});
