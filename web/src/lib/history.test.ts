import { describe, it, expect, beforeEach } from "vitest";
import { recordTransfer, loadHistory, clearHistory, HISTORY_MAX } from "./history";

beforeEach(() => localStorage.clear());

describe("history", () => {
  it("records and loads newest-first", () => {
    recordTransfer({ name: "a.txt", size: 10, direction: "send", peer: "Bob" });
    recordTransfer({ name: "b.txt", size: 20, direction: "recv", peer: "Al" });
    const h = loadHistory();
    expect(h).toHaveLength(2);
    expect(h[0].name).toBe("b.txt"); // newest first
    expect(h[0].id).toBeTruthy();
    expect(h[0].at).toBeGreaterThan(0);
  });
  it("caps at HISTORY_MAX, dropping oldest", () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) recordTransfer({ name: `f${i}`, size: 1, direction: "send", peer: "p" });
    const h = loadHistory();
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0].name).toBe(`f${HISTORY_MAX + 4}`); // newest kept
    expect(h.some((e) => e.name === "f0")).toBe(false); // oldest dropped
  });
  it("returns [] on corrupt storage and clears", () => {
    localStorage.setItem("relayium.history", "{not json");
    expect(loadHistory()).toEqual([]);
    recordTransfer({ name: "x", size: 1, direction: "send", peer: "p" });
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});
