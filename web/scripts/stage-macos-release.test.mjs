import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { stageMacOSRelease } from "./stage-macos-release.mjs";

const work = [];

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "relayium-stage-macos-"));
  work.push(root);
  const webRoot = join(root, "web");
  await mkdir(join(webRoot, "public/apps/macos"), { recursive: true });
  await writeFile(
    join(webRoot, "native-releases.json"),
    '{"macos":{"available":false,"version":null,"build":null,"downloadUrl":null}}\n',
  );
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
    await mkdir(join(webRoot, "public/apps/macos"), { recursive: true });
    await writeFile(
      join(webRoot, "native-releases.json"),
      '{"macos":{"available":false,"version":null,"build":null,"downloadUrl":null}}\n',
    );
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
    await mkdir(join(webRoot, "public/apps/macos"), { recursive: true });
    await writeFile(
      join(webRoot, "native-releases.json"),
      '{"macos":{"available":false,"version":null,"build":null,"downloadUrl":null}}\n',
    );
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
