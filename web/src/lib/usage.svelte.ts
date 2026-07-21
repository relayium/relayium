// /api/me/usage 被三个组件读：PlanCard 与 QuotaMeters（都在 /me 页），以及传输
// 页的 QuotaNotice。三者各自 fetch 会在打开个人中心时打出三次同样的请求，所以
// 这里按用户 id 缓存在途 promise。
//
// 缓存的是 promise 而非结果：三个组件在同一帧挂载时都能命中同一个在途请求。
//
// 失效时机，如实说明（别按直觉推）：
//   - 换到另一个 userId：cacheKey 不匹配，自然重新请求。
//   - 请求失败（网络错误或非 2xx）：失败结果不留在缓存里，下次调用重新请求。
//   - 进入 /me 页：MePage 初始化时调 invalidateUsage()，所以每次访问个人中心
//     都拿新数字。
//   - **登出并不会失效**：调用方在 `!uid` 时早退，根本不会调到这里，cacheKey
//     原封不动。同一账号登出后再登回来，命中的是登出前那份缓存，直到进 /me
//     或有人显式调 invalidateUsage()。这是已知的、被接受的行为。

export interface Bucket {
  used: number;
  cap: number; // 0 表示无限——服务端已把内部的负数表示规约掉了
}

export interface PlanInfo {
  id: string;
  name: string;
  storageBytes: number; // 0 = 无限
  trafficBytes: number; // 0 = 无限；这是标称月上限，不是折算后的实际额度
  retentionSecs: number; // 0 = 永久保留
  priceMonthly: number; // 美分
  priceYearly: number; // 美分
  billingCycle?: string; // 'monthly' | 'yearly' | ''（未知）
  scheduledPlanId?: string; // 排期期末降级的目标档 id，'' 无
  scheduledPlanName?: string; // 该目标档的展示名
  isTop: boolean; // 已在最高档：隐藏升级引导
  subscriptionStatus: string; // '' = 从未结账
  subscriptionEnd: number; // unix 秒；0 = 无订阅
}

export interface Usage {
  period: string;
  resetsAt: number;
  traffic: Bucket;
  storage: Bucket;
  plan?: PlanInfo; // 可选：老版本服务端不返回它时前端要能降级
}

let cacheKey: string | null = null;
let cached: Promise<Usage | null> | null = null;

// 取当前用户的用量。同一 userId 的并发/后续调用共享一次请求。
// 取不到时 resolve 成 null（而不是 reject）——用量是附加信息，调用方一律
// "拿不到就不渲染"，没有需要区分错误类型的场景。
export function fetchUsage(userId: string): Promise<Usage | null> {
  if (cacheKey === userId && cached) return cached;
  cacheKey = userId;
  // 失败结果绝不能留在缓存里。缓存的是 promise，所以一次瞬时网络抖动或一次 500
  // 会把"resolve 成 null"的 promise 永久存住，同一 userId 后续调用永不重试——
  // 用量条和预警条会在整个 SPA 会话内静默消失。两条失败路径（fetch 抛错、响应
  // 非 2xx）都要把缓存清掉，让下一次调用重新发请求。
  const p: Promise<Usage | null> = fetch("/api/me/usage", { credentials: "include" })
    .then((r) => {
      if (!r.ok) { forget(p); return null; }
      return r.json() as Promise<Usage>;
    })
    .catch(() => { forget(p); return null; });
  cached = p;
  return p;
}

// 只在缓存里存的还是 `p` 本身时才清。这个身份检查不是多余的：一个迟到的失败
// （对应的调用早已被换用户或 invalidateUsage() 挤出缓存）如果无条件清空，会把
// 后来者刚建立的、完全有效的在途缓存误伤掉，导致又多打一次请求。
function forget(p: Promise<Usage | null>): void {
  if (cached === p) {
    cacheKey = null;
    cached = null;
  }
}

// 丢弃缓存，下次 fetchUsage 重新请求。用量或套餐变化后调用（上传完成、改档）。
// 测试必须在 afterEach 里调它，否则 mock 的响应会跨用例串味。
export function invalidateUsage(): void {
  cacheKey = null;
  cached = null;
}
