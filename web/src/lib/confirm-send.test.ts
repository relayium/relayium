import { describe, it, expect } from "vitest";
import { shouldConfirmBeforeSend } from "./confirm-send";

describe("shouldConfirmBeforeSend", () => {
  it("requires confirmation in a code room (cross-network)", () => {
    expect(shouldConfirmBeforeSend("123456")).toBe(true);
  });
  it("does NOT require confirmation on LAN (no code)", () => {
    expect(shouldConfirmBeforeSend(null)).toBe(false);
    expect(shouldConfirmBeforeSend("")).toBe(false);
    expect(shouldConfirmBeforeSend(undefined)).toBe(false);
  });
});
