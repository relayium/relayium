import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public repository status", () => {
  it("describes the current product without the stale M0 MVP framing", async () => {
    const repositoryRoot = resolve(process.cwd(), "..");
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
    const security = await readFile(resolve(repositoryRoot, "SECURITY.md"), "utf8");
    // The published version is read, not written down again. `native-releases.json`
    // is what the /apps download CTA and the Device Inbox badge already resolve
    // against, so deriving the expected tag from it is the difference between
    // "the README names A tag" and "the README names THE tag a reader can fetch".
    const { macos } = JSON.parse(await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"));
    // The other macOS channel, from its own canonical record. Independently
    // versioned means independently sourced: `native-releases.json` describes
    // one artifact on GitHub, and nothing in it can say what Apple is currently
    // serving. The literal that used to sit here said 1.3.1 while the listing
    // was at 1.3.8, and it was green the whole time because it was checking the
    // README against itself.
    const appStore = JSON.parse(
      await readFile(resolve(process.cwd(), "mac-app-store-release.json"), "utf8"),
    );

    expect(readme).toContain("status-active%20development");
    expect(readme).toContain("The production web app and CLI");
    expect(readme).toContain("## Delivery status");
    const statusRows = Object.fromEntries(
      readme.split("\n")
        .filter((line) => /^\| \*\*(?:macOS|iOS)\*\* \|/.test(line))
        .map((line) => [line.match(/^\| \*\*([^*]+)\*\*/)?.[1], line]),
    );
    const macosRow = statusRows.macOS ?? "";
    const iosRow = statusRows.iOS ?? "";
    expect(macosRow).toContain(`${macos.version} direct download`);
    expect(macosRow).toContain(`/releases/tag/macos-v${macos.version}`);
    expect(macosRow).toContain(`${appStore.version} on the Mac App Store`);
    expect(macosRow).toContain(appStore.url);
    expect(iosRow).toMatch(/Internal development and TestFlight/i);
    expect(iosRow).toMatch(/Not publicly available on the App Store/i);
    expect(iosRow).not.toMatch(/\[[^\]]+\]\([^)]+\)/);
    expect(iosRow).toMatch(/remain in the foreground/i);
    expect(iosRow).toMatch(/push notifications are not supported/i);
    // Distribution truth, matched by shape rather than by one exact sentence, so
    // it survives an ordinary rewrite of the surrounding prose.
    //
    // The two native apps stopped being in the same state on 2026-08-10. This
    // used to require `Public release[^.]*still pending`, one sentence standing
    // for both of them, and that sentence went false the day the first one
    // shipped. Now each is asserted for what it actually is: macOS names the
    // immutable tag a reader can fetch and names the independently versioned
    // App Store channel, while iOS stays explicitly non-public.
    // Markdown wraps these sentences, so match across the line breaks.
    //
    // The tag has to be the CURRENT one. A bare `toContain("macos-v1.0")` passed
    // unchanged through 1.1, 1.1.1, 1.1.2, 1.1.3 and 1.2.1 while the README kept
    // sending readers to the first release and calling it the current build —
    // the assertion was green for five releases it no longer described. Both
    // halves are needed: the current tag present, and no superseded tag left
    // behind pointing at an older download.
    // A set, not a count: how many times the prose links the release is an
    // editorial choice, but every one of those links has to be the same current
    // tag. `toContain` above keeps the set from being vacuously empty.
    expect(readme).toContain(`macos-v${macos.version}`);
    expect(new Set([...readme.matchAll(/macos-v[0-9][0-9.]*/g)].map((m) => m[0])))
      .toEqual(new Set([`macos-v${macos.version}`]));
    // R3-D/E/F shipped the iOS realtime, nearby and account-management work the
    // status section used to list as unbuilt. What is still missing is the
    // lifecycle around it, and the section has to keep saying which is which:
    // the app has no background execution, so nothing keeps running once it
    // leaves the foreground. Match that lifecycle truth by shape, across the
    // Markdown line breaks, rather than by one exact sentence.
    expect(readme).not.toMatch(/realtime and nearby transfer[^.]*still to be built/);
    expect(readme).not.toContain("status-M0%20MVP");
    expect(readme).not.toContain("This repository is **M0**");
    expect(readme).not.toContain("This is an early MVP");

    expect(security).toContain("active, pre-1.0 development");
    expect(security).not.toContain("early MVP");
    expect(security).not.toContain("(**M0**)");
  });
});
