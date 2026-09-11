import { describe, expect, it, vi } from "vitest";
import { trayMenuTemplate, trayTooltip } from "../../src/main/tray.js";
import { translator } from "../../src/main/l10n.js";
import { inboxStatusLabel } from "../../src/main/tray.js";
import type { InboxStatus } from "../../src/shared/ipc-contract.js";
import type { TrayMenuEntry } from "../../src/main/tray.js";

const actions = (nearbyActive = true, inboxPaused = false, over = {}) => ({
  show: vi.fn(),
  openNearby: vi.fn(),
  openInbox: vi.fn(),
  openUpdates: vi.fn(),
  setNearby: vi.fn(),
  nearbyActive: () => nearbyActive,
  setInboxPaused: vi.fn(),
  inboxPaused: () => inboxPaused,
  inboxStatus: () => ({ kind: "idle", pending: 0 }) as InboxStatus,
  hasInboxFolder: () => true,
  revealInbox: vi.fn(),
  accountIdentity: () => "",
  quit: vi.fn(),
  ...over,
});

/**
 * Find an entry by its LABEL rather than its position.
 *
 * The status lines pushed every index down by four, and a test that counts
 * positions fails for that reason rather than for the one it is about. What
 * these cases assert is that a particular item does a particular thing, which
 * the label identifies and the index only approximates.
 */
const entryFor = (items: readonly TrayMenuEntry[], label: string) => {
  const found = items.find((e) => "label" in e && e.label === label);
  if (found === undefined) throw new Error(`no tray entry labelled ${label}`);
  return found;
};

describe("what the tray says the Device Inbox is doing", () => {
  const t = translator("en");
  const ALL: InboxStatus[] = [
    { kind: "unavailable", reason: "network" as never },
    { kind: "needs-account" },
    { kind: "account-unreadable" },
    { kind: "disabled" },
    { kind: "folder-missing" },
    { kind: "starting" },
    { kind: "idle", pending: 0 },
    { kind: "receiving" },
    { kind: "blocked", reason: "network" as never, residue: "none" as never, pending: 0 },
    { kind: "offline", reason: "network" as never, retryInSeconds: 5 },
  ];

  it("gives each state its own sentence", () => {
    const said = ALL.map((status) => inboxStatusLabel(t, status, false));
    // Distinct on purpose. Collapsing two states into one sentence is how a
    // person ends up waiting for a delivery that stopped for a reason nobody
    // told them about.
    expect(new Set(said).size).toBe(said.length);
    expect(said.every((line) => line.length > 0)).toBe(true);
  });

  it("says PAUSED whatever the status underneath is", () => {
    // A pause writes nothing and tells central nothing, so the status is
    // deliberately unchanged by it. Reporting that status would be true about
    // the enrolment and wrong about the machine.
    for (const status of ALL) {
      expect(inboxStatusLabel(t, status, true)).toBe("Device Inbox: paused");
    }
  });

  it("reports an unknown state as ON rather than as a fault", () => {
    // The two guesses are not equally harmful: claiming receiving stopped when
    // it has not is the one that costs somebody a transfer.
    const label = inboxStatusLabel(t, { kind: "something-later" } as never, false);
    expect(label).toBe("Device Inbox: on");
  });

  it("names the account when there is one, and says so when there is not", () => {
    const out = trayMenuTemplate(t, actions(true, false));
    expect("label" in out[0]! && out[0].label).toBe("Not signed in");
    const inn = trayMenuTemplate(t, actions(true, false, { accountIdentity: () => "someone@example.invalid" }));
    expect("label" in inn[0]! && inn[0].label).toBe("someone@example.invalid");
  });

  it("reports rather than acts: a status line has nothing to press", () => {
    const out = trayMenuTemplate(t, actions());
    for (const entry of out.slice(0, 3)) {
      expect("click" in entry).toBe(false);
      expect("enabled" in entry && entry.enabled).toBe(false);
    }
  });
});

describe("showing where deliveries land", () => {
  it("offers it when there is a folder", () => {
    const a = actions();
    const entry = entryFor(trayMenuTemplate(translator("en"), a), "Show the receive folder");
    if ("click" in entry) entry.click();
    expect(a.revealInbox).toHaveBeenCalledOnce();
  });

  it("does NOT offer it when there is none", () => {
    // A menu has nowhere to put a refusal, so the item is absent rather than
    // present and failing — the same rule the rest of the app follows for a
    // control whose reason cannot be shown beside it.
    const items = trayMenuTemplate(translator("en"), actions(true, false, { hasInboxFolder: () => false }));
    expect(items.some((e) => "label" in e && e.label === "Show the receive folder")).toBe(false);
  });

  it("leaves every other item where it was", () => {
    // Absent means absent: the menu without it is the menu that was there
    // before, not a shorter one with a hole in it.
    const without = trayMenuTemplate(translator("en"), actions(true, false, { hasInboxFolder: () => false }));
    const with_ = trayMenuTemplate(translator("en"), actions());
    expect(with_.length).toBe(without.length + 1);
    for (const label of ["Open Relayium", "Device Inbox", "Pause Nearby", "Quit Relayium"]) {
      expect(() => entryFor(without, label)).not.toThrow();
      expect(() => entryFor(with_, label)).not.toThrow();
    }
  });
});

describe("the tray menu", () => {
  it("opens the app, its two live surfaces, and Nearby's toggle", () => {
    const items = trayMenuTemplate(translator("en"), actions());
    expect(items.map((e) => ("label" in e ? e.label : "—"))).toEqual([
      "Not signed in",
      "Device Inbox: on",
      "Nearby: on",
      "—",
      "Open Relayium",
      "—",
      "Nearby devices",
      "Device Inbox",
      "Updates",
      "Show the receive folder",
      "Pause Nearby",
      "Pause Device Inbox",
      "—",
      "Quit Relayium",
    ]);
  });

  it("separates Quit from everything else so a mis-click cannot end the process", () => {
    const items = trayMenuTemplate(translator("en"), actions());
    expect("type" in items[items.length - 2]!).toBe(true);
    // The status block is separated from everything that acts, so a reader
    // scanning down cannot press the first action while aiming at the report.
    expect("type" in items[3]!).toBe(true);
    expect("type" in items[5]!).toBe(true);
  });

  it("says what the Nearby item will DO, not what is true now", () => {
    const a = actions(false);
    const entry = entryFor(trayMenuTemplate(translator("en"), a), "Resume Nearby");
    if ("click" in entry) entry.click();
    expect(a.setNearby).toHaveBeenCalledWith(true);
  });

  it("says what the Inbox item will DO, and offers it while the window is shut", () => {
    // The Device Inbox receives with the window hidden, which is the state a
    // tray exists for: without this the only way to stop it is to open the
    // window, and macOS has offered it from the menu bar all along.
    expect(() => entryFor(trayMenuTemplate(translator("en"), actions(true, false)), "Pause Device Inbox")).not.toThrow();
    expect(() => entryFor(trayMenuTemplate(translator("en"), actions(true, true)), "Resume Device Inbox")).not.toThrow();
  });

  it("asks for the state it does not already have", () => {
    const a = actions(true, false);
    const entry = entryFor(trayMenuTemplate(translator("en"), a), "Pause Device Inbox");
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
    expect(label(en[4]!)).not.toBe(label(zh[4]!));
    expect(label(zh[4]!)).toBe("打开 Relayium");
    // The report is localized too, not only the actions.
    expect(label(zh[0]!)).toBe("未登录");
    expect(trayTooltip(translator("zh-Hans"))).toBe("Relayium");
  });

  it("wires each item to its own action", () => {
    const a = actions();
    const items = trayMenuTemplate(translator("en"), a);
    const click = (i: number) => {
      const entry = items[i]!;
      if ("click" in entry) entry.click();
    };
    click(4);
    expect(a.show).toHaveBeenCalledOnce();
    expect(a.quit).not.toHaveBeenCalled();
    click(6);
    expect(a.openNearby).toHaveBeenCalledOnce();
    click(7);
    expect(a.openInbox).toHaveBeenCalledOnce();
    click(8);
    // Opens the page and acts on NOTHING: a menu item cannot show what it
    // would do, so nothing about an update may happen from one.
    expect(a.openUpdates).toHaveBeenCalledOnce();
    expect(a.quit).not.toHaveBeenCalled();
    click(13);
    expect(a.quit).toHaveBeenCalledOnce();
  });
});
