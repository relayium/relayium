import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CODE_ALPHABET, CODE_LEN, isValidCode, normalizeCode } from "./pair-code";

describe("配对码字母表", () => {
  // 两端不一致的表现是"界面让你输、服务端说无效"，而且只在某些字符上复现——
  // 这种 bug 查起来极贵，所以直接读 Go 源码比对，而不是各写一份常量各自相信。
  it("与服务端 (signal/pair.go) 逐字一致", () => {
    const go = readFileSync(resolve(process.cwd(), "../server/internal/signal/pair.go"), "utf8");
    const alphabet = /const CodeAlphabet = "([^"]+)"/.exec(go);
    const len = /const CodeLen = (\d+)/.exec(go);
    expect(alphabet, "pair.go 里找不到 CodeAlphabet").not.toBeNull();
    expect(len, "pair.go 里找不到 CodeLen").not.toBeNull();
    expect(alphabet![1]).toBe(CODE_ALPHABET);
    expect(Number(len![1])).toBe(CODE_LEN);
  });

  it("每一对易混字符只留一个", () => {
    for (const [a, b] of ["B8", "G6", "S5", "Z2", "QO", "UV", "I1", "L1", "O0"]) {
      expect(
        CODE_ALPHABET.includes(a) && CODE_ALPHABET.includes(b),
        `${a} 和 ${b} 不能同时在字母表里`,
      ).toBe(false);
    }
  });

  it("24 个字符、全大写、无重复", () => {
    expect(CODE_ALPHABET.length).toBe(24);
    expect(CODE_ALPHABET).toBe(CODE_ALPHABET.toUpperCase());
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

describe("isValidCode", () => {
  it("接受形状合法的码", () => {
    expect(isValidCode("K7M3X9")).toBe(true);
    expect(isValidCode("424242")).toBe(true); // 纯数字仍然合法（都在字母表里）
  });
  it("拒绝长度不对、字母表之外、以及小写", () => {
    for (const bad of ["", "K7M3X", "K7M3X92", "K7M3X0", "K7M3X1", "K7M3XB", "k7m3x9", "K7M3X!"]) {
      expect(isValidCode(bad), `${bad} 应当无效`).toBe(false);
    }
  });
});

describe("normalizeCode", () => {
  it("转大写", () => {
    expect(normalizeCode("k7m3x9")).toBe("K7M3X9");
  });
  it("丢掉粘贴时带进来的空格与连字符", () => {
    expect(normalizeCode("K7M-3X9")).toBe("K7M3X9");
    expect(normalizeCode(" K7 M3 X9 ")).toBe("K7M3X9");
  });
  it("丢掉字母表之外的字符，而不是映射它们", () => {
    // 0/1/O/I/L 都不在字母表里。把 O 映成 0 只会得到一个必然无效的码，
    // 不如直接丢掉、让用户重看一眼那一位。
    expect(normalizeCode("K7M3XO")).toBe("K7M3X");
    expect(normalizeCode("K7M3X0")).toBe("K7M3X");
    expect(normalizeCode("K7M3XB")).toBe("K7M3X");
  });
  it("截断到码长（粘贴多余内容不会顶掉前面）", () => {
    expect(normalizeCode("K7M3X9EXTRA")).toBe("K7M3X9");
  });
});
