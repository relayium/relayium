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
    // Distribution truth, matched by shape rather than by one exact sentence:
    // neither native app is offered anywhere, and saying so must survive an
    // ordinary rewrite of the surrounding prose.
    // Markdown wraps these sentences, so match across the line breaks.
    expect(readme).toMatch(/Public release[^.]*still pending/);
    expect(readme).toMatch(/no download\s+to\s+install/);
    expect(readme).toMatch(/no App\s+Store\s+release/);
    // R3-D/E/F shipped the iOS realtime, nearby and account-management work the
    // status section used to list as unbuilt. What is still missing is the
    // lifecycle around it, and the section has to keep saying which is which:
    // the app has no background execution, so nothing keeps running once it
    // leaves the foreground. Match that lifecycle truth by shape, across the
    // Markdown line breaks, rather than by one exact sentence.
    expect(readme).not.toMatch(/realtime and nearby transfer[^.]*still to be built/);
    expect(readme).toMatch(/Nothing\s+runs\s+while\s+the\s+app\s+is\s+in\s+the\s+background/);
    expect(readme).not.toContain("status-M0%20MVP");
    expect(readme).not.toContain("This repository is **M0**");
    expect(readme).not.toContain("This is an early MVP");

    expect(security).toContain("active, pre-1.0 development");
    expect(security).not.toContain("early MVP");
    expect(security).not.toContain("(**M0**)");
  });
});
