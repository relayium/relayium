import { describe, expect, it, vi } from "vitest";
import { trayMenuTemplate, trayTooltip } from "../../src/main/tray.js";
import { translator } from "../../src/main/l10n.js";

const actions = (nearbyActive = true) => ({
  show: vi.fn(),
  openNearby: vi.fn(),
  openInbox: vi.fn(),
  setNearby: vi.fn(),
  nearbyActive: () => nearbyActive,
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
      "Pause Nearby",
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
    expect("label" in paused[4]! && paused[4].label).toBe("Resume Nearby");
    const a = actions(false);
    const entry = trayMenuTemplate(translator("en"), a)[4]!;
    if ("click" in entry) entry.click();
    expect(a.setNearby).toHaveBeenCalledWith(true);
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
    expect(a.quit).not.toHaveBeenCalled();
    click(6);
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
