import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import Icon, { type IconName } from "./Icon.svelte";

let target: HTMLDivElement;
let app: Record<string, any> | undefined;

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  target.remove();
});

function render(name: IconName, size?: number) {
  app = mount(Icon, { target, props: size === undefined ? { name } : { name, size } });
  return target.querySelector("svg")!;
}

const geometry: Record<IconName, string[]> = {
  bolt: ["M13.5 3 6 13.5h4.8L10.5 21 18 10.5h-4.8z"],
  file: [
    "M7 3.5h6l4 4v12a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8V4.3A.8.8 0 0 1 7 3.5z",
    "M13 3.5v4h4",
  ],
  folder: ["M3.5 7.2a1 1 0 0 1 1-1h4l2 2.2h9a1 1 0 0 1 1 1v9.1a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"],
  message: ["M5 5.2h14a1.8 1.8 0 0 1 1.8 1.8v8.2A1.8 1.8 0 0 1 19 17H14l-2 3-2-3H5a1.8 1.8 0 0 1-1.8-1.8V7A1.8 1.8 0 0 1 5 5.2z"],
};

describe("Icon", () => {
  it.each<IconName>(["bolt", "file", "folder", "message"])("renders the %s geometry", (name) => {
    const svg = render(name);
    expect(target.querySelectorAll("svg")).toHaveLength(1);
    expect([...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(geometry[name]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke-width")).toBe("1.8");
    unmount(app!);
    app = undefined;
  });

  it("keeps the message tail centred on x=12 for direction-neutral RTL use", () => {
    const path = render("message").querySelector("path")!.getAttribute("d")!;
    // The lower edge runs to x=14, then symmetrically through x=12 to x=10.
    expect(path).toContain("H14l-2 3-2-3H5");
  });

  it("is always decorative and cannot receive focus", () => {
    const svg = render("message");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.querySelector("title")).toBeNull();
    expect(svg.querySelector("[id]")).toBeNull();
  });

  it("uses a 16px default and accepts an explicit numeric size", () => {
    let svg = render("file");
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["16", "16"]);
    unmount(app!);
    app = undefined;
    target.replaceChildren();
    svg = render("file", 18);
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["18", "18"]);
  });
});
