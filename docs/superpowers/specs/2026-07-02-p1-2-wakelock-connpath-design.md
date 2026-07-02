# P1-2（部分）：Wake Lock + 连接路径徽标 — 设计

> 来源：`docs/optimization-requirements-2026-07.md` 的 P1-2 前两件套。
> 断点续传（第三件）不在本次范围，单独立项。

## 目标

1. **Wake Lock**：活跃传输期间阻止移动端息屏，消灭「手机锁屏→传输中断」这一最常见的移动端失败原因。
2. **连接路径徽标**：读 `RTCPeerConnection.getStats()` 的选中 candidate pair，在传输卡片上显示当前走的是「局域网直连 / P2P 直连 / 中继」。既是有用信息，也是信任资产，呼应 README 的 LAN→P2P→relay 协议愿景。

非目标：断点续传；连接路径的历史/降级链可视化（P2 储备，依赖本项）。

## 一、Wake Lock

### 新模块 `web/src/lib/wakelock.ts`

```ts
export interface WakeLock {
  acquire(): void; // 声明「希望屏幕常亮」，幂等
  release(): void; // 撤销，幂等
}
export function createWakeLock(): WakeLock;
```

行为：
- `acquire()` 置内部 `wanted=true` 并尝试 `navigator.wakeLock.request('screen')`；`release()` 置 `wanted=false` 并释放 sentinel。两者幂等。
- **浏览器无 `navigator.wakeLock` 时静默降级**（Safari <16.4、旧安卓等），不报错、不影响传输。
- 系统会在页面切到后台时自动释放 sentinel。监听 `visibilitychange`：页面重新可见且 `wanted===true` 且当前无 sentinel 时，重新 `request`。这是 Wake Lock API 的标准配套模式。
- request 过程加并发保护（避免同一时刻发起多个 request）；`request` 抛错（用户手势限制等）时吞掉并保持 `wanted`，下次 visibility 事件再试。

### 接入 `App.svelte`

- 模块级 `const wake = createWakeLock()`（整页生命周期，无需清理）。
- 用一个 `$effect` 集中管理：存在「未完成的活跃传输」时 `acquire`，否则 `release`：
  ```ts
  $effect(() => {
    const active = (send && !send.done) || (recv && !recv.done);
    if (active) wake.acquire(); else wake.release();
  });
  ```
  这样无需在 send/recv 各分支手动加解锁，天然覆盖成功/失败/取消所有退出路径。

## 二、连接路径徽标

### 扩展 `web/src/lib/webrtc.ts`

新增纯分类函数（导出便于单测）：

```ts
export type ConnPath = "lan" | "p2p" | "relay" | "unknown";
export function classifyPath(stats: RTCStatsReport): ConnPath;
```

分类逻辑：
1. 遍历 stats，选中「当前生效的 candidate pair」——优先 `type==="candidate-pair"` 且 `selected===true`（Firefox），否则 `state==="succeeded"` 且 `nominated===true`（Chromium）。
2. 通过其 `localCandidateId` / `remoteCandidateId` 查到两端 candidate 的 `candidateType`。
3. 映射：任一端为 `relay` → `"relay"`；两端均为 `host` → `"lan"`；其余（含 `srflx`/`prflx`）→ `"p2p"`。
4. 找不到生效 pair → `"unknown"`。

`Conn` 接口增加读取方法（保持 `pc` 封装在闭包内）：

```ts
export interface Conn {
  channel: RTCDataChannel;
  close(): void;
  path(): Promise<ConnPath>; // = classifyPath(await pc.getStats())
}
```

### 接入 `App.svelte`

- 新增两个独立 `$state`：`sendPath` / `recvPath`（`ConnPath | undefined`）。**独立于 `Xfer` 存放**，避免路径异步写入与传输循环里高频重写 `s`/`r` 产生的 stale-merge 竞态。
- 每次新传输开始时把对应 path 重置为 `undefined`。
- 传输进入 `sending`/`receiving` 后，fire-and-forget 调用轮询助手：
  ```ts
  async function trackPath(conn, set) {
    for (let i = 0; i < 8; i++) {           // 选中 pair 有时在通道打开后才敲定
      const p = await conn.path();
      if (p !== "unknown") { set(p); return; }
      await sleep(400);
    }
  }
  ```
- 渲染：在传输卡片 `.meta` 行，进度/速率旁显示徽标（仅当 `path` 已知且传输未结束）。
  ```svelte
  {@const p = xf.dir === "send" ? sendPath : recvPath}
  {#if p && !xf.done}<span class="path path-{p}"><i class="dot"></i>{pathLabel(t, p)}</span>{/if}
  ```
- 徽标样式：小圆点 + 文字，三色——`lan` 绿 / `p2p` 蓝 / `relay` 橙。

### i18n（6 语言，顶层键）

新增 `pathLan` / `pathP2p` / `pathRelay`：

| key | zh | en | ja | ko | de | fr |
| --- | -- | -- | -- | -- | -- | -- |
| pathLan | 局域网直连 | LAN direct | LAN直結 | LAN 직접 | LAN direkt | LAN direct |
| pathP2p | P2P 直连 | P2P direct | P2P直結 | P2P 직접 | P2P direkt | P2P direct |
| pathRelay | 中继 | Relayed | 中継 | 중계 | Über Relay | Relais |

## 测试

- `classifyPath` 纯函数：用构造的 `Map` 假 stats 覆盖 lan / p2p(srflx) / relay / 无生效 pair(unknown) / Firefox `selected` 分支。
- Wake Lock：以 mock `navigator.wakeLock` 验证 acquire/release 幂等、无 API 时不抛错、visibility 重新可见时重申请。
- 端到端行为（息屏不断、徽标真实显示）走手动 verify。

## 风险 / 取舍

- Wake Lock 仅屏幕锁，无法阻止用户主动切走 App 导致的 WebRTC 暂停——这是浏览器限制，超出本项范围。
- `getStats()` 字段跨浏览器略有差异，故分类函数同时兼容 `selected`（FF）与 `nominated`（Chromium），未知一律降级为不显示徽标而非误报。
