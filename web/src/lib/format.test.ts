import { describe, it, expect } from "vitest";
import { formatRemaining, type DurUnits } from "./format";

const zh: DurUnits = { d: "天", h: "小时", m: "分钟" };
const en: DurUnits = { d: "d", h: "h", m: "m" };

describe("formatRemaining", () => {
  it("shows minutes only under an hour", () => {
    expect(formatRemaining(0, zh)).toBe("0分钟");
    expect(formatRemaining(59, zh)).toBe("0分钟"); // sub-minute rounds down
    expect(formatRemaining(60, zh)).toBe("1分钟");
    expect(formatRemaining(59 * 60, zh)).toBe("59分钟");
  });

  it("shows hours and minutes under a day", () => {
    expect(formatRemaining(3600, zh)).toBe("1小时 0分钟");
    expect(formatRemaining(3600 + 49 * 60, zh)).toBe("1小时 49分钟");
    expect(formatRemaining(23 * 3600 + 49 * 60, zh)).toBe("23小时 49分钟");
  });

  it("shows days and hours once past a day", () => {
    expect(formatRemaining(86400, zh)).toBe("1天 0小时");
    expect(formatRemaining(2 * 86400 + 3 * 3600, zh)).toBe("2天 3小时");
  });

  it("never goes negative", () => {
    expect(formatRemaining(-100, zh)).toBe("0分钟");
  });

  it("respects the given unit labels", () => {
    expect(formatRemaining(23 * 3600 + 49 * 60, en)).toBe("23h 49m");
    expect(formatRemaining(2 * 86400 + 3 * 3600, en)).toBe("2d 3h");
  });
});
