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

  // 十个十进制数字，一个不多一个不少。少一个就有服务端签发的码在这里输不进去；
  // 多任何一个非数字字符，数字键盘（inputmode="numeric"）就再也打不完整个码。
  it("正好是 0-9 这十个数字", () => {
    expect(CODE_ALPHABET).toBe("0123456789");
    for (const d of "0123456789") {
      expect(CODE_ALPHABET.includes(d), `${d} 必须在字母表里`).toBe(true);
    }
  });
});

describe("isValidCode", () => {
  it("接受形状合法的码", () => {
    expect(isValidCode("424242")).toBe(true);
    expect(isValidCode("000000")).toBe(true); // 全零是一个普通的码
    expect(isValidCode("012345")).toBe(true); // 前导零必须保留：码是字符串不是整数
    expect(isValidCode("111111")).toBe(true);
  });
  it("拒绝长度不对、非数字、以及旧字母表的码", () => {
    for (const bad of ["", "12345", "1234567", "K7M3X9", "A12345", "12345a", "12 345", "12345!", "+12345", "１２３４５６"]) {
      expect(isValidCode(bad), `${bad} 应当无效`).toBe(false);
    }
  });
});

describe("normalizeCode", () => {
  it("只留数字，丢掉粘贴时带进来的空格与连字符", () => {
    expect(normalizeCode("483-920")).toBe("483920");
    expect(normalizeCode(" 48 39 20 ")).toBe("483920");
  });
  it("保留前导零", () => {
    expect(normalizeCode("004291")).toBe("004291");
    expect(normalizeCode("000000")).toBe("000000");
  });
  it("丢掉字母而不是映射它们", () => {
    // O→0 / I→1 这类映射不做：抄错的人真正想输的是别的数字，悄悄替换成一个
    // 错码比让他重看一眼那一位更糟。旧字母表的码整个化为空串，这是对的——
    // 它已经不可能是一个码了。
    expect(normalizeCode("48392O")).toBe("48392");
    expect(normalizeCode("K7M3X9")).toBe("739");
    expect(normalizeCode("ACDEFH")).toBe("");
  });
  it("丢掉全角数字（它们不是服务端接受的字符）", () => {
    expect(normalizeCode("１２３４５６")).toBe("");
  });
  it("截断到码长（粘贴多余内容不会顶掉前面）", () => {
    expect(normalizeCode("483920999")).toBe("483920");
  });
});
