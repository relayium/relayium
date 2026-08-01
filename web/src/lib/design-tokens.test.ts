import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("library components reference no known phantom design tokens", () => {
  const phantom = ["--fs-xl", "--fs-lg", "--fs-md", "--text-muted"];
  it("checks every top-level Svelte component", () => {
    for (const file of readdirSync(import.meta.dirname).filter((name) => name.endsWith(".svelte"))) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const token of phantom) expect(source, `${file} references ${token}`).not.toContain(token);
    }
  });
});
