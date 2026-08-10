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
    expect(readme).toContain("**macOS — 1.0, published as a direct download:**");
    expect(readme).toContain("**iOS — in development, not public:**");
    // Distribution truth, matched by shape rather than by one exact sentence, so
    // it survives an ordinary rewrite of the surrounding prose.
    //
    // The two native apps stopped being in the same state on 2026-08-10. This
    // used to require `Public release[^.]*still pending`, one sentence standing
    // for both of them, and that sentence went false the day the first one
    // shipped. Now each is asserted for what it actually is: macOS names the
    // immutable tag a reader can fetch and denies the App Store channel it does
    // not use, and iOS keeps saying it is offered nowhere.
    // Markdown wraps these sentences, so match across the line breaks.
    expect(readme).toContain("macos-v1.0");
    expect(readme).toMatch(/no Mac App Store listing/);
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
