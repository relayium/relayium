import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import PeerLink from "./PeerLink.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  target.remove();
});

function render(props: { selfName: string; peerName: string }) {
  app = mount(PeerLink, { target, props });
  flushSync();
}

describe("PeerLink", () => {
  it("renders both endpoint labels visually", () => {
    render({ selfName: "My Laptop", peerName: "Alice" });
    const labels = [...target.querySelectorAll(".label")].map((e) => e.textContent);
    expect(labels).toEqual(["My Laptop", "Alice"]);
  });

  it("shows each endpoint's initial", () => {
    render({ selfName: "my laptop", peerName: "alice" });
    const avatars = [...target.querySelectorAll(".avatar")].map((e) => e.textContent);
    expect(avatars).toEqual(["M", "A"]);
  });

  it("falls back to ? for an empty name instead of rendering an empty avatar", () => {
    render({ selfName: "", peerName: "Alice" });
    const avatars = [...target.querySelectorAll(".avatar")].map((e) => e.textContent);
    expect(avatars).toEqual(["?", "A"]);
  });

  // It is decoration next to the peer card, not a second control for the same
  // peer: no button, no link, nothing in the tab order, nothing announced.
  it("contains no focusable control", () => {
    render({ selfName: "My Laptop", peerName: "Alice" });
    expect(target.querySelectorAll("button, a, input, select, textarea, [tabindex]").length).toBe(0);
  });

  it("is hidden from assistive technology as a unit", () => {
    render({ selfName: "My Laptop", peerName: "Alice" });
    const root = target.querySelector(".peerlink")!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    // The hidden subtree must be the whole component — nothing may escape it.
    expect(target.firstElementChild).toBe(root);
  });
});
