import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTransfer,
  loadHistory,
  clearHistory,
  historyEnabled,
  setHistoryEnabled,
  HISTORY_MAX,
} from "./history";

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

describe("history opt-out", () => {
  it("records by default — the setting is opt-OUT", () => {
    expect(historyEnabled()).toBe(true);
    recordTransfer({ name: "a.txt", size: 1, direction: "send", peer: "p" });
    expect(loadHistory()).toHaveLength(1);
  });
  it("stops recording once turned off", () => {
    setHistoryEnabled(false);
    expect(historyEnabled()).toBe(false);
    recordTransfer({ name: "a.txt", size: 1, direction: "send", peer: "p" });
    expect(loadHistory()).toEqual([]);
  });
  it("turning it off drops what was already stored", () => {
    recordTransfer({ name: "secret.pdf", size: 1, direction: "recv", peer: "Bob" });
    expect(loadHistory()).toHaveLength(1);
    setHistoryEnabled(false);
    // Nothing left behind: not the entries, and not the raw key either.
    expect(loadHistory()).toEqual([]);
    expect(localStorage.getItem("relayium.history")).toBeNull();
  });
  it("turning it back on resumes recording", () => {
    setHistoryEnabled(false);
    setHistoryEnabled(true);
    expect(historyEnabled()).toBe(true);
    recordTransfer({ name: "a.txt", size: 1, direction: "send", peer: "p" });
    expect(loadHistory()).toHaveLength(1);
  });
});
