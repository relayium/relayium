# Relayium 前端优化审查报告

> 审查范围：`web/`(Svelte 5 + Vite 8 + TypeScript)，约 17.5k 行源码 + 构建/PWA 配置 + dist 产物。
> 日期：2026-07-23

## 总体评价

架构基础扎实：路由级代码分割已实现(`App.svelte:63-79` 的 memoized `import()`),9 个语言包按需加载，`qrcode` 也是懒加载;无 `{@html}`/XSS 风险;E2E 加密的 commit-reveal 握手、流式下载的超时/中断处理、应用层流控都做得规范。主要优化空间集中在 **入口 bundle 构成、传输热路径的响应式开销、PWA 缓存策略、以及若干可靠性/安全小修**。

---

## P0 — 高影响、低成本

### 1. libsodium 静态打进入口 chunk（约 538KB 入口的 85–90%)
- **位置**:`src/lib/crypto.ts:1` 静态 `import sodium from "libsodium-wrappers"`，被 `App.svelte` → `main.ts` 静态链拉入；dist 入口 `index-*.js` = 538,875 字节（原始）。
- **影响**：首屏必须下载+解析整个 wasm/asm 加密模块，而它只在 `onMount` 的 `await ready()` 之后才被使用；且每次业务代码发布，入口 hash 变化导致 libsodium 被重新下载。
- **建议**:`crypto.ts` 内改为缓存 `import("libsodium-wrappers")` 的 Promise（所有调用点已在 `ready()` 门控后，风险低）；或至少配置 `manualChunks: { sodium: ["libsodium-wrappers"] }` 使其独立缓存。

### 2. 传输热路径：每个 192KB chunk 重建 `$state` 对象
- **位置**:`src/App.svelte:915, 1027, 1054, 1068, 1144`(send/recv 循环里 `send = s = { ...s, sent, ... }`)。
- **影响**：快速局域网下每秒 500+ 次响应式失效，连带重渲染进度条、重算 format* 函数、并反复触发所有读取 `send`/`recv` 的 effect（见 #3)。手机端在 AES-GCM 本就占用主线程时雪上加霜。
- **建议**:UI 进度更新节流至 5–10Hz——循环内用普通局部变量，仅当距上次 UI 更新 >150ms 时才写回 `$state`（结束时必须 flush 最终值）。传输逻辑本身不需要响应式。

### 3. SEO/meta effect 在每个传输 chunk 上全量重写 `<head>`
- **位置**:`src/App.svelte:254-272`。
- **影响**：该 effect 读取 `send`/`recv`，每次 chunk 触发约 14 个 `querySelector`/`setAttribute` 及 `pageMeta()`/`altHreflangs()` 分配，而 meta/canonical/hreflang 实际只依赖路由和语言。
- **建议**：拆成两个 effect——标题(依赖传输进度)与 meta/canonical/hreflang（仅依赖 `currentRoute()`/`lang()`)，后者可移入 router 模块。与 #2 的节流是同一处修复。

### 4. Firefox/Safari 兜底下载路径有竞态（可能下载失败）
- **位置**:`src/lib/filesink.ts:558-565`:`a.click()` 后同步 `URL.revokeObjectURL(url)`，且 anchor 未 append 到 document。
- **影响**：这是 Firefox/Safari/移动端所有 blob/ZIP 下载的唯一路径。click 后立即 revoke 与浏览器异步启动下载竞态，是 Firefox 下载失败的已知原因； detached anchor 的 programmatic click 在 Firefox 也不可靠。
- **建议**:`document.body.appendChild(a); a.click(); a.remove();` 并延迟回收 `setTimeout(() => URL.revokeObjectURL(url), 10_000)`。

### 5. 对端文件名未做 bidi 控制字符剥离（Trojan Source)
- **位置**:`src/App.svelte:1352, 1374, 1471`(`{f.name}` 直接渲染)、`MePage.svelte` 文件列表、`DownloadPage.svelte:192`。
- **影响**:`src/lib/sw-stream.ts:71-94` 已对 `Content-Disposition` 做了 bidi 剥离且注释明确自知此攻击面，但 UI 渲染从未应用。恶意发送方可构造 `evil\u202Egnp.exe` 显示为 `evilexe.png`——在 E2E 传输应用里，接收确认卡片正是信任决策点。
- **建议**：把 `stripBidi` 提取为共享模块，在 manifest 进入时（`Receiver.feed`/`beginReceive`）统一清洗，下游 UI 和历史记录全部使用清洗后名称。

### 6. PWA 预缓存吞掉全部产物（含 9 个语言包 ~460KB)
- **位置**:`vite-plugin-pwa.ts:23-26`——所有 `.js/.css` 都进 precache，共约 1.2MB;cache 名按列表版本化，每次发布 `addAll` 重新抓取所有文件（包括 hash 未变的）。
- **影响**：每个用户只用 1–2 个语言包，约 8/9 的语言字节是浪费的安装带宽。
- **建议**:precache 排除语言 chunk（正则 `/^assets\/(ar|de|en|es|fr|ja|ko|pt|zh)-/`)，配合 #7 让语言包在首次使用后运行时缓存；可选地复用旧 cache 中 hash 未变的条目。

### 7. Service Worker cache-first 未命中时不回填缓存
- **位置**:`src/sw-template.js:90-93`:`hit || fetch(req)`，无 `cache.put`。
- **影响**：不在 precache 的资源永远走网络，离线即失效；#6 的修复依赖此项才有意义。
- **建议**：同源 GET 未命中时 `fetch` 后 `cache.put(req, res.clone())`（带 hash 的资源不可变，安全）。

---

## P1 — 可靠性

### 8. SW 立即 `skipWaiting()` 可能杀死进行中的流式下载
- **位置**:`src/sw-template.js:27-31`；流注册表 `const streams = new Map()` 在 SW 全局作用域（22-23 行注释已自知会被回收）。发布时换 SW → 注册表清空 → iframe 下次请求 404。
- **建议**：利用现有 `stream-probe` 机制：激活前探测受控客户端是否有活动流，或 `controllerchange` 时让页面快速失败并向新 SW 重新注册/重试流。

### 9. 信令重连为固定 2s，无退避/上限/抖动
- **位置**:`src/App.svelte:485-494`。
- **影响**：服务器宕机时所有客户端每 2 秒重连一次，形成自愈式重连风暴；手机端耗电。
- **建议**：指数退避 + 抖动，如 `min(2s * 2^n, 30s) ± 25%`，收到 `onSelfId` 后重置。

### 10. 多处 unhandled promise rejection
- `trackPath()`(`src/App.svelte:379-386`,fire-and-forget 于 794/860/1134):pc 关闭后 `getStats()` 必然 reject——每次传输结束都可能产生。应 try/catch 并在 reject 时退出轮询。
- `MePage.svelte:75-84, 152-167, 169-186`:`saveRename`/`addNode`/`deleteNode`/`setStrict`/`del` 均无 try/catch;`setStrict` 的乐观更新在 throw 时不会回滚。网络抖动导致 UI 状态错误且无提示。
- `src/lib/auth.svelte.ts:332-338` `localDeviceId()` 裸调 `localStorage`（代码库其余地方都有 try/catch),Safari 隐私模式会直接 throw。
- `src/lib/signaling.ts:76` `send()` 未检查 `readyState`，重连窗口期发消息抛 `InvalidStateError`。

### 11. `tsconfig.app.json` 的 `exclude` 覆盖了 TS 默认排除
- **位置**:`tsconfig.app.json:19-22`。指定 `exclude` 会替换默认排除（`node_modules` 等），导致 `src/node_modules/.vite`(6MB vitest 缓存，本不该存在于 src）被纳入 `allowJs+checkJs` 类型检查。
- **建议**:`exclude` 加 `"src/node_modules"`；删除该目录；在 `vitest.config.ts` 设置 `test.cache.dir` 防止再次出现。另:`tsconfig.node.json` 未包含 `vitest.config.ts`, `npm run check` 不会检查它。

---

## P2 — 结构 / 可维护性

### 12. `App.svelte` 1809 行，应拆分
内容包括：信令/房间生命周期(432-547)、RTT 测量(164-203)、debug 面板(388-430 + 1519-1548 + 1786-1808)、拖拽(549-601)、**接收管道 ~300 行**(652-955)、**发送管道 ~220 行**(957-1178)、模板 ~250 行、CSS ~260 行。
- **建议**:① 收发管道抽成 `src/lib/transfer-session.svelte.ts` 的工厂函数（`createReceiver(deps)`/`createSender(deps)`)，它们自包含、耦合最低、且当前形态不可测；② debug 面板抽成 `DebugPanel.svelte`;③ 账户/账单链(`Nav → Account → Pricing`,~60KB+ 源码）改为动态 import——匿名首访用户不该为登录态 UI 付下载成本。拆完 App 回归路由/模板角色（~500-600 行）。

### 13. `webrtc.ts` 的 `connect()` 与 `connectResume()` 约 200 行近乎逐字重复
- **位置**:`src/lib/webrtc.ts:188-355` vs `374-472`（仅 `resume: true` 和 commit/reveal 块不同；且已有漂移迹象——`busy` 处理只在 `connect` 里有）。
- **建议**：抽取共享的 `createPeerConnection({ signalExtra, onSignal })` 核心，两者分别叠加差异逻辑。

### 14. 重复代码
- `formatSize`:`App.svelte:1229-1235` 与 `src/lib/format.ts` 重复 → 删本地副本。
- 剪贴板 copied 按钮：4 处近乎相同(`StoredUpload.svelte:172-190`、`CodePairing.svelte:114-122`、`MePage.svelte:139-150`、`App.svelte:420-422`)→ 抽 `CopyButton.svelte`。
- 进度条 `.bar/.fill` CSS + `fill-sheen` 动画：3 处逐字重复(App/DownloadPage/StoredUpload)→ 移入 `app.css`。
- `auth.svelte.ts` 的 fetch 包装重复 7 次 → 一个 `apiPost<T>()` 可删 ~100 行。

### 15. i18n 的索引耦合数组
`CliPage.svelte:121/205/222/232` 用 `t.xxx[i]` 对齐翻译数组与代码常量，翻译增删条目会静默错位且类型系统抓不到。建议把配对数据移进 i18n 表（每项 `{ flag, applies, meaning }`）或加构建期长度断言。

---

## P3 — 无障碍 / 其他

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 16 | 文件选择入口键盘不可达：`display:none` 的 input + 不可聚焦的 `<label>` | `App.svelte:1274-1296`、`CodePairing.svelte:172-181`、`StoredUpload.svelte:206-217` | 用 visually-hidden 模式（`.sr-only` 已在 Account.svelte 存在）或真 `<button>` 调 `input.click()`，加 `:focus-visible` 样式 |
| 17 | `aria-live="polite"` 挂在逐 chunk 更新的进度文本上，屏幕阅读器刷屏 | `DownloadPage.svelte:207`、`StoredUpload.svelte:223` | 移除（`role="progressbar"` 已正确传达）；aria-live 只留给状态切换 |
| 18 | 模态框无 focus trap，关闭后焦点不还原 | `Account.svelte:343` | 加焦点圈禁 + 关闭时归还焦点 |
| 19 | async `onMount` 的 cleanup 被丢弃，popstate 监听永不移除 | `App.svelte:432-481` | 拆出独立的非 async onMount 注册 popstate |
| 20 | `createWakeLock` 每个实例永久注册 visibilitychange | `wakelock.ts:37-41` | 返回 `destroy()` 或模块级单例 + 引用计数 |
| 21 | `main.ts` 导出无意义的 boot Promise,mount 失败无兜底 UI | `main.ts:23` | 去导出，加 `.catch` 渲染纯文本错误 |
| 22 | `b64` 用 spread，大 buffer 会栈溢出 | `webrtc.ts:181-186` | 注明限制或改分块 |
| 23 | 验证码输入框无 aria-label | `CodePairing.svelte:156-166` | 补 `aria-label` |
| 24 | LAN 落地页组件在所有路由静态加载 | `App.svelte:51-57` | 低优先级：深度链接(`/d/<id>` 等）场景下可懒加载 |

## 部署侧需要人工确认
- `/sw.js` 与 `index.html` 必须 no-cache/短缓存（SW 更新检查依赖）,`/assets/*` 必须长缓存 `immutable`（文件名带 hash)。`sw-template.js` 的逻辑假定了这个分割，nginx 配置若不符会把用户困在旧 shell 上。
- 传输加密在大文件千兆局域网下主线程是吞吐上限（`transfer.ts:123-128` 每 chunk 两次 `crypto.subtle`),`Sender/Receiver` 迁入 Worker 是记录在案的未来选项，不急。

## 建议的修复顺序
1. **#4 + #5**(一行级修复，下载可靠性 + 安全）
2. **#1 + #2 + #3**(入口瘦身 ~450KB+；一处节流同时解决两个热路径问题）
3. **#6 + #7 + #8**(PWA 缓存带宽与离线正确性）
4. **#9 + #10 + #11**（可靠性小修 + tsconfig 卫生）
5. **#12 + #13**（结构性重构，工作量最大但收益长期）

---

## 实施状态（2026-07-23）

核实结论：抽查的每一条位置/结论均属实，无虚构项。按 P0+P1+便宜的 P2/P3 实施。

**已修复**：#1–#11、#14、#16–#23。
- #1 入口 538,875 → 108,490 字节；libsodium 独立成 chunk（432KB）并可跨发布复用。
  连带把 `store-crypto.ts` 的 sodium 依赖也去掉了（原生 base64url + `getRandomValues`），
  顺手修掉一个真 bug：`decodeKey` 在 `ready()` 之前同步调用 sodium（测试里表现为随机失败）。
- #6 precache 32 项 785,696 字节（原含 9 个语言包约 1.24MB）。
- #8 改为 SW 不自动 `skipWaiting`，由页面在无在途流式下载时发 `skip-waiting` 放行。

**未做（本轮范围外）**：#12（App.svelte 拆分）、#13（webrtc 去重）、#15（i18n 索引耦合数组）、
#24（LAN 组件懒加载）。#12/#13 触碰传输核心路径且现有测试不足以兜底，留作单独一轮。

**偏差说明**：#14 的"抽 CopyButton.svelte"改成抽 `clipboard.svelte.ts` 的 `copyFeedback()`——
四处按钮的外观/位置各不相同，统一成一个组件会为迁就彼此把 CSS 拧成一团，而真正重复的是行为。
进度条 CSS 提取时改名 `.progress-bar/.progress-fill`：`.bar`/`.fill` 在 CommandBlock 与
QuotaMeters 里另有含义，同名的全局规则会漏进去。

**验证**：`npm run check` 0 errors / 0 warnings；`vitest` 56 files / 574 tests 全绿
（新增 filename、focus-trap、SW 缓存回填与换版时机、signaling 重连窗口、base64url 边界等用例）；
生产构建 + headless Chrome 冒烟（首页与 /offline-transfer 渲染正常、无 console error、
canonical 随路由更新、libsodium 懒加载生效、进度条与文件选择框的全局样式解析正确）。
**未做**：真机/多浏览器手测——#4 的 Firefox 下载与 #8 的换版时机最终要在真环境确认。
