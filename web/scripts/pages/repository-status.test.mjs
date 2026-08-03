import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public repository status", () => {
  it("describes the current product without the stale M0 MVP framing", async () => {
    const repositoryRoot = resolve(process.cwd(), "..");
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
    const security = await readFile(resolve(repositoryRoot, "SECURITY.md"), "utf8");

    expect(readme).toContain("status-active%20development");
    expect(readme).toContain("The production web app and CLI");
    expect(readme).toContain("## Delivery status");
    expect(readme).toContain("**macOS — engineering build, not public:**");
    expect(readme).toContain("**iOS — in development, not public:**");
    expect(readme).toContain("Public release and the website download");
    expect(readme).toContain("there is no download to install");
    expect(readme).not.toContain("status-M0%20MVP");
    expect(readme).not.toContain("This repository is **M0**");
    expect(readme).not.toContain("This is an early MVP");

    expect(security).toContain("active, pre-1.0 development");
    expect(security).not.toContain("early MVP");
    expect(security).not.toContain("(**M0**)");
  });
});
