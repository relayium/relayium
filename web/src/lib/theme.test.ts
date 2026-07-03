import { describe, it, expect, beforeEach } from "vitest";
import { theme, setTheme, applyTheme } from "./theme.svelte";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("applyTheme sets data-theme for light/dark and clears it for system", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("setTheme persists the choice and reflects it on <html>", () => {
    setTheme("dark");
    expect(theme()).toBe("dark");
    expect(localStorage.getItem("relayium-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
