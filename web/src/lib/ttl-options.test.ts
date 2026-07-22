import { describe, it, expect } from "vitest";
import { TTL_CHOICES, allowedTtls, clampTtl } from "./ttl-options";

// 这些测试盯的是一个静默失败：服务端 (files.go / uploads_resumable.go) 会把超出
// 档位上限的 TTL 直接截断，不报错也不提示。界面因此绝不能提供一个服务端会打折
// 的选项——免费档 1 天时选「7 天」实际只得 1 天，用户无从察觉。
describe("allowedTtls", () => {
  it("offers everything when the plan has no retention cap", () => {
    expect(allowedTtls(0)).toEqual([...TTL_CHOICES]);
  });

  it("drops options the server would silently truncate", () => {
    // free = 1 天：只剩 1 小时和 1 天。
    expect(allowedTtls(86400)).toEqual([3600, 86400]);
    // plus = 3 天：7 天必须消失。
    expect(allowedTtls(3 * 86400)).toEqual([3600, 86400, 259200]);
    // pro = 7 天：14 天必须消失。
    expect(allowedTtls(7 * 86400)).toEqual([3600, 86400, 259200, 604800]);
  });

  it("keeps an option exactly equal to the cap", () => {
    // 边界：cap 恰好等于某个选项时该选项必须保留，服务端不会截断它。
    expect(allowedTtls(259200)).toContain(259200);
  });

  it("offers the whole ladder to the top tier", () => {
    // max = 14 天，正好等于最长一挡：五挡全部可选。
    expect(allowedTtls(14 * 86400)).toEqual([...TTL_CHOICES]);
  });

  it("keeps a cap above the largest option from adding choices", () => {
    // 上限比最长选项还大时不该凭空多出选项。
    expect(allowedTtls(30 * 86400)).toEqual([...TTL_CHOICES]);
  });

  it("never returns an empty list", () => {
    // 管理员把某档留存设成小于 1 小时时，没有任何选项合规。宁可留最小的一个，
    // 也不能渲染一个空的下拉框（那会让用户完全无法上传）。
    expect(allowedTtls(60)).toEqual([3600]);
  });
});

describe("clampTtl", () => {
  it("keeps a still-valid selection", () => {
    expect(clampTtl(86400, [3600, 86400])).toBe(86400);
  });

  it("pulls a now-forbidden selection down to the longest allowed", () => {
    // 关键回归：默认值是 1 天，但用户可能已经选了 7 天，之后 usage 才返回、档位
    // 才知道。若只过滤 <option> 而不动已选值，bind:value 会停在 604800——下拉框
    // 显示空白，提交的却仍是服务端会截断的那个值。
    expect(clampTtl(604800, [3600, 86400])).toBe(86400);
    expect(clampTtl(1209600, [3600, 86400, 259200, 604800])).toBe(604800);
  });

  it("falls back to the only option when the plan allows just one", () => {
    expect(clampTtl(604800, [3600])).toBe(3600);
  });
});
