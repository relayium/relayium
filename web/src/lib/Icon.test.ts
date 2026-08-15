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
  link: [
    "M9.5 14.5 8 16a4 4 0 0 1-5.7-5.7l2.2-2.2a4 4 0 0 1 5.7 0",
    "m14.5 9.5 1.5-1.5a4 4 0 0 1 5.7 5.7l-2.2 2.2a4 4 0 0 1-5.7 0",
    "m8.5 15.5 7-7",
  ],
  "pairing-code": ["M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"],
  lock: ["M7 10V7a5 5 0 0 1 10 0v3", "M5 10h14v10H5z", "M12 14v2"],
  download: ["M12 3v11m0 0-4-4m4 4 4-4", "M5 16v4h14v-4"],
  package: ["m4 7.5 8-4.5 8 4.5v9L12 21l-8-4.5z", "m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25l8 4.5"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM3 12h18", "M12 3c2.6 2.5 4 5.5 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.5-4-9s1.4-6.5 4-9z"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 7v5l3 2"],
  devices: ["M2 5h12v8.5H2zM6.5 17h5M9 13.5V17", "M15.5 8H22v11.5h-6.5zM18 17.5h1.5"],
  network: ["M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 17a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 17a2 2 0 1 1 0 4 2 2 0 0 1 0-4z", "M12 7v4m0 0-6 6m6-6 6 6"],
  nearby: ["M12 15.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z", "M8.4 14a5 5 0 0 1 7.2 0M5.6 11a9 9 0 0 1 12.8 0"],
  shield: ["M12 3l7 3v5c0 4.4-3 7.9-7 9.8C8 18.9 5 15.4 5 11V6zM9 12l2 2 4-4"],
  "file-download": ["M7 3.5h6l4 4v12a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8V4.3A.8.8 0 0 1 7 3.5zM13 3.5v4h4", "M11.5 11v5.5m0 0-2-2m2 2 2-2"],
  close: ["M6 6l12 12M18 6 6 18"],
  inbox: [
    "M3 12.2 6.3 5.4a1.6 1.6 0 0 1 1.45-.9h8.5a1.6 1.6 0 0 1 1.45.9L21 12.2v6.1a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 18.3z",
    "M3 12.2h5l1.4 2.6h5.2l1.4-2.6h5",
  ],
  // The six Device Inbox platform marks.
  server: ["M4 4.5h16v6H4z", "M4 13.5h16v6H4z", "M7 7.5h.01M7 16.5h.01"],
  desktop: ["M3.5 4.5h17v11H3.5z", "M12 15.5v3.5M8.5 19h7"],
  laptop: ["M5 5h14v10.5H5z", "M2.5 18.5h19"],
  window: ["M4 4.5h16v15H4z", "M12 4.5v15M4 12h16"],
  phone: [
    "M7.6 4.2h8.8a1.6 1.6 0 0 1 1.6 1.6v12.4a1.6 1.6 0 0 1-1.6 1.6H7.6a1.6 1.6 0 0 1-1.6-1.6V5.8a1.6 1.6 0 0 1 1.6-1.6z",
    "M10.5 7h3",
  ],
  robot: [
    "M4.5 16.5a7.5 7.5 0 0 1 15 0",
    "M4.5 16.5h15",
    "M8.4 9.9 6.6 7.2M15.6 9.9l1.8-2.7",
    "M9.7 13h.01M14.3 13h.01",
  ],
};

describe("Icon", () => {
  it.each(Object.keys(geometry) as IconName[])("renders the %s geometry", (name) => {
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

  it("keeps the nearby endpoint as the original solid dot", () => {
    const dot = render("nearby").querySelector("path")!;
    expect(dot.getAttribute("fill")).toBe("currentColor");
    expect(dot.getAttribute("stroke")).toBe("none");
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
