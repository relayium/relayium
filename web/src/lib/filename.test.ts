import { describe, it, expect } from "vitest";
import { stripBidi, safeDisplayName, sanitizeNames } from "./filename";

// 攻击载荷同样用码点构造，不在源码里敲真字符 —— 理由见 filename.ts 的注释。
const RLO = String.fromCodePoint(0x202e);
const PDI = String.fromCodePoint(0x2069);
const LRM = String.fromCodePoint(0x200e);

describe("stripBidi", () => {
  it("neutralises the classic RLO extension spoof", () => {
    // evil<RLO>gnp.exe renders as evilexe.png in any bidi-aware UI.
    expect(stripBidi(`evil${RLO}gnp.exe`)).toBe("evilgnp.exe");
  });
  it("removes every Bidi_Control code point", () => {
    expect(stripBidi(`a${LRM}b${PDI}c`)).toBe("abc");
  });
  it("leaves ordinary RTL text alone", () => {
    expect(stripBidi("مرحبا.pdf")).toBe("مرحبا.pdf");
    expect(stripBidi("报告.pdf")).toBe("报告.pdf");
  });
});

describe("safeDisplayName", () => {
  it("also strips C0/C1 controls that would break the list layout", () => {
    expect(safeDisplayName("a\r\nb\tc")).toBe("abc");
    expect(safeDisplayName(`x${String.fromCodePoint(0x7f)}y`)).toBe("xy");
  });
  it("is a no-op for a normal name", () => {
    expect(safeDisplayName("report 2026.pdf")).toBe("report 2026.pdf");
  });
});

describe("sanitizeNames", () => {
  it("cleans names and preserves the other fields", () => {
    expect(sanitizeNames([{ name: `a${RLO}b`, size: 7 }])).toEqual([{ name: "ab", size: 7 }]);
  });
});

describe("sanitizeNames 的 path", () => {
  it("逐段清洗 path —— 落盘名走的是它，不洗等于绕开整道防线", () => {
    expect(sanitizeNames([{ name: "a.png", path: `photos/evil${RLO}gnp.exe` }])).toEqual([
      { name: "a.png", path: "photos/evilgnp.exe" },
    ]);
  });
  it("保留 / 分隔符（整串洗会把目录结构压平）", () => {
    expect(sanitizeNames([{ name: "x", path: "a/b/c.txt" }])[0].path).toBe("a/b/c.txt");
  });
  it("每一段都洗，不只是最后一段", () => {
    expect(sanitizeNames([{ name: "x", path: `d${RLO}ir/sub${LRM}dir/f.txt` }])[0].path).toBe("dir/subdir/f.txt");
  });
  it("没有 path 的扁平文件保持不变", () => {
    const out = sanitizeNames([{ name: "flat.bin", size: 3 }]);
    expect(out).toEqual([{ name: "flat.bin", size: 3 }]);
    expect("path" in out[0]).toBe(false);
  });
});
