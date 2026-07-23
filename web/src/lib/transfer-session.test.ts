import { describe, it, expect } from "vitest";
import { wouldExceedDeclared } from "./transfer-session.svelte";

// 接收端唯一的"别写超过说好的字节数"闸门。它挡的是一个**不守协议的发送端**：
// manifest 声明每个文件多大，用户据此决定接不接收，但发送端完全可以多发（比如无视
// 接收端给出的续传点、从 0 重发整个文件）。链式哈希最终会对不上，可那是写完之后的
// 事——用户同意接收的是 N 字节，就不该被写入超过 N 字节。
describe("wouldExceedDeclared", () => {
  it("放行正好写满声明大小的那一块（边界必须是可达的）", () => {
    expect(wouldExceedDeclared(1000, 800, 200)).toBe(false);
  });
  it("放行中途的普通块", () => {
    expect(wouldExceedDeclared(50 * 1024 * 1024, 3 * 1024 * 1024, 192 * 1024)).toBe(false);
  });
  it("拦下多出一个字节的那一块", () => {
    expect(wouldExceedDeclared(1000, 800, 201)).toBe(true);
  });
  it("文件已经写满之后再来任何字节都算越界", () => {
    expect(wouldExceedDeclared(1000, 1000, 1)).toBe(true);
  });
  it("零字节文件收到任何数据都算越界", () => {
    expect(wouldExceedDeclared(0, 0, 1)).toBe(true);
    expect(wouldExceedDeclared(0, 0, 0)).toBe(false); // 空块不写任何东西，无所谓
  });
  it("manifest 里根本没有这个下标（发送端多发了一个文件）时一律拦下", () => {
    expect(wouldExceedDeclared(undefined, 0, 1)).toBe(true);
  });
});
