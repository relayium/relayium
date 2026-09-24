#!/usr/bin/env node
// Migrated from web/scripts/pages/repository-status.test.mjs with assertions preserved.
// Root documentation changes do not select web.yml; repo-hygiene.yml runs this
// dependency-free Node check on main pushes and through merge-gate on PRs.
// Resolve inputs from this module,
// not the caller's working directory. Keep this as the sole owner of these tests.
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("public repository status", () => {
  it("describes the current product without the stale M0 MVP framing", async () => {
    const repositoryRoot = new URL("../../", import.meta.url);
    const readme = await readFile(new URL("README.md", repositoryRoot), "utf8");
    const security = await readFile(new URL("SECURITY.md", repositoryRoot), "utf8");
    // The published version is read, not written down again. `native-releases.json`
    // is what the /apps download CTA and the Device Inbox badge already resolve
    // against, so deriving the expected tag from it is the difference between
    // "the README names A tag" and "the README names THE tag a reader can fetch".
    const { macos } = JSON.parse(await readFile(new URL("web/native-releases.json", repositoryRoot), "utf8"));
    // The other macOS channel, from its own canonical record. Independently
    // versioned means independently sourced: `native-releases.json` describes
    // one artifact on GitHub, and nothing in it can say what Apple is currently
    // serving. The literal that used to sit here said 1.3.1 while the listing
    // was at 1.3.8, and it was green the whole time because it was checking the
    // README against itself.
    const appStore = JSON.parse(
      await readFile(new URL("web/mac-app-store-release.json", repositoryRoot), "utf8"),
    );

    assert.ok(readme.includes("status-active%20development"));
    assert.ok(readme.includes("The production web app and CLI"));
    assert.ok(readme.includes("## Delivery status"));
    const statusRows = Object.fromEntries(
      readme.split("\n")
        .filter((line) => /^\| \*\*[^*]+\*\* \|/.test(line))
        .map((line) => [line.match(/^\| \*\*([^*]+)\*\*/)?.[1], line]),
    );
    const macosRow = statusRows.macOS ?? "";
    assert.ok(macosRow.includes(`${macos.version} direct download`));
    assert.ok(macosRow.includes(`/releases/tag/macos-v${macos.version}`));
    assert.ok(macosRow.includes(`${appStore.version} on the Mac App Store`));
    assert.ok(macosRow.includes(appStore.url));

    // iOS left the Delivery-status table on 2026-08-28. The row used to say
    // "Internal development and TestFlight", which is a development commitment,
    // and there was nothing to deliver — so a status table that kept listing it
    // as a platform Relayium delivers on was making a promise nobody had earned.
    //
    // Development resumed at 0.3.0 on 2026-09-01 and the row still does not come
    // back: this table is what a reader can GET, and the answer is still nothing.
    // The two facts move independently, which is why the prose below asserts the
    // development state and the never-released state separately.
    //
    // Both halves are needed. Deleting the row alone would leave a reader who
    // had heard of the iOS build with no answer at all, and this project's
    // recurring documentation failure is exactly that shape: a claim removed
    // rather than corrected. So the table must not carry an iOS row, AND the
    // section must still state, in prose, what `apps/ios/` is.
    assert.equal(statusRows.iOS, undefined, "iOS is back in the delivery-status table");
    const delivery = readme.split("## Delivery status")[1]?.split("\n## ")[0] ?? "";
    assert.match(delivery, /`apps\/ios\/`[^.]*\*\*resumed\*\*/, "the delivery section no longer explains what apps/ios is");
    assert.match(delivery, /never been publicly released/i);
    assert.match(delivery, /no App Store listing/i);
    // …and the platforms that have no app must still be told what to use.
    const browserRow = statusRows["iPhone, iPad, Windows, Linux"] ?? "";
    assert.ok(browserRow.includes("web app"), "the no-native-app platforms lost their row");
    // Android moved OUT of that row into one of its own when the APK was
    // published; it must have a row, and that row must carry the preview's
    // real limits rather than reading as a full client.
    //
    // Rewritten 2026-09-09 for 0.2.0. This used to require `no Device Inbox`,
    // which was true of 0.1.1 and is now the opposite of the product: the
    // Android client enrols a key, holds a receiving policy and keeps a durable
    // history. The limit that IS still real is residency, so that is what the
    // row must carry — and the stale denial is asserted ABSENT, because a row
    // that kept it would be actively wrong rather than merely out of date.
    const androidRow = statusRows.Android ?? "";
    assert.ok(androidRow.includes("APK"), "Android has no delivery-status row");
    assert.match(androidRow, /no Google Play/i);
    assert.doesNotMatch(androidRow, /no Device Inbox|not a Device Inbox receiver/i, "the row still denies the Device Inbox 0.2.0 ships");
    assert.match(androidRow, /foreground only/i, "the row does not state the foreground-only limit");
    // And it must not describe macOS's receive-folder model. Android commits
    // into app-private, account-scoped storage (InboxContainer.kt): there is no
    // folder to pick and none to reconnect, so copy borrowed from the Mac
    // receiver would send a reader looking for a control that does not exist.
    assert.doesNotMatch(androidRow, /receive folder|folder you (?:pick|chose|choose)|choose a folder/i, "the row claims a user-chosen receive folder Android has no such thing");
    assert.match(browserRow, /publishes no app for these platforms/i);
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
    assert.ok(readme.includes(`macos-v${macos.version}`));
    assert.deepEqual(new Set([...readme.matchAll(/macos-v[0-9][0-9.]*/g)].map((m) => m[0])), new Set([`macos-v${macos.version}`]));
    assert.doesNotMatch(readme, /realtime and nearby transfer[^.]*still to be built/);
    // No iOS product promise anywhere in the README, in either tense. The
    // repository is building an iOS app again and still ships none, so the
    // sentence to keep out is the one that reads as a product rather than the
    // one that reports development state.
    assert.doesNotMatch(readme, /\bthe iOS app (?:is|will be|runs|now)\b/i, "the README still promises an iOS app");
    assert.ok(!readme.includes("status-M0%20MVP"));
    assert.ok(!readme.includes("This repository is **M0**"));
    assert.ok(!readme.includes("This is an early MVP"));

    assert.ok(security.includes("active, pre-1.0 development"));
    assert.ok(!security.includes("early MVP"));
    assert.ok(!security.includes("(**M0**)"));
  });
});
