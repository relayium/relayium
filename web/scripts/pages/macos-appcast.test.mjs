import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS Sparkle appcast", () => {
  it("publishes a valid inert feed until the first signed release exists", async () => {
    const source = resolve(process.cwd(), "public/apps/macos/appcast.xml");
    const appcast = await readFile(source, "utf8");

    expect(appcast).toContain('<rss version="2.0"');
    expect(appcast).toContain('xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"');
    expect(appcast).toContain("<channel>");
    expect(appcast).toContain("<title>Relayium for macOS updates</title>");
    expect(appcast).not.toContain("<enclosure");
    expect(appcast).not.toContain("sparkle:edSignature");
  });
});
