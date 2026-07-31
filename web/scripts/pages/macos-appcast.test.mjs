import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS Sparkle appcast", () => {
  it("matches the canonical native-release manifest", async () => {
    const source = resolve(process.cwd(), "public/apps/macos/appcast.xml");
    const appcast = await readFile(source, "utf8");
    const manifest = JSON.parse(
      await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
    );

    expect(appcast).toContain('<rss version="2.0"');
    expect(appcast).toContain('xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"');
    expect(appcast).toContain("<channel>");
    expect(appcast).toContain("<title>Relayium for macOS updates</title>");

    if (manifest.macos.available) {
      expect(manifest.macos.version).toMatch(/^[0-9]+(?:\.[0-9]+){1,2}/);
      expect(manifest.macos.build).toBeGreaterThan(0);
      expect(manifest.macos.downloadUrl).toBe(
        `https://github.com/relayium/relayium/releases/download/macos-v${manifest.macos.version}/Relayium.dmg`,
      );
      expect(appcast).toContain("<enclosure");
      expect(appcast).toContain(`url="${manifest.macos.downloadUrl}"`);
      expect(appcast).toContain(`sparkle:shortVersionString="${manifest.macos.version}"`);
      expect(appcast).toMatch(/sparkle:edSignature="[^"]+"/);
    } else {
      expect(manifest.macos).toEqual({
        available: false,
        version: null,
        build: null,
        downloadUrl: null,
      });
      expect(appcast).not.toContain("<enclosure");
      expect(appcast).not.toContain("sparkle:edSignature");
    }
  });
});
