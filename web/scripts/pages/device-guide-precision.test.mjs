import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import computers from "./content/articles/howto-send-files-between-computers.mjs";
import pcPhone from "./content/articles/howto-pc-to-phone-wirelessly.mjs";
import qrCode from "./content/articles/howto-transfer-by-qr-code.mjs";

describe("device guide path and SAS precision", () => {
  it("keeps the computer guide's LAN and TURN boundary in every locale", () => {
    const lanTokens = {
      en: /same LAN/i,
      zh: /同一局域网/,
      ja: /同じ LAN/i,
      ko: /같은 LAN/i,
      de: /selben LAN/i,
      fr: /même LAN/i,
      ar: /شبكة LAN نفسها/u,
      es: /misma LAN/i,
      pt: /mesma LAN/i,
    };

    for (const lang of LANGS) {
      const copy = JSON.stringify(computers.langs[lang]);
      expect(copy, `${lang}: LAN`).toMatch(lanTokens[lang]);
      expect(copy, `${lang}: TURN`).toMatch(/TURN/i);
    }

    const en = JSON.stringify(computers.langs.en);
    expect(en).toMatch(/directly on the same LAN/i);
    expect(en).toMatch(/cannot read or decrypt/i);
    expect(en).toMatch(/no server-side realtime content copy or history/i);
    expect(en).not.toMatch(/connects your browser directly to theirs, wherever/i);
  });

  it("describes SAS as endpoint-key authentication, not a relay-free path", () => {
    for (const lang of LANGS) {
      expect(JSON.stringify(computers.langs[lang]), `${lang}: computer SAS`).toMatch(/SAS/i);
      expect(JSON.stringify(pcPhone.langs[lang]), `${lang}: PC-phone SAS`).toMatch(/SAS/i);
      expect(JSON.stringify(qrCode.langs[lang]), `${lang}: QR SAS`).toMatch(/SAS/i);
    }

    const computersEn = JSON.stringify(computers.langs.en);
    const pcPhoneEn = JSON.stringify(pcPhone.langs.en);
    const qrEn = JSON.stringify(qrCode.langs.en);
    expect(computersEn).toMatch(/keys were not replaced/i);
    expect(computersEn).toMatch(/does not prove which network path/i);
    expect(pcPhoneEn).toMatch(/has not impersonated either endpoint/i);
    expect(qrEn).toMatch(/keys weren't replaced/i);
    expect(qrEn).toMatch(/has not impersonated either endpoint/i);
    expect(computersEn).not.toMatch(/with no one in between/i);
    expect(pcPhoneEn).not.toMatch(/confirm no one is in the middle/i);
    expect(qrEn).not.toMatch(/catch a malicious relay standing in the middle/i);
  });

  it("publishes the current revision date for all three guides", () => {
    for (const article of [computers, pcPhone, qrCode]) {
      expect(article.updated, article.slug).toBe("2026-08-05");
    }
  });
});
