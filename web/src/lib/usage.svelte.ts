// /api/me/usage 被三个组件读：PlanCard 与 QuotaMeters（都在 /me 页），以及传输
// 页的 QuotaNotice。三者各自 fetch 会在打开个人中心时打出三次同样的请求，所以
// 这里按用户 id 缓存在途 promise。换用户（登录、切号、登出）自然失效。
//
// 缓存的是 promise 而非结果：三个组件在同一帧挂载时都能命中同一个在途请求。

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
  cached = fetch("/api/me/usage", { credentials: "include" })
    .then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
    .catch(() => null);
  return cached;
}

// 丢弃缓存，下次 fetchUsage 重新请求。用量或套餐变化后调用（上传完成、改档）。
// 测试必须在 afterEach 里调它，否则 mock 的响应会跨用例串味。
export function invalidateUsage(): void {
  cacheKey = null;
  cached = null;
}
