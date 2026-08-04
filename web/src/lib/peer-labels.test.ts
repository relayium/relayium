import { describe, it, expect } from "vitest";
import { labelPeers, shortPeerId } from "./peer-labels";

describe("labelPeers", () => {
  it("leaves distinct names alone", () => {
    const peers = [{ id: "aaaaaaaaaaaa", name: "Mac" }, { id: "bbbbbbbbbbbb", name: "iPhone" }];
    expect(labelPeers(peers).map((p) => p.name)).toEqual(["Mac", "iPhone"]);
  });

  it("suffixes genuinely different peers that share a name", () => {
    // Grouping merges one installation's tabs; what is left here is two REAL
    // devices whose owner named both "Mac". Without a suffix the chooser offers
    // two identical rows and the user cannot tell which one they picked.
    const peers = [
      { id: "1111111111abc123", name: "Mac" },
      { id: "2222222222def456", name: "Mac" },
      { id: "3333333333ghi789", name: "iPhone" },
    ];
    expect(labelPeers(peers).map((p) => p.name)).toEqual([
      "Mac · abc123", "Mac · def456", "iPhone",
    ]);
  });

  it("keeps every id untouched, because selection binds to the id", () => {
    const peers = [{ id: "1111111111abc123", name: "Mac" }, { id: "2222222222def456", name: "Mac" }];
    const labelled = labelPeers(peers);
    expect(labelled.map((p) => p.id)).toEqual(["1111111111abc123", "2222222222def456"]);
    // and the input is not mutated — `peers` is reactive state elsewhere.
    expect(peers.map((p) => p.name)).toEqual(["Mac", "Mac"]);
  });

  it("preserves the order it was given", () => {
    const peers = [
      { id: "cccccccccccccccc", name: "Zed" },
      { id: "aaaaaaaaaaaaaaaa", name: "Amy" },
    ];
    expect(labelPeers(peers).map((p) => p.id)).toEqual(["cccccccccccccccc", "aaaaaaaaaaaaaaaa"]);
  });

  it("handles an empty roster and short ids without throwing", () => {
    expect(labelPeers([])).toEqual([]);
    expect(labelPeers([{ id: "ab", name: "X" }, { id: "cd", name: "X" }]).map((p) => p.name))
      .toEqual(["X · ab", "X · cd"]);
  });
});

describe("shortPeerId", () => {
  it("shows the tail of the id, matching the native chooser", () => {
    expect(shortPeerId("1111111111abc123")).toBe("abc123");
    expect(shortPeerId("ab")).toBe("ab");
  });
});
