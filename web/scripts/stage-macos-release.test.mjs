import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { stageMacOSRelease } from "./stage-macos-release.mjs";

const work = [];

/// The policy every fixture starts from: nothing required, nothing recommended
/// beyond the release under test. Cases that care about the requirement pass
/// their own `macos` fields.
const BASE_POLICY = {
  policyRevision: 1,
  minimumSupportedVersion: "1.0",
  minimumSupportedBuild: 1,
  recommendedVersion: "1.0",
  latestVersion: "1.0",
};

/// An empty web tree: no release published, and the canonical client policy in
/// place. The policy is not optional — `stageMacOSRelease` refuses to derive a
/// critical-update threshold it cannot read, which is the behaviour a release
/// wants: a feed staged from a guess is worse than a release that stops.
async function writeWebRoot(webRoot, policy = {}) {
  await mkdir(join(webRoot, "public/apps/macos"), { recursive: true });
  await writeFile(
    join(webRoot, "native-releases.json"),
    '{"macos":{"available":false,"version":null,"build":null,"downloadUrl":null}}\n',
  );
  if (policy === null) return;
  await writeFile(
    join(webRoot, "native-client-policy.json"),
    `${JSON.stringify({ schema: 1, macos: { ...BASE_POLICY, ...policy } }, null, 2)}\n`,
  );
}

async function fixture(overrides = {}, policy = {}) {
  const root = await mkdtemp(join(tmpdir(), "relayium-stage-macos-"));
  work.push(root);
  const webRoot = join(root, "web");
  await writeWebRoot(webRoot, policy);
  // **The shape Sparkle actually writes**, transcribed from a real
  // `generate_appcast` run rather than assumed. The versions are CHILD ELEMENTS
  // of `<item>`; only the asset's own facts are enclosure attributes.
  //
  // This fixture previously rendered every field as an enclosure attribute, and
  // that single wrong assumption is why the release path shipped broken and
  // green: the parser and the fixture agreed with each other and neither agreed
  // with Sparkle. A first real release attempt failed at
  // "appcast short version does not match 1.0" with a notarization submission
  // already spent.
  const fields = {
    url: "https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg",
    "sparkle:version": "1",
    "sparkle:shortVersionString": "1.0",
    length: "42",
    "sparkle:edSignature": "signed-value",
    ...overrides,
  };
  const enclosureAttrs = ["url", "length", "sparkle:edSignature"]
    .filter((key) => fields[key] !== undefined && fields[key] !== "")
    .map((key) => `${key}="${fields[key]}"`)
    .join(" ");
  const itemChildren = ["sparkle:version", "sparkle:shortVersionString"]
    .filter((tag) => fields[tag] !== undefined && fields[tag] !== "")
    .map((tag) => `<${tag}>${fields[tag]}</${tag}>`)
    .join("");
  const appcastPath = join(root, "generated.xml");
  await writeFile(
    appcastPath,
    `<?xml version="1.0" standalone="yes"?>\n`
      + `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\n`
      + `    <channel>\n        <title>Relayium</title>\n        <item>\n`
      + `            <title>1.0</title>\n`
      + `            <pubDate>Thu, 06 Aug 2026 19:39:25 +0400</pubDate>\n`
      + `            ${itemChildren}\n`
      + `            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>\n`
      + `            <enclosure ${enclosureAttrs} type="application/octet-stream"/>\n`
      + `        </item>\n    </channel>\n</rss>\n`,
  );
  return { root, webRoot, appcastPath };
}

afterEach(async () => {
  await Promise.all(work.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("stageMacOSRelease", () => {
  it("atomically stages a signed, immutable release in the web tree", async () => {
    const { webRoot, appcastPath } = await fixture();
    const result = await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    expect(result).toMatchObject({ version: "1.0", build: "1" });
    const manifest = JSON.parse(await readFile(join(webRoot, "native-releases.json"), "utf8"));
    expect(manifest.macos).toEqual({
      available: true,
      version: "1.0",
      build: 1,
      downloadUrl: "https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg",
    });
    expect(await readFile(join(webRoot, "public/apps/macos/appcast.xml"), "utf8"))
      .toContain('sparkle:edSignature="signed-value"');
  });

  it.each([
    ["a mutable URL", { url: "https://github.com/relayium/relayium/releases/latest/download/Relayium.dmg" }],
    ["a missing signature", { "sparkle:edSignature": "" }],
    ["a mismatched version", { "sparkle:shortVersionString": "1.1" }],
    ["a non-numeric build", { "sparkle:version": "beta" }],
    ["a zero-length enclosure", { length: "0" }],
  ])("rejects %s without changing release state", async (_label, overrides) => {
    const { webRoot, appcastPath } = await fixture(overrides);

    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot })).rejects.toThrow();
    expect(JSON.parse(await readFile(join(webRoot, "native-releases.json"), "utf8")).macos.available)
      .toBe(false);
  });

  it("rejects a non-increasing build or reused immutable version", async () => {
    const { webRoot, appcastPath } = await fixture();
    await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    const nextAppcast = await fixture({
      url: "https://github.com/relayium/relayium/releases/download/macos-v1.1/Relayium.dmg",
      "sparkle:shortVersionString": "1.1",
    });
    await expect(stageMacOSRelease({
      version: "1.1",
      appcastPath: nextAppcast.appcastPath,
      webRoot,
    })).rejects.toThrow(/must be greater/);
    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot }))
      .rejects.toThrow(/already published/);
  });
});

/// **The half a hand edit cannot hold.**
///
/// `generate_appcast` writes a fresh feed from the DMG directory and knows
/// nothing about which builds the product still supports, so a
/// `<sparkle:criticalUpdate>` added to the published feed by hand is gone at the
/// next release — with nothing failing and every below-minimum user quietly
/// stopping being told their update is not optional. These cases exist because
/// that regression is invisible: the feed still validates, still installs, and
/// still updates everyone who asks.
describe("the critical-update threshold the release derives", () => {
  const criticalOf = (xml) =>
    xml.match(/<sparkle:criticalUpdate\b[^>]*?sparkle:version="([^"]*)"/)?.[1] ?? null;

  it("writes the canonical policy's build into the staged feed", async () => {
    const { webRoot, appcastPath } = await fixture(
      { "sparkle:version": "13" },
      { minimumSupportedBuild: 11 },
    );
    const result = await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    expect(result.criticalUpdateBuild).toBe(11);
    const staged = await readFile(join(webRoot, "public/apps/macos/appcast.xml"), "utf8");
    expect(criticalOf(staged)).toBe("11");
    // The threshold is added, and the asset it is added beside is untouched:
    // the enclosure's URL, length and signature are bound to a DMG that has
    // already been notarized and published, and re-signing is not something a
    // staging edit may imply.
    expect(staged).toContain('sparkle:edSignature="signed-value"');
    expect(staged).toContain('length="42"');
    expect(staged).toContain(
      'url="https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg"');
  });

  it("replaces a threshold the generator already carried instead of adding a second", async () => {
    const { root, webRoot } = await fixture({}, { minimumSupportedBuild: 1 });
    // A feed generated over a directory that already held a staged one. Two
    // `<sparkle:criticalUpdate>` elements in an item is a document whose meaning
    // depends on which one Sparkle reads first.
    const appcastPath = join(root, "regenerated.xml");
    await writeFile(
      appcastPath,
      `<?xml version="1.0" standalone="yes"?>\n`
        + `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">\n`
        + `    <channel>\n        <title>Relayium</title>\n        <item>\n`
        + `            <sparkle:version>1</sparkle:version>\n`
        + `            <sparkle:shortVersionString>1.0</sparkle:shortVersionString>\n`
        + `            <sparkle:criticalUpdate sparkle:version="99"/>\n`
        + `            <enclosure url="https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg"`
        + ` length="42" type="application/octet-stream" sparkle:edSignature="signed-value"/>\n`
        + `        </item>\n    </channel>\n</rss>\n`,
    );

    await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });
    const staged = await readFile(join(webRoot, "public/apps/macos/appcast.xml"), "utf8");
    expect(staged.match(/<sparkle:criticalUpdate\b/g)).toHaveLength(1);
    expect(criticalOf(staged)).toBe("1");
  });

  it("refuses a threshold above the release, which would be critical against itself", async () => {
    const { webRoot, appcastPath } = await fixture(
      { "sparkle:version": "13" },
      { minimumSupportedBuild: 14 },
    );
    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot }))
      .rejects.toThrow(/above the released build/);
    expect(JSON.parse(await readFile(join(webRoot, "native-releases.json"), "utf8")).macos.available)
      .toBe(false);
  });

  it("refuses a recommendation above the release", async () => {
    const { webRoot, appcastPath } = await fixture({}, { recommendedVersion: "1.1" });
    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot }))
      .rejects.toThrow(/above the released/);
  });

  it.each([
    ["no policy at all", null],
    ["a policy with no macos section", { schema: 1 }],
    ["a future schema", { schema: 2, macos: BASE_POLICY }],
    ["a non-integer build", { schema: 1, macos: { ...BASE_POLICY, minimumSupportedBuild: "11" } }],
    ["a build below one", { schema: 1, macos: { ...BASE_POLICY, minimumSupportedBuild: 0 } }],
    ["an unreadable version", {
      schema: 1, macos: { ...BASE_POLICY, minimumSupportedVersion: "1.2.4-beta" },
    }],
    ["a minimum above its own recommendation", {
      schema: 1, macos: { ...BASE_POLICY, minimumSupportedVersion: "2.0" },
    }],
  ])("stops the release on %s rather than guessing one", async (_label, document) => {
    const { webRoot, appcastPath } = await fixture();
    const path = join(webRoot, "native-client-policy.json");
    if (document === null) await rm(path);
    else await writeFile(path, `${JSON.stringify(document)}\n`);

    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot })).rejects.toThrow();
    expect(JSON.parse(await readFile(join(webRoot, "native-releases.json"), "utf8")).macos.available)
      .toBe(false);
  });

  /// The requirement fields are a product decision. A release publishes an
  /// artifact; it does not get to raise or lower what users are required to run,
  /// and the one field it does own is the one that says what was published.
  it("carries the requirement through untouched and moves only the published version", async () => {
    const { webRoot, appcastPath } = await fixture({}, {
      policyRevision: 4,
      minimumSupportedVersion: "1.0",
      minimumSupportedBuild: 1,
      recommendedVersion: "1.0",
      latestVersion: "0.9",
    });
    await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    const expected = {
      schema: 1,
      macos: {
        // The document changed, so the revision advanced — by one, and once.
        policyRevision: 5,
        minimumSupportedVersion: "1.0",
        minimumSupportedBuild: 1,
        recommendedVersion: "1.0",
        latestVersion: "1.0",
      },
    };
    const canonical = await readFile(join(webRoot, "native-client-policy.json"), "utf8");
    const published = await readFile(join(webRoot, "public/apps/macos/client-policy.json"), "utf8");
    expect(JSON.parse(canonical)).toEqual(expected);
    // Byte-for-byte, not merely equal as JSON: the client fetches one of these
    // two files and a person edits the other, and a difference in spelling is a
    // difference nobody would look for.
    expect(published).toBe(canonical);
  });
});

/// **The number that makes the served policy un-replayable.**
///
/// A client remembers the highest `policyRevision` it has accepted and refuses
/// anything below it — that is what stops a valid, correctly served copy of an
/// older policy from unblocking a client that has since been told something
/// stricter. Two properties have to hold at once, and they pull in opposite
/// directions: a changed document must carry a NEW revision, or the fleet
/// declines it; an unchanged document must carry the SAME one, or the publish
/// job's recovery rerun — which requires re-deriving to reproduce `main` byte
/// for byte — turns into a fresh diff on every attempt.
describe("the policy revision a release advances", () => {
  const revisionOf = async (webRoot) =>
    JSON.parse(await readFile(join(webRoot, "native-client-policy.json"), "utf8"))
      .macos.policyRevision;

  it("advances the revision exactly once when it moves the published version", async () => {
    const { webRoot, appcastPath } = await fixture({}, { policyRevision: 7, latestVersion: "0.9" });
    const result = await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    expect(result.policyRevision).toBe(8);
    expect(await revisionOf(webRoot)).toBe(8);
    // Both copies, from the same bytes — the client fetches the published one.
    expect(await readFile(join(webRoot, "public/apps/macos/client-policy.json"), "utf8"))
      .toBe(await readFile(join(webRoot, "native-client-policy.json"), "utf8"));
  });

  /// The recovery path. A release that failed downstream is re-staged from the
  /// same inputs, and the metadata candidate it re-derives must come out EMPTY
  /// against a tree that already documents this version. A revision that climbed
  /// on every attempt would turn each retry into a diff, and there is no clock
  /// or counter here to make it idempotent for us — so the test is the document:
  /// same `latestVersion`, same revision, same bytes.
  it("preserves the revision when the policy already names this release", async () => {
    const { webRoot, appcastPath } = await fixture({}, { policyRevision: 7, latestVersion: "1.0" });
    const before = await readFile(join(webRoot, "native-client-policy.json"), "utf8");

    const result = await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });

    expect(result.policyRevision).toBe(7);
    // Byte for byte, which is the property the rerun actually depends on.
    expect(await readFile(join(webRoot, "native-client-policy.json"), "utf8")).toBe(before);
  });

  /// Derived from the inputs alone. A rerun happens in a fresh checkout, so
  /// "does not advance" has to hold across runs that share no state — which it
  /// only can if nothing here reads a clock, a counter or the previous run.
  it("derives the same revision from the same inputs in an unrelated run", async () => {
    const staged = [];
    for (const _attempt of [1, 2]) {
      const { webRoot, appcastPath } = await fixture({}, { policyRevision: 7, latestVersion: "0.9" });
      await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });
      staged.push(await readFile(join(webRoot, "native-client-policy.json"), "utf8"));
    }
    expect(staged[1]).toBe(staged[0]);
    expect(JSON.parse(staged[0]).macos.policyRevision).toBe(8);
  });

  it.each([
    ["absent", undefined],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "1"],
    ["above the ceiling clients read", 1000000001],
    ["beyond a safe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("stops the release on a %s revision rather than publishing one", async (_label, revision) => {
    const { webRoot, appcastPath } = await fixture();
    const path = join(webRoot, "native-client-policy.json");
    const macos = { ...BASE_POLICY, policyRevision: revision };
    if (revision === undefined) delete macos.policyRevision;
    await writeFile(path, `${JSON.stringify({ schema: 1, macos })}\n`);

    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot }))
      .rejects.toThrow(/policyRevision/);
    // Nothing was published: the manifest is the release's own switch, and a
    // policy the fleet would decline must not take the release with it.
    expect(JSON.parse(await readFile(join(webRoot, "native-releases.json"), "utf8")).macos.available)
      .toBe(false);
  });

  it("refuses to advance past the ceiling clients will read", async () => {
    const { webRoot, appcastPath } = await fixture(
      {}, { policyRevision: 1000000000, latestVersion: "0.9" });
    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot }))
      .rejects.toThrow(/would exceed 1000000000/);
  });
});

describe("the appcast shape this parser assumes", () => {
  /// Verbatim output from a real `generate_appcast` run (Sparkle 2, the version
  /// pinned by `Package.resolved`) against a real Relayium.dmg, captured
  /// 2026-08-06. Only the URL prefix and the signature were substituted.
  ///
  /// It exists because the previous fixture was written from the parser's
  /// assumption rather than from Sparkle, so the two agreed with each other and
  /// the release path was green and unusable. This one cannot drift in that
  /// direction: it is what the tool emitted, and if a future Sparkle emits
  /// something else, this is the test that says so.
  const REAL_SPARKLE_OUTPUT = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Relayium</title>
        <item>
            <title>1.0</title>
            <pubDate>Thu, 06 Aug 2026 19:39:25 +0400</pubDate>
            <sparkle:version>1</sparkle:version>
            <sparkle:shortVersionString>1.0</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <enclosure url="https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg" length="21095080" type="application/octet-stream" sparkle:edSignature="real-signature"/>
        </item>
    </channel>
</rss>
`;

  it("accepts what generate_appcast actually writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayium-stage-real-"));
    work.push(root);
    const webRoot = join(root, "web");
    await writeWebRoot(webRoot);
    const appcastPath = join(root, "generated.xml");
    await writeFile(appcastPath, REAL_SPARKLE_OUTPUT);

    const result = await stageMacOSRelease({ version: "1.0", appcastPath, webRoot });
    expect(result).toMatchObject({ version: "1.0", build: "1" });

    // And the staged copy is re-readable by the same parser, which is what the
    // second release's monotonicity check depends on.
    const staged = await readFile(join(webRoot, "public/apps/macos/appcast.xml"), "utf8");
    expect(staged).toContain("<sparkle:version>1</sparkle:version>");
    expect(staged).toContain("<sparkle:shortVersionString>1.0</sparkle:shortVersionString>");
  });

  /// The versions are child elements. If this ever passes with them written as
  /// enclosure attributes, the parser has grown a fallback that would hide the
  /// next shape change.
  it("rejects the enclosure-attribute shape the parser once assumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayium-stage-attrs-"));
    work.push(root);
    const webRoot = join(root, "web");
    await writeWebRoot(webRoot);
    const appcastPath = join(root, "generated.xml");
    await writeFile(
      appcastPath,
      `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>`
        + `<enclosure url="https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg"`
        + ` sparkle:version="1" sparkle:shortVersionString="1.0" length="42" sparkle:edSignature="x"/>`
        + `</item></channel></rss>\n`,
    );

    await expect(stageMacOSRelease({ version: "1.0", appcastPath, webRoot })).rejects.toThrow();
  });
});
