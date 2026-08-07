import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PendingFiles from "./PendingFiles.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(() => {
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
});

function render(files: readonly ({ name: string; size: number } | { file: File })[], summary = "Files ready") {
  app = mount(PendingFiles, { target, props: { files, summary } });
  flushSync();
}

const names = () => [...target.querySelectorAll<HTMLElement>(".file-name")];
const sizes = () => [...target.querySelectorAll<HTMLElement>(".file-size")];

describe("PendingFiles", () => {
  it("shows the exact single-file identity and the zero-byte boundary", () => {
    render([{ file: new File([], "empty.txt") }], "1 file · 0 B total");

    expect(target.querySelector(".summary")?.textContent).toBe("1 file · 0 B total");
    expect(names().map((node) => node.textContent)).toEqual(["empty.txt"]);
    expect(sizes().map((node) => node.textContent)).toEqual(["0 B"]);
  });

  it("renders every file and each size rather than collapsing a multi-file batch", () => {
    render([
      { name: "alpha.bin", size: 1024 },
      { name: "beta.bin", size: 10 * 1024 },
      { name: "gamma.bin", size: 1536 },
    ], "3 files · 12.5 KB total");

    expect(names().map((node) => node.textContent))
      .toEqual(["alpha.bin", "beta.bin", "gamma.bin"]);
    expect(sizes().map((node) => node.textContent))
      .toEqual(["1.0 KB", "10 KB", "1.5 KB"]);
  });

  it("preserves real Unicode and RTL names but removes invisible spoofing controls", () => {
    const rlo = String.fromCodePoint(0x202e);
    render([
      { name: "报告 2026.pdf", size: 1 },
      { name: "مرحبا بالعالم.pdf", size: 2 },
      { name: `evil${rlo}gnp.exe\n`, size: 3 },
    ]);

    expect(names().map((node) => node.textContent))
      .toEqual(["报告 2026.pdf", "مرحبا بالعالم.pdf", "evilgnp.exe"]);
    for (const node of names()) {
      expect(node.tagName).toBe("BDI");
      expect(node.getAttribute("dir")).toBe("auto");
    }
    for (const node of sizes()) expect(node.getAttribute("dir")).toBe("ltr");
  });

  it("keeps a long full name and exposes a large bounded list to keyboard scrolling", () => {
    const long = `${"very-long-name-".repeat(20)}.txt`;
    render(Array.from({ length: 40 }, (_, index) => ({
      name: index === 0 ? long : `file-${index}.txt`,
      size: index,
    })), "40 files · 780 B total");

    const list = target.querySelector<HTMLElement>(".file-scroll")!;
    expect(names()).toHaveLength(40);
    expect(names()[0].textContent).toBe(long);
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute("aria-label")).toBe("40 files · 780 B total");

    const source = readFileSync(join(process.cwd(), "src/lib/PendingFiles.svelte"), "utf8");
    expect(source).toMatch(/max-block-size:\s*200px/);
    expect(source).toMatch(/overflow:\s*auto/);
    expect(source).toMatch(/flex-wrap:\s*wrap/);
    expect(source).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
