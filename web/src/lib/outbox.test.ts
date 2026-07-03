import { describe, it, expect } from "vitest";
import { outbox, setOutbox, takeOutbox, clearOutbox } from "./outbox.svelte";

const pf = (name: string) => ({ file: new File(["x"], name) });

describe("outbox", () => {
  it("starts empty and holds what was set", () => {
    clearOutbox();
    expect(outbox()).toEqual([]);
    const files = [pf("a.txt"), pf("b.txt")];
    setOutbox(files);
    expect(outbox()).toEqual(files);
  });
  it("take drains atomically", () => {
    const files = [pf("a.txt")];
    setOutbox(files);
    expect(takeOutbox()).toEqual(files);
    expect(outbox()).toEqual([]);
    expect(takeOutbox()).toEqual([]);
  });
  it("clear empties", () => {
    setOutbox([pf("a.txt")]);
    clearOutbox();
    expect(outbox()).toEqual([]);
  });
});
