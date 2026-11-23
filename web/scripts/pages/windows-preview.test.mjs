import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateWithAndroidManifest, WEB_ROOT } from "./android-manifest-fixture.mjs";
const android = JSON.parse(readFileSync(join(WEB_ROOT, "android-release.json"), "utf8"));
const preview = { schema: 1, windows: { available: true, version: "0.0.4", architecture: "x64", signed: false,
  preview: true, sha256: "a".repeat(64), size: 123456,
  downloadUrl: "https://github.com/relayium/relayium/releases/download/windows-v0.0.4/Relayium-0.0.4-x64.exe" } };

function rendered(manifest) {
  return generateWithAndroidManifest(android, `
    const apps = (await import(IMPORTS.apps)).default;
    const { renderModePage } = await import(IMPORTS.modeTemplate);
    const { proseBody } = await import(IMPORTS.shells);
    process.stdout.write(JSON.stringify({ langs: apps.langs,
      zhHTML: renderModePage({ slug: "apps", lang: "zh", doc: apps.langs.zh, updated: apps.updated }),
      enHTML: proseBody(apps.langs.en) }));
  `, manifest);
}

describe("Windows preview on the generated Apps surfaces", () => {
  it("adds the exact download and unsigned limits to both maintained documents only", () => {
    const data = rendered(preview);
    for (const lang of ["en", "zh"]) {
      const doc = data.langs[lang];
      expect(doc.windowsDownload.href).toBe(preview.windows.downloadUrl);
      expect(doc.windowsDownload.label).toContain("0.0.4");
      expect(JSON.stringify(doc)).toMatch(lang === "en" ? /unsigned/ : /未签名/);
      expect(JSON.stringify(doc)).not.toMatch(/publishes no Windows app|不提供 Windows 原生应用/);
    }
    for (const html of [data.zhHTML, data.enHTML]) {
      expect(html).toContain(`href="${preview.windows.downloadUrl}"`);
      expect(html).toContain("0.0.4");
    }
    for (const lang of ["ja", "ko", "de", "fr", "ar", "es", "pt"]) {
      expect(data.langs[lang].windowsDownload).toBeUndefined();
    }
  });
  it.each([
    { available: false }, { sha256: null }, { sha256: "invalid" }, { size: 0 }, { downloadUrl: "" }, { version: "" },
  ])("does not offer an unverified or unavailable installer: %j", (change) => {
    const data = rendered({ ...preview, windows: { ...preview.windows, ...change } });
    for (const lang of ["en", "zh"]) expect(data.langs[lang].windowsDownload).toBeUndefined();
  });
});
