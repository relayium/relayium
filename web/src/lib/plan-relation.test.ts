import { describe, it, expect } from "vitest";
import { planRelation } from "./plan-relation";

// 计费周期是和档位正交的第二个维度。原来 Pricing.svelte 只比档位 ID，导致月付
// 用户把开关切到「年付」后，自己那一档仍然显示「当前套餐」且不可点 —— 改成年付
// 一次性付清这个操作在界面上根本不存在。服务端已经能处理了，这里是 UI 侧的对应
// 判定。
const PLUS = { tierId: "plus", tierPriceMonthly: 199 };
const PRO = { tierId: "pro", tierPriceMonthly: 499 };

describe("planRelation", () => {
  it("marks the exact tier AND cycle you are on as current", () => {
    expect(planRelation({
      ...PLUS, currentPlanId: "plus", currentPriceMonthly: 199,
      currentCycle: "monthly", selectedCycle: "monthly",
    })).toBe("current");
  });

  it("treats same tier, monthly -> yearly as an upgrade", () => {
    // 这就是用户报的那个场景：必须给出一个可点的按钮。
    expect(planRelation({
      ...PLUS, currentPlanId: "plus", currentPriceMonthly: 199,
      currentCycle: "monthly", selectedCycle: "yearly",
    })).toBe("up");
  });

  it("treats same tier, yearly -> monthly as a downgrade", () => {
    expect(planRelation({
      ...PLUS, currentPlanId: "plus", currentPriceMonthly: 199,
      currentCycle: "yearly", selectedCycle: "monthly",
    })).toBe("down");
  });

  it("ranks a different tier by monthly price regardless of cycle", () => {
    expect(planRelation({
      ...PRO, currentPlanId: "plus", currentPriceMonthly: 199,
      currentCycle: "monthly", selectedCycle: "yearly",
    })).toBe("up");
    expect(planRelation({
      ...PLUS, currentPlanId: "pro", currentPriceMonthly: 499,
      currentCycle: "monthly", selectedCycle: "yearly",
    })).toBe("down");
  });

  it("falls back to current when the stored cycle is unknown", () => {
    // 迁移前就存在的订阅没有记录周期。服务端在这种情况下退回只比档位并返回
    // 400，所以 UI 也必须显示为「当前套餐」—— 否则按钮点下去必然报错。
    expect(planRelation({
      ...PLUS, currentPlanId: "plus", currentPriceMonthly: 199,
      currentCycle: "", selectedCycle: "yearly",
    })).toBe("current");
  });
});
