// 一张定价卡相对于用户当前订阅的位置。
//
// 档位和计费周期是两个正交的维度，必须一起判断：只比档位 ID 的话，月付用户切到
// 「年付」时自己那一档仍会显示成「当前套餐」，改成年付一次性付清就没有入口。
// 这里的规则必须和服务端 handleBillingChangePlan 保持一致，否则界面会给出一个
// 服务端注定拒绝的按钮。

export type Relation = "current" | "up" | "down";

export function planRelation(args: {
  tierId: string;
  tierPriceMonthly: number;
  currentPlanId: string;
  currentPriceMonthly: number;
  /** 'monthly' | 'yearly' | ''（未知：迁移前就存在的订阅行） */
  currentCycle: string;
  selectedCycle: "monthly" | "yearly";
}): Relation {
  const { tierId, tierPriceMonthly, currentPlanId, currentPriceMonthly, currentCycle, selectedCycle } = args;

  // 换档位：方向由月价决定，与所选周期无关（和服务端「档位优先」一致）。
  if (tierId !== currentPlanId) {
    return tierPriceMonthly > currentPriceMonthly ? "up" : "down";
  }

  // 同档位。周期未知时无从比较，显示为「当前套餐」—— 服务端此时也会退回只比
  // 档位并返回 400，给出按钮只会让用户点出一个错误。
  if (currentCycle !== "monthly" && currentCycle !== "yearly") return "current";
  if (currentCycle === selectedCycle) return "current";

  // 只变周期：拉长承诺是升级（立即扣款），缩短是降级（延到期末）。
  return selectedCycle === "yearly" ? "up" : "down";
}
