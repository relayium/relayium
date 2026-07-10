import { describe, it, expect } from "vitest";
import { applyRename } from "./apply-rename";

const peers = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];

describe("applyRename", () => {
  it("renames the matching peer, leaves others", () => {
    expect(applyRename(peers, "a", "Alicia")).toEqual([{ id: "a", name: "Alicia" }, { id: "b", name: "Bob" }]);
  });
  it("ignores an unknown id", () => {
    expect(applyRename(peers, "z", "X")).toEqual(peers);
  });
  it("trims + caps at 64 chars and ignores an empty name", () => {
    expect(applyRename(peers, "a", "  ")).toEqual(peers);
    const long = "x".repeat(100);
    expect(applyRename(peers, "a", long)[0].name).toHaveLength(64);
  });
});
