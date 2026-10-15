import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

// The speed setting must never promise what spacing requests cannot deliver.
describe("upload speed copy", () => {
  const locales = { en, zh };
  it("is complete in both maintained languages", () => {
    for (const [lang, m] of Object.entries(locales)) {
      for (const [k, v] of Object.entries(m.speed)) {
        if (typeof v === "string") expect(v.trim().length, `${lang}.${k}`).toBeGreaterThan(0);
      }
      expect(m.speed.etaLine(30), lang).not.toBe(m.speed.etaLine(600));
    }
  });

  it("makes no zero-impact or guaranteed-speed claim", () => {
    const banned = [/no (effect|impact)/i, /won't affect/i, /guarantee/i, /不会影响/, /保证/, /零影响/];
    for (const [lang, m] of Object.entries(locales)) {
      const text = Object.values(m.speed).filter((v) => typeof v === "string").join(" ");
      for (const b of banned) expect(text, `${lang} ${b}`).not.toMatch(b);
    }
  });

  it("states the burst limitation, shared live/cloud cap and cloud-only background", () => {
    expect(en.speed.capNote).toMatch(/full network speed/);
    expect(zh.speed.capNote).toMatch(/全速/);
    expect(en.speed.scope).toMatch(/shared by encrypted cloud uploads and live file transfers/);
    expect(en.speed.scope).toMatch(/cloud uploads only/);
    expect(zh.speed.scope).toMatch(/加密云端上传和实时文件传输共享/);
    expect(zh.speed.scope).toMatch(/仅用于云端上传/);
  });

  it("formats remaining time at minute resolution above a minute", () => {
    expect(en.speed.etaLine(59)).toBe("less than a minute left");
    expect(en.speed.etaLine(125)).toBe("about 2 min left");
    expect(en.speed.etaLine(5400)).toBe("about 1.5 h left");
    expect(zh.speed.etaLine(125)).toBe("剩余约 2 分钟");
  });
});
