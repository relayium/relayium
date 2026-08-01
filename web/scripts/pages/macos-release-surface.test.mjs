import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import apps from "./content/apps.mjs";

describe("macOS release surface", () => {
  it("keeps the SPA download state tied to the canonical manifest", async () => {
    const [component, app, manifestText] = await Promise.all([
      readFile(resolve(process.cwd(), "src/lib/AppsPage.svelte"), "utf8"),
      readFile(resolve(process.cwd(), "src/App.svelte"), "utf8"),
      readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);

    expect(component).toContain('import releases from "../../native-releases.json"');
    // AppsPage accepts a test seam, but its production default remains the one
    // canonical build-time manifest. Availability fails closed unless both the
    // release bit and an exact URL are present, then the card moves sections.
    expect(component).toContain("macRelease = releases.macos");
    expect(component).toContain("macRelease.available === true && !!macRelease.downloadUrl");
    expect(component).toMatch(/macAvailable\s*\?\s*macRelease\.downloadUrl!/);
    expect(app.match(/<AppsPage\b[^>]*>/g)).toEqual(["<AppsPage />"]);
    expect(component).toContain("t.appsPage.cards.mac.cta");
    expect(manifest.macos.available).toBe(false);
    expect(manifest.macos.build).toBeNull();
    expect(manifest.macos.downloadUrl).toBeNull();
  });

  it("has a localized macOS download CTA in every SPA locale", async () => {
    for (const code of LANGS) {
      const source = await readFile(resolve(process.cwd(), `src/lib/i18n/${code}.ts`), "utf8");
      const macCard = source.match(/mac:\s*\{[\s\S]*?\},\s*(?:\n\s*)?ios:/)?.[0] ?? "";
      expect(macCard, `${code} is missing its macOS card`).toContain("cta:");
      expect(macCard, `${code} still describes the macOS app as in development`)
        .not.toMatch(/in the works|正在开发|開発中|개발 중|in Arbeit|en cours de développement|قيد التطوير|en desarrollo|em desenvolvimento/i);
    }
  });

  it("keeps localized crawler copy honest before the public release", async () => {
    const source = await readFile(resolve(process.cwd(), "scripts/pages/content/apps.mjs"), "utf8");
    expect(source).not.toMatch(
      /macOS app — a real native app, coming soon|macOS 应用——真正的原生应用，即将推出|macOS アプリ — 本物のネイティブアプリ、近日公開|macOS 앱 — 진짜 네이티브 앱, 출시 예정|macOS-App — eine echte native App, in Kürze|Appli macOS — une vraie appli native, bientôt disponible|تطبيق macOS — تطبيق أصلي حقيقي، قريبًا|App de macOS — una auténtica app nativa, próximamente|App para macOS — um verdadeiro app nativo, em breve/,
    );
    for (const code of LANGS) {
      const doc = apps.langs[code];
      expect(doc.nativeDownload, `${code} exposes a download before release`).toBeUndefined();
      expect(
        `${doc.how.steps[2]} ${doc.why.items[2].desc}`,
        `${code} does not disclose that the candidate is not public`,
      ).toMatch(/not publicly|尚未开放|まだ一般公開|아직 공개|noch nicht öffentlich|pas encore|ليست متاحة|aún no|ainda não/i);
    }
  });
});
