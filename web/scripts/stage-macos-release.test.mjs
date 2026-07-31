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
  const attrs = {
    url: "https://github.com/relayium/relayium/releases/download/macos-v1.0/Relayium.dmg",
    "sparkle:version": "1",
    "sparkle:shortVersionString": "1.0",
    length: "42",
    "sparkle:edSignature": "signed-value",
    ...overrides,
  };
  const rendered = Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(" ");
  const appcastPath = join(root, "generated.xml");
  await writeFile(
    appcastPath,
    `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><enclosure ${rendered} /></item></channel></rss>\n`,
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
