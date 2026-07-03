import { describe, it, expect } from "vitest";
import { shouldNotify } from "./notify";

describe("shouldNotify", () => {
  it("notifies only when the tab is hidden and permission is granted", () => {
    expect(shouldNotify("hidden", "granted")).toBe(true);
  });
  it("stays silent when the user is already looking at the tab", () => {
    expect(shouldNotify("visible", "granted")).toBe(false);
  });
  it("stays silent when permission is not granted", () => {
    expect(shouldNotify("hidden", "denied")).toBe(false);
    expect(shouldNotify("hidden", "default")).toBe(false);
  });
});
