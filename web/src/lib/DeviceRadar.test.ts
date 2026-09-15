import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync, type ComponentProps } from "svelte";
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

// The selector used to be absolutely-positioned blips placed from a hash of the
// peer id, so two peers could land on top of each other — axe reported
// overlapping, partly obscured targets on a real multi-peer roster. These pin
// the properties that replaced it.
describe("DeviceRadar selectors cannot collide", () => {
  const COLLIDING = [
    { id: "aaaaaaaa", name: "Mac" },
    { id: "bbbbbbbb", name: "Mac" },
    { id: "cccccccc", name: "Mac" },
    { id: "dddddddd", name: "lily's MacBook Pro (work)" },
  ];

  function render(props: Partial<ComponentProps<typeof DeviceRadar>> & { peers: { id: string; name: string }[] }) {
    app = mount(DeviceRadar, {
      target,
      props: { selfName: "Me", selectedId: "", onSelect: () => {}, ...props } as ComponentProps<typeof DeviceRadar>,
    });
    flushSync();
    return target;
  }

  it("gives every peer its own button, even when the names are identical", () => {
    const root = render({ peers: COLLIDING });
    const blips = [...root.querySelectorAll<HTMLButtonElement>("button.blip")];
    expect(blips.length).toBe(4);
    // A list, not a positioned layer: nothing here can overlap anything.
    for (const b of blips) {
      expect(b.getAttribute("style"), "a selector may not carry absolute placement").toBeNull();
      expect(b.closest("li"), "each selector is its own list item").not.toBeNull();
    }
    expect(root.querySelectorAll("ul.picks li").length).toBe(4);
  });

  it("routes selection to the right id when three peers share a name", () => {
    const onSelect = vi.fn();
    const root = render({ peers: COLLIDING, onSelect });
    const blips = [...root.querySelectorAll<HTMLButtonElement>("button.blip")];
    blips[2].click();
    flushSync();
    expect(onSelect).toHaveBeenCalledWith("cccccccc");
    blips[3].click();
    flushSync();
    expect(onSelect).toHaveBeenLastCalledWith("dddddddd");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("marks exactly the selected peer pressed, by id rather than by name", () => {
    const root = render({ peers: COLLIDING, selectedId: "bbbbbbbb" });
    const pressed = [...root.querySelectorAll("button.blip")].filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.length).toBe(1);
    expect(pressed[0]).toBe(root.querySelectorAll("button.blip")[1]);
  });

  // WCAG 2.5.3, as axe actually evaluates it: the accessible name is compared
  // against the button's VISIBLE TEXT, and `aria-hidden` on a text node does not
  // remove that text from the comparison. An initial beside the name made every
  // button render "M Mac-408" against "Select Mac-408" — four real violations on
  // a live four-peer roster. The mark is an <svg> now, so the rendered text is
  // the device name and nothing else.
  it("renders the device name as the button's only visible text", () => {
    const root = render({ peers: [{ id: "e1", name: "Mac-408" }, { id: "e2", name: "lily's MacBook" }] });
    for (const blip of root.querySelectorAll<HTMLButtonElement>("button.blip")) {
      const label = blip.getAttribute("aria-label")!;
      const visible = blip.textContent!.replace(/\s+/g, " ").trim();
      const name = blip.querySelector(".blabel")!.textContent!.trim();
      expect(visible, "the whole rendered text must be the device name").toBe(name);
      expect(label, "and it must be contained in the accessible name").toContain(visible);
      for (const promise of ["send", "drop", "files"]) {
        expect(label.toLowerCase(), `selecting must not promise to ${promise}`).not.toContain(promise);
      }
    }
  });

  it("draws the mark as a decorative graphic, never as a letter", () => {
    const root = render({ peers: [{ id: "e1", name: "Mac-408" }] });
    const mark = root.querySelector(".bavatar")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    const svg = mark.querySelector("svg")!;
    expect(svg, "the mark must be a graphic").not.toBeNull();
    // A graphic with a <title> would be text again, and back in the comparison.
    expect(svg.querySelector("title")).toBeNull();
    expect(mark.textContent!.trim(), "the mark contributes no text").toBe("");
  });
});
