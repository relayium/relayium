# Relayium 前端优化审查报告

> **实施状态（2026-08-05 复核）：#1–#24 全部关闭，本报告无未完成的代码项。**
> 明细见文末的三段实施记录（2026-07-23 三轮）：#1–#11、#14、#16–#23 在第一轮修完，
> #12/#13/#15/#24 在第二、三轮补完，其中 #12 的"Account 动态 import"经实测**否决**
> （首屏反而大 20KB），属于有依据的不做而非遗漏。
> 唯一仍挂着的是**真机 / 多浏览器手测**（#4 的 Firefox 下载路径、#8 的 SW 换版时机），
> 那不是代码项，需要真设备。

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

---

## #12 / #13 实施状态（2026-07-23，第二轮）

**#13 webrtc 去重**：传输骨架抽成 `web/src/lib/webrtc-core.ts` 的 `establish()`。
`connect()` 只剩 commit-reveal（挂在 beforeSdp/onAnswer/afterSdp 三个钩子上），
`connectResume()` 变成一行 `establish({ resume: true })`——"纯传输"从注释里的承诺
变成了代码里的事实。世代标记（`resume: true`）现在只有一处、且双向生效。
`connectResume` 原本零测试，先补了 6 条特征测试再动刀。

**#12 App.svelte 拆分**：1809 → 1129 行。
- ① 收发管道 + 传输状态 → `web/src/lib/transfer-session.svelte.ts`（752 行）的
  `createTransferSession(deps)`，依赖（signaling/rtcConfig/文案/flash）显式注入。
- ② 调试面板 → `web/src/lib/DebugPanel.svelte`（102 行，自带轮询与样式）。
- ③ **没做，且不该做**：把 Account 改成动态 import 实测让首屏**变大 20KB**
  （entry 108.18+41.55KB → 135.66+34.71KB，rolldown 把原本共享的块复制进了入口）。
  报告里"~60KB+ 源码"是源码行数，不等于产物字节。已实测否决。

### 顺带修掉的两个真 bug（都不是本轮引入的）

1. **CSP 挡掉 WASM**（`server/spa.go`）：`script-src` 缺 `'wasm-unsafe-eval'`，
   libsodium 编译不了 → `ready()` reject → 应用卡在"连接信令服务器中"，**任何传输
   都用不了**。产线没暴露只是因为 nginx 自己兜静态壳、这个响应头压根没发出去；
   Go 直接兜 SPA 的部署（本地跑、无 nginx 部署）是完全坏的。已加 token + Go 单测。
   已在 826842d（本轮改动之前）上复现，确认非本轮回归。
2. **建连途中失败抛 ReferenceError**（`App.svelte`）：`connect()` 会在建连过程中
   同步回调 onStateChange，而接收端的掉线处理函数当时还是个未初始化的 const（TDZ），
   于是抛 ReferenceError 而不是干净地失败，接收卡片卡死。改成函数声明；E2E 用故障
   注入钉住（**先验证过：不修则该用例必红**）。

### 新增：真·端到端回归网

`web/e2e/lan-transfer.mjs`（`npm run test:e2e`，说明见 `web/e2e/README.md`）。
两个真标签页跑一次真传输，按 SHA-256 比对收到的字节；外加 SAS 一致性、确认卡片
显示文件名、建连失败要报得干净四项。只桩掉操作系统的"另存为"对话框。
这补上的正是 #12 最大的风险面——收发管道此前**一行单元测试都没有**。

**验证**：`npm run check` 0 error/0 warning；vitest 580 条全绿；`go test ./...` 全绿；
E2E 连跑多次全绿。仍**未做**真机/多浏览器手测。

### 补：断线续传的 E2E（2026-07-23）

`web/e2e/lan-transfer.mjs` 加了第三幕：24MB 文件传到第一 MB 落盘之后，把两端连接同时
判死，再断言续传结果**逐字节一致**（SHA-256）、总字节数正好等于文件大小、且收方确实
新建过 ≥2 个 RTCPeerConnection（防"注入还没落地就传完了"的假绿）。

这补上的是 #12 拆分里唯一还没有任何回归网的复杂路径：connectResume + checkpoint +
chain hash 恢复 + pausedRecv 状态机。

**用例的有效性被反向验证过**：把续传请求的 offset 改成 0（模拟 checkpoint 失效）之后，
收方实际写下 26,743,009 字节（应为 25,170,145）——字节数断言正好抓住它。

反向验证同时暴露了脚本自己的一个弱点并已修掉：破坏版会让收方主线程卡死，而 CDP 的
evaluate 在卡死的页面上**永不返回**，于是 waitFor 的超时判断根本轮不到执行，整个套件
静默挂死（实测挂了 9 分钟没有任何输出）。现在每次 evaluate 有 30s 上限、整条剧情线外面
再套一个 15 分钟的硬看门狗——挂死在 CI 里和"还在跑"长得一模一样，比一条红色失败糟得多。

**越界写入已修**（原本记为待查项）：破坏版里收方写下了**超过 manifest 声明大小**的字节。
manifest 声明每个文件多大、用户据此决定接不接收，但发送端完全可以不守这份声明（无视收方
给出的续传点、从 0 重发）。链式哈希最终会对不上，可那是**写完之后**的事——"先无界写入、
再报错"不是可接受的顺序。现在在 `sink.write` 之前拦（`wouldExceedDeclared`，提成纯函数
是为了能被单测覆盖边界：正好写满放行、多一个字节拦下、零字节文件、下标越界）。

实测对照（同一份破坏版，收方实际写入字节数 / 声明 25,170,145）：
- 修之前：**26,743,009**（超出 1.5MB，且收方主线程被拖死）
- 修之后：**25,165,824**（封在声明大小以内，随后如实报"完整性校验失败"）

误伤检查同样做了：带闸门的干净构建跑完整 E2E（含续传）全绿——续传恢复到 checkpoint
之后继续写不会碰到这条线。

### 补：#15 i18n 索引耦合数组（2026-07-23）

/cli 页把常量（flag、指南 slug、信任文件名、模式卡片）与 t.cliPage 里的文案**按下标**
配对渲染，两边长度没有任何东西保证——翻译少一条、或代码多加一个 flag，渲染出来就是
错位或 undefined，而且是静默的，9 个语言文件靠人肉数守不住。原来那条"badges 3,
pickWhen 5, flagMeanings 8, fileDescs 3"的手写注释本身就已经漂移了（实际 15 条）。

做法（两层，都实测验证过会红）：
1. 常量搬到 `web/src/lib/cli-page-data.ts` 并 `as const`，i18n 类型改成
   `SameLength<typeof FLAG_ROWS>` 这样的**等长元组**（同态映射类型作用在元组上保留
   长度）。往 FLAG_ROWS 加一行 → 9 份语言文件同时报类型错，且错误信息直接写明
   "Source has 15 element(s) but target requires 16"。
2. 运行时兜底：`i18n.test.ts` 断言每种语言的四个数组长度等于对应常量数组、且每条
   非空。因为类型错误只在有人真的跑 `npm run check` 时才会被看见，而 CI 目前只跑
   发布流程。实测删掉德语一条 fileDescs → 用例报 "de 的 fileDescs 条数不对: expected 2 to be 3"。

### 补：#24 首页折叠线以下的区块懒加载（2026-07-23）

HowToSteps / 跨网络引流 / FeatureStrip / CliCallout / UseCases / Faq 原本静态挂在
App.svelte 上，于是每个深链访客（/d/<id> 下载页、/me、/pricing…）都要先下载一份自己
根本看不到的首页长文案。合并成 `HomeSections.svelte` 一个懒加载边界（**一个**而不是
五个：五个边界会让打包器把共享部分复制五份——上一次 Account 懒加载正是这么变大的）。

实测（入口 js + 入口 css）：**149,939 → 133,260 字节**（js 108,388→101,200，
css 41,551→32,060），首页访客多取一个 8.3KB 的 HomeSections 块。

E2E 加了一条结构断言（`.how` / `.crosscta` / `.faq` 三个都在）守这个边界：它在折叠线
以下，坏掉不会有任何报错，页面只是从此少了一半内容。**第一版断言我写成了文案匹配，
结果是假红**（英文标题是 "Frequently asked questions"，并不含 "FAQ"），已改成结构选择器
——9 种语言的文案不能当断言用。
