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

  // `compact` is the empty state's inline scanning signal. It must stay purely
  // presentational: opt-in, and identical in structure and behaviour otherwise.
  describe("compact", () => {
    it("defaults to the full-size radar", () => {
      app = mount(DeviceRadar, {
        target,
        props: { peers: PEERS, selfName: "Me", selectedId: "", onSelect: () => {} },
      });
      flushSync();
      expect(target.querySelector(".radar")!.classList.contains("compact")).toBe(false);
    });

    it("marks the radar compact when asked", () => {
      app = mount(DeviceRadar, {
        target,
        props: { peers: [], selfName: "Me", selectedId: "", onSelect: () => {}, compact: true },
      });
      flushSync();
      const radar = target.querySelector(".radar")!;
      expect(radar.classList.contains("compact")).toBe(true);
      // Empty compact mode is decoration beside explicit empty-state copy, not
      // a second empty group with the same "Nearby devices" name.
      expect(radar.getAttribute("role")).toBeNull();
      expect(radar.getAttribute("aria-label")).toBeNull();
      expect(radar.getAttribute("aria-hidden")).toBe("true");
      expect(radar.querySelector(".scope")).not.toBeNull();
      expect(radar.querySelectorAll("button").length).toBe(0);
    });

    it("keeps blips accessible and selection working if compact is combined with peers", () => {
      const onSelect = vi.fn();
      app = mount(DeviceRadar, {
        target,
        props: { peers: PEERS, selfName: "Me", selectedId: "p2", onSelect, compact: true },
      });
      flushSync();
      const blips = target.querySelectorAll("button.blip");
      expect(blips.length).toBe(2);
      expect(target.querySelector(".radar")!.getAttribute("role")).toBe("group");
      expect(target.querySelector(".radar")!.getAttribute("aria-hidden")).toBeNull();
      expect(target.querySelector("button.blip[aria-pressed='true']")!.getAttribute("aria-label"))
        .toContain("Bob");
      (blips[0] as HTMLButtonElement).click();
      flushSync();
      expect(onSelect).toHaveBeenCalledWith("p1");
    });
  });
});
