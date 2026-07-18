import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import DeviceRadar from "./DeviceRadar.svelte";
import { loadLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  target.remove();
});

const PEERS = [
  { id: "p1", name: "Alice" },
  { id: "p2", name: "Bob" },
];

describe("DeviceRadar", () => {
  it("renders one blip button per peer with an aria-label", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "", onSelect: () => {} },
    });
    flushSync();
    const blips = target.querySelectorAll("button.blip");
    expect(blips.length).toBe(2);
    expect(blips[0].getAttribute("aria-label")).toContain("Alice");
  });

  it("marks the selected peer pressed", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "p2", onSelect: () => {} },
    });
    flushSync();
    const pressed = target.querySelector("button.blip[aria-pressed='true']")!;
    expect(pressed.getAttribute("aria-label")).toContain("Bob");
  });

  it("fires onSelect with the peer id on click", () => {
    const onSelect = vi.fn();
    app = mount(DeviceRadar, {
      target,
      props: { peers: PEERS, selfName: "Me", selectedId: "", onSelect },
    });
    flushSync();
    (target.querySelector("button.blip") as HTMLButtonElement).click();
    flushSync();
    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("renders no blips when there are no peers", () => {
    app = mount(DeviceRadar, {
      target,
      props: { peers: [], selfName: "Me", selectedId: "", onSelect: () => {} },
    });
    flushSync();
    expect(target.querySelectorAll("button.blip").length).toBe(0);
    expect(target.querySelector(".scope")).not.toBeNull();
  });
});
