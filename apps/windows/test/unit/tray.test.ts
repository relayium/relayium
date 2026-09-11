import { describe, expect, it, vi } from "vitest";
import { trayMenuTemplate, trayTooltip } from "../../src/main/tray.js";
import { translator } from "../../src/main/l10n.js";

const actions = (nearbyActive = true, inboxPaused = false) => ({
  show: vi.fn(),
  openNearby: vi.fn(),
  openInbox: vi.fn(),
  openUpdates: vi.fn(),
  setNearby: vi.fn(),
  nearbyActive: () => nearbyActive,
  setInboxPaused: vi.fn(),
  inboxPaused: () => inboxPaused,
  quit: vi.fn(),
});

describe("the tray menu", () => {
  it("opens the app, its two live surfaces, and Nearby's toggle", () => {
    const items = trayMenuTemplate(translator("en"), actions());
    expect(items.map((e) => ("label" in e ? e.label : "—"))).toEqual([
      "Open Relayium",
      "—",
      "Nearby devices",
      "Device Inbox",
      "Updates",
      "Pause Nearby",
      "Pause Device Inbox",
      "—",
      "Quit Relayium",
    ]);
  });

  it("separates Quit from everything else so a mis-click cannot end the process", () => {
    const items = trayMenuTemplate(translator("en"), actions());
    expect("type" in items[items.length - 2]!).toBe(true);
    expect("type" in items[1]!).toBe(true);
  });

  it("says what the Nearby item will DO, not what is true now", () => {
    const paused = trayMenuTemplate(translator("en"), actions(false));
    expect("label" in paused[5]! && paused[5].label).toBe("Resume Nearby");
    const a = actions(false);
    const entry = trayMenuTemplate(translator("en"), a)[5]!;
    if ("click" in entry) entry.click();
    expect(a.setNearby).toHaveBeenCalledWith(true);
  });

  it("says what the Inbox item will DO, and offers it while the window is shut", () => {
    // The Device Inbox receives with the window hidden, which is the state a
    // tray exists for: without this the only way to stop it is to open the
    // window, and macOS has offered it from the menu bar all along.
    const running = trayMenuTemplate(translator("en"), actions(true, false));
    expect("label" in running[6]! && running[6].label).toBe("Pause Device Inbox");
    const stopped = trayMenuTemplate(translator("en"), actions(true, true));
    expect("label" in stopped[6]! && stopped[6].label).toBe("Resume Device Inbox");
  });

  it("asks for the state it does not already have", () => {
    const a = actions(true, false);
    const entry = trayMenuTemplate(translator("en"), a)[6]!;
    if ("click" in entry) entry.click();
    expect(a.setInboxPaused).toHaveBeenCalledWith(true);
    // Pausing is NOT disabling: the page's enable/disable writes the policy and
    // tells central, and a menu must not be able to un-enrol a device.
    expect(a.openInbox).not.toHaveBeenCalled();
  });

  it("is localized, not hard-coded", () => {
    const en = trayMenuTemplate(translator("en"), actions());
    const zh = trayMenuTemplate(translator("zh-Hans"), actions());
    const label = (e: (typeof en)[number]) => ("label" in e ? e.label : "");
    expect(label(en[0]!)).not.toBe(label(zh[0]!));
    expect(label(zh[0]!)).toBe("打开 Relayium");
    expect(trayTooltip(translator("zh-Hans"))).toBe("Relayium");
  });

  it("wires each item to its own action", () => {
    const a = actions();
    const items = trayMenuTemplate(translator("en"), a);
    const click = (i: number) => {
      const entry = items[i]!;
      if ("click" in entry) entry.click();
    };
    click(0);
    expect(a.show).toHaveBeenCalledOnce();
    expect(a.quit).not.toHaveBeenCalled();
    click(2);
    expect(a.openNearby).toHaveBeenCalledOnce();
    click(3);
    expect(a.openInbox).toHaveBeenCalledOnce();
    click(4);
    // Opens the page and acts on NOTHING: a menu item cannot show what it
    // would do, so nothing about an update may happen from one.
    expect(a.openUpdates).toHaveBeenCalledOnce();
    expect(a.quit).not.toHaveBeenCalled();
    click(8);
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
