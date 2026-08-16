import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The feed and the manifest are one fact read two ways, so both are loaded once
// and every case below branches on the same `available` bit.
//
// This file used to assert the feed by substring: `toContain('<rss version="2.0"')`
// and `toContain('sparkle:shortVersionString="1.0"')`. Both are false readings of
// XML, and each one failed on the FIRST real release rather than on a mistake:
//
//   * Attribute ORDER is not part of an XML document's meaning. The placeholder
//     feed in this repository happens to write `version` first; Sparkle's
//     `generate_appcast` writes `xmlns:sparkle` first, so the substring stopped
//     matching a feed that was correct in every way that matters.
//   * The versions are CHILD ELEMENTS of `<item>`, not enclosure attributes —
//     the exact shape mistake `stage-macos-release.mjs` documents at length and
//     already cost one notarization submission. Asserting the attribute spelling
//     here would have made this test PASS on the broken shape and FAIL on the
//     real one, which is worse than not testing it at all.
//
// So the feed is parsed the way the staging script parses it, and both halves
// are held to it.
const appcast = await readFile(
  resolve(process.cwd(), "public/apps/macos/appcast.xml"),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
);
const policy = JSON.parse(
  await readFile(resolve(process.cwd(), "native-client-policy.json"), "utf8"),
);
const MAC_AVAILABLE = manifest.macos.available === true;

const SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle";

/** An element's attribute, wherever it sits in the tag. */
function attribute(element, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return element.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? null;
}

/** A child element's text. Deliberately no attribute fallback — see above. */
function childText(element, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return element.match(new RegExp(`<${escaped}>([^<]*)</${escaped}>`))?.[1]?.trim() ?? null;
}

const rssTag = appcast.match(/<rss\b[^>]*>/)?.[0] ?? null;
const items = appcast.match(/<item>[\s\S]*?<\/item>/g) ?? [];
const asset = appcast.match(/<enclosure\b[^>]*?\/?>/)?.[0] ?? null;
// Everything before the first `<item>`: the channel's own fields. Read from the
// slice rather than the whole document because `<item>` has a `<title>` of its
// own, and a channel assertion that can be satisfied by a release's title is
// not a channel assertion.
const itemAt = appcast.indexOf("<item");
const channel = itemAt < 0 ? appcast : appcast.slice(0, itemAt);

describe("macOS Sparkle appcast", () => {
  it("is a Sparkle 2 feed whatever order its attributes are written in", () => {
    expect(rssTag, "no <rss> element").not.toBeNull();
    expect(attribute(rssTag, "version")).toBe("2.0");
    expect(attribute(rssTag, "xmlns:sparkle")).toBe(SPARKLE_NS);
    expect(appcast).toContain("<channel>");

    // The four channel fields `stage-macos-release.mjs` canonicalizes on every
    // staging run. Sparkle emits its own `<title>Relayium</title>`, so if this
    // ever reads back as anything else the canonicalization silently stopped
    // running and the published feed is whatever the tool felt like writing.
    expect(childText(channel, "title")).toBe("Relayium for macOS updates");
    expect(childText(channel, "link")).toBe("https://relayium.com/apps");
    expect(childText(channel, "description")).toBe("Signed Relayium updates for macOS.");
    expect(childText(channel, "language")).toBe("en");
  });

  it("matches the canonical native-release manifest", () => {
    // `available` decides whether AppsPage offers a download at all, and the
    // release workflow reads the same field with `jq`. A stringified "false"
    // would read as unavailable in one half and as present in the other.
    expect(typeof manifest.macos.available).toBe("boolean");

    if (!MAC_AVAILABLE) {
      expect(manifest.macos).toEqual({
        available: false,
        version: null,
        build: null,
        downloadUrl: null,
      });
      // A feed with no release: valid, parseable, and offering nothing. A
      // pre-release build that checks for updates must not be handed an
      // artifact that does not exist.
      expect(items).toEqual([]);
      expect(appcast).not.toContain("<enclosure");
      expect(appcast).not.toContain("sparkle:edSignature");
      return;
    }

    expect(manifest.macos.version).toMatch(/^[0-9]+(?:\.[0-9]+){1,2}$/);
    expect(Number.isInteger(manifest.macos.build)).toBe(true);
    expect(manifest.macos.build).toBeGreaterThan(0);
    expect(manifest.macos.downloadUrl).toBe(
      `https://github.com/relayium/relayium/releases/download/macos-v${manifest.macos.version}/Relayium.dmg`,
    );

    // One item. Relayium publishes one release at a time and the staging script
    // refuses a reused version, so a second item means something wrote this file
    // that is not that script.
    expect(items.length, "expected exactly one release item").toBe(1);
    const item = items[0];

    expect(childText(item, "sparkle:shortVersionString")).toBe(manifest.macos.version);
    expect(childText(item, "sparkle:version")).toBe(String(manifest.macos.build));

    expect(asset, "the release item has no enclosure").not.toBeNull();
    expect(attribute(asset, "url")).toBe(manifest.macos.downloadUrl);
    expect(attribute(asset, "length")).toMatch(/^[1-9][0-9]*$/);
    // Sparkle refuses an update whose EdDSA signature does not verify, so an
    // empty or malformed one is a feed that can never install anything.
    expect(attribute(asset, "sparkle:edSignature")).toMatch(/^[A-Za-z0-9+/]{40,}={0,2}$/);
  });

  /// **The published feed and the published policy are one decision.**
  ///
  /// Sparkle's `sparkle:criticalUpdate sparkle:version="N"` marks an update
  /// non-skippable for anyone running a build BELOW `N`, and the `N` it compares
  /// is `CFBundleVersion` — not the marketing string. The client compares
  /// marketing versions, because that is what its sentences say. So the same
  /// decision is written twice, in two vocabularies, and this is where they are
  /// held to each other.
  ///
  /// It matters for the releases that already exist. A build below the minimum
  /// predates every line of the client-side policy code and will never run any
  /// of it — the feed is the only thing that reaches it, and a critical update
  /// is the only lever there is.
  it("marks the published release critical for builds below the supported minimum", () => {
    if (!MAC_AVAILABLE) return;
    const critical = items[0].match(/<sparkle:criticalUpdate\b[^>]*?sparkle:version="([^"]*)"/);
    expect(critical, "the release item carries no critical-update threshold").not.toBeNull();
    expect(critical[1]).toBe(String(policy.macos.minimumSupportedBuild));
    // Exactly one. Two elements in one item is a document whose meaning depends
    // on which one Sparkle reads first.
    expect(items[0].match(/<sparkle:criticalUpdate\b/g)).toHaveLength(1);
    // And it is a threshold this release satisfies. Above its own build, the
    // feed would tell the people who just installed it that they are already
    // unsupported — and point them at the update they are running.
    expect(policy.macos.minimumSupportedBuild).toBeLessThanOrEqual(manifest.macos.build);
  });

  it("keeps the versions where Sparkle actually writes them", () => {
    // The inverse of the bug this file used to encode. Whichever state we are
    // in, the two versions may never appear as enclosure attributes: that shape
    // is what `stage-macos-release.mjs` is written to reject, and a feed
    // carrying it would be one this repository did not produce.
    if (asset) {
      expect(attribute(asset, "sparkle:shortVersionString")).toBeNull();
      expect(attribute(asset, "sparkle:version")).toBeNull();
    }
    for (const item of items) {
      expect(item).toMatch(/<sparkle:shortVersionString>[^<]+<\/sparkle:shortVersionString>/);
      expect(item).toMatch(/<sparkle:version>[^<]+<\/sparkle:version>/);
    }
  });
});
