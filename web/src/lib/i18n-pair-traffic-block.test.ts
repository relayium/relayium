import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };

// The copy that replaces the mint button when this month's cross-network
// allowance is spent (B3).
//
// It is the one screen in the product that has to state a limit and a way out in
// the same breath, and it is very easy to get subtly wrong in eight languages
// after getting it right in one. Three claims have to hold in every locale, and
// each of them is a thing a plausible translation gets wrong:
//
//  1. It must offer LAN as the way through. LAN is genuinely unaffected — it is
//     the only path that moves no bytes through Relayium at all — and without
//     naming it the screen is a dead end with an upsell on it.
//  2. It must NOT offer the stored / async / "upload it and send a link" path.
//     That path is metered by the SAME combined meter (relay + stored
//     upload/download), so it is exactly as unavailable as the live relay. A
//     locale that reaches for "offline transfer" as the friendly alternative is
//     sending the user to a second refusal.
//  3. It must not blame storage. Storage capacity and the daily upload quota do
//     not stop a live relay session and are not what this screen is about; the
//     server deliberately does not consult them before minting (pairmint.go).
describe("the traffic-exhausted pairing screen", () => {
  it("has both strings, trimmed and non-empty, in every locale", () => {
    for (const [lang, m] of Object.entries(locales)) {
      expect(m.pair.trafficBlocked, `${lang}.pair.trafficBlocked`).toBeTruthy();
      expect(m.pair.trafficBlocked, `${lang}: trimmed`).toBe(m.pair.trafficBlocked.trim());
      expect(m.pair.trafficBlockedLan, `${lang}.pair.trafficBlockedLan`).toBeTruthy();
      expect(m.pair.trafficBlockedLan, `${lang}: trimmed`).toBe(m.pair.trafficBlockedLan.trim());
      // The LAN control is a button label, not a paragraph.
      expect(m.pair.trafficBlockedLan.length, `${lang}: the LAN action is a label`).toBeLessThan(48);
    }
  });

  it("names the local network as the way through, in each locale's own words", () => {
    const localNetwork: Record<string, RegExp> = {
      en: /local network/i,
      zh: /局域网/,
      ja: /ローカルネットワーク/,
      ko: /로컬 네트워크/,
      de: /lokale[sn]? Netzwerk/i,
      fr: /réseau local/i,
      ar: /الشبكة المحلية/u,
      es: /red local/i,
      pt: /rede local/i,
    };
    for (const [lang, m] of Object.entries(locales)) {
      expect(m.pair.trafficBlocked, `${lang}: the explanation offers LAN`).toMatch(localNetwork[lang]);
      expect(m.pair.trafficBlockedLan, `${lang}: the action names LAN`).toMatch(localNetwork[lang]);
    }
  });

  // The two things this copy must never say. Both are honest-looking mistakes:
  // the stored path IS metered by the same allowance, and storage capacity has
  // nothing to do with why the mint was refused.
  it("does not offer the stored/async path, and does not blame storage", () => {
    const forbidden: Record<string, RegExp> = {
      en: /offline|stored|storage|download link/i,
      zh: /离线|暂存|存储|下载链接/,
      ja: /オフライン|保管|ストレージ|ダウンロードリンク/,
      ko: /오프라인|보관|저장|다운로드 링크/,
      de: /offline|Speicher|Downloadlink/i,
      fr: /hors ligne|stockage|lien de téléchargement/i,
      ar: /دون اتصال|التخزين|رابط التنزيل/u,
      es: /sin conexión|almacenamiento|enlace de descarga/i,
      pt: /offline|armazenamento|link de download/i,
    };
    for (const [lang, m] of Object.entries(locales)) {
      expect(m.pair.trafficBlocked, `${lang}: must not send the user to a second refusal`)
        .not.toMatch(forbidden[lang]);
      expect(m.pair.trafficBlockedLan, `${lang}: the LAN action must be LAN`)
        .not.toMatch(forbidden[lang]);
    }
  });
});
