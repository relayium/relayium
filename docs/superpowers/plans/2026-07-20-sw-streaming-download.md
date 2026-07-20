# Service Worker 流式下载（第 1 步：异步下载页单文件） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让异步下载页的**单文件**下载在没有 File System Access API 的浏览器（Firefox / Safari / 所有手机）上也能流式落盘，从而在这些浏览器上消掉下载页的内存提示。

**这一步的真正产出是一个答案**：iOS Safari 到底能不能下载 service worker 生成的流式响应。第 2、3 步（流式 ZIP + ZIP64、实时接收路）是否值得做，取决于这个答案。所以**手工验证清单和代码同等重要**。

**Architecture:** 页面通过 `MessageChannel` 把密文解密后的明文块**逐块 postMessage** 给 SW，SW 把它们喂进一个 `ReadableStream` 并作为带 `Content-Disposition` 的 `Response` 返回；页面用隐藏 iframe 触发对该 URL 的 GET。背压靠 SW 在真正消费一块后回 ack，页面的 `write()` 等这个 ack。

## 为什么是 postMessage + ack，而不是传 TransformStream

传 `TransformStream`（`postMessage(readable, [readable])`）代码少得多、背压自带，但**可转移流在 Safari 上支持情况不明**。

本步的核心目的是拿到"iOS Safari 行不行"这个答案。用可转移流的话，iPhone 上一旦失败就分不清是「Safari 不能下载 SW 生成的流」还是「Safari 不支持可转移流」——两个变量混在一起，测了等于没测。postMessage 只依赖最基础的能力，把变量隔离成一个。

附带好处：ack 背压正是第 3 步（实时接收路要保住 `resumable`/流控 ACK 的 durability 语义）必须要的机制，现在写不算白写。

## Global Constraints

- 前端 `cd web`：`npx vitest run`、`npm run check`、`npm run build`。
- **commit message 一律英语**；用户可见文案 9 语齐全；代码注释跟随 `web/src/lib` 既有风格（中文为主）。
- **本步只接单文件**（`files.length === 1`）。多文件原样走既有分支和既有提示，不动。
- **不改 `pickSaveTarget` 已有四条分支的行为**，只新增一条并调整顺序。
- **不改实时接收路**（`App.svelte`）。它有 durability 语义（`:901` 的 `resumable`、`:909` 的流控 ACK），是第 3 步的事。
- 还原临时改动一律用 `cp` 备份，**禁用 `git checkout`**。变异按**行号**定位并回显被改的那一行自证。

## 已核实的前提（勿重查）

- `sw-template.js`（85 行，手写）由 `vite-plugin-pwa.ts` 在 **build 时**做 string-replace 产出 `dist/sw.js`。**dev 模式不注册 SW**（`share-target.ts:9` 的 `import.meta.env.PROD` 门）。
- SW 有 `skipWaiting` + `clients.claim`，scope `/`，nginx 无需改（`/sw.js` 在 root、`Cache-Control: no-cache` 正确）。
- 现有 fetch 拦截顺序：share-target POST → 非 GET 放行 → **navigate 网络优先** → **同源 GET cache-first**。流式路由必须插在 navigate **之前**。
- 下载页是 `App.svelte:64` 的懒加载路由，所以 `App.svelte:438` 的 `registerServiceWorker()` 在下载页**会**执行。
- `DownloadPage.svelte` **从不调用 `target.done?.()`**（全仓唯一调用点是 `App.svelte:938`）。
- jsdom **不支持 service worker**；`sw-template.js` 是全仓唯一没有测试的源文件。
- 流式 URL 在 SW 未 claim 时会走到 nginx 被 `try_files` 兜底成 **index.html**——用户会"下载到一个网页"。
- 实时模式的文件名 `zip.ts:38` 直言"完全由攻击者控制"。

---

### S1: 纯逻辑模块（可测的那一半）

**Files:** Create `web/src/lib/sw-stream.ts`；Test: `web/src/lib/sw-stream.test.ts`

jsdom 测不了 SW，所以把**所有不依赖 SW 运行时的逻辑**抽成纯模块，SW 脚本只做 glue。这与仓库既有风格一致（`zip.ts` 就导出纯 `crc32`/`safeSegments`）。

本模块要导出（名字可调整，但要在报告里说明）：

1. **`STREAM_ROUTE`** — 流式 URL 前缀常量。挑一个不可能与真实路由/静态资源冲突的，并说明你怎么确认不冲突（`router.svelte.ts` 的路由表 + `web/public/` 下的文件）。

2. **`streamURL(token, filename): string`** — 构造流式 URL。文件名放进 path 只是为了浏览器在极端情况下有个回落名，**真正定名的是 Content-Disposition**。注意 URL 编码。

3. **`parseStreamPath(pathname): { token } | null`** — SW 侧解析。必须拒绝畸形输入。

4. **`contentDisposition(filename): string`** — 这是**新攻击面**，仓库零先例，请认真做：
   - 按 RFC 5987 给**双 filename**：ASCII 回落 + `filename*=UTF-8''<percent-encoded>`。只给一个会让老浏览器拿到乱码名。
   - **必须剥掉 CR/LF 和其它控制字符**——文件名在实时模式下完全由攻击者控制，含 `\r\n` 就是 header 注入。
   - ASCII 回落名怎么产生（非 ASCII 字符换成什么）由你定，但要保证**结果非空**且不含引号/反斜杠/控制字符。
   - 测试必须覆盖：纯 ASCII、中文名（仓库既有测试用过 `"图 片.svg"`）、含 `"` 的名、含 `\r\n` 的名、含 `;` 的名、空名、超长名、全非 ASCII 名。

**TDD**：先写测试再写实现。每个安全相关的用例都要断言**具体的输出**，不要只断言"不包含 \r"——那种断言在实现返回空字符串时也会通过。

**变异验证**（提交前自己做）：
1. 去掉 CR/LF 剥离 → 对应用例应失败
2. 去掉 `filename*=` 那一半 → 中文名用例应失败
3. `parseStreamPath` 改成不校验格式（任何输入都返回 token）→ 畸形输入用例应失败

---

### S2: SW 侧 + 客户端 sink

**Files:** Modify `web/src/sw-template.js`、`web/src/lib/filesink.ts`；Test: `web/src/lib/filesink.test.ts`（扩充）

#### SW 侧（`sw-template.js`）

- 新增 `message` 监听器（现在没有）接收流注册：页面通过 `MessageChannel` 建立通道，SW 记下 `token → { controller, port }`。
- fetch 拦截**插在 navigate 分支之前**：`parseStreamPath` 命中 → `respondWith` 一个 `new Response(readableStream, { headers })`，headers 含 `Content-Disposition`、`Content-Type: application/octet-stream`。
- **`Content-Length`**：单文件下载我们**知道**明文大小。请判断要不要给——给了浏览器能显示准确进度，但如果实际字节数不符会截断或报错。在报告里说明你的选择与理由。
- **ack 背压**：SW 在 `ReadableStream` 的 `pull` 被调用（即消费方要下一块）时，通过 port 回一个 ack。页面的 `write()` 等这个 ack。
- **取消检测**：`ReadableStream` 的 `cancel` 回调（用户点了取消下载）要通过 port 通知页面，页面应中止写入并报错，而不是继续往死流里写。
- **SW 生命周期**：SW 空闲约 30s 会被浏览器终止。请说明你的注册表如何在这种情况下表现，以及是否需要 `event.waitUntil` 之类的保活。**如果你判断存在无法规避的窗口，在报告里明确写出来**，不要假装没有。

#### 客户端（`filesink.ts`）

- 新增 `swStreamSink`（实现既有 `FileSink` 接口，不改接口形状）。
- **SW 就绪状态是异步的，而 `canStreamToDisk` 是同步的、`pickSaveTarget` 必须在用户手势内跑**。做法：模块级缓存一个就绪布尔，在 SW 注册后填上（`share-target.ts` 已经注册了，你可能需要在那里或别处补一个 `navigator.serviceWorker.ready` 的 then）。**不要在 `pickSaveTarget` 里 `await ready`**——那会消耗用户手势。
- **必须检查 `navigator.serviceWorker.controller` 非空**。首次访问时 SW 刚注册还没 claim，controller 是 null，此时触发下载会走到 nginx 拿到 index.html。
- `pickSaveTarget` 新分支排在 **Save As 之后、目录句柄之前还是之后**？请判断并说明——目录句柄分支也是流式的，且对多文件更合适，而本步 SW sink 只接单文件。
- **`canStreamToDisk(fileCount)` 与 `memoryPeakBytes` 必须同步更新**。`filesink.test.ts:102-115` 有一条真跑 `pickSaveTarget` 逐组合比对 label 的一致性用例，`:144-154` 有 `memoryPeakBytes` 的对应断言——**不更新它们会先红**，更新时不要削弱它们。

**测试**：照 `share-target.test.ts:5-14` 的 `stubCaches()` 风格写一个 `stubServiceWorker()`，mock `navigator.serviceWorker`（`ready` / `controller` / `register`）。jsdom **有** `MessageChannel` 可用。`TransformStream`/`ReadableStream` 在 jsdom 下是否可用需你确认，不可用就 `vi.stubGlobal`。

**变异验证**：
1. 去掉 `controller` 非空检查 → 应有测试失败
2. `canStreamToDisk` 不加 SW 分支 → 一致性用例应失败
3. 去掉 ack 等待（write 立即 resolve）→ 背压测试应失败

---

### S3: 下载页接线 + 手工验证清单

**Files:** Modify `web/src/lib/DownloadPage.svelte`；Create `docs/TESTING-sw-download.md`；Test: `web/src/lib/DownloadPage.test.ts`（扩充）

- **补上 `await target.done?.()`**（现在从不调用，全仓唯一调用点是 `App.svelte:938`）。SW sink 需要它来等流真正结束。
- 内存提示的判断已经走 `canStreamToDisk`，所以 SW 分支生效后**它自然就不触发了**——不要为此另写逻辑。但要**加一条测试**钉住"SW 可用时不再显示提示"，否则这一步的用户可见效果没有守卫。
- **SW 不可用时（dev 模式、注册失败、controller 为 null）必须干净回落**到既有的 blobSink + 既有提示。加测试。

#### `docs/TESTING-sw-download.md`（本步的核心产出之一）

写一份**可执行的手工验证清单**。`npm run build && npm run preview` 之后逐项跑，每项写清楚：怎么做、期望看到什么、**怎么判断失败**。

必须覆盖：

1. **桌面 Chrome** — 应仍走原生 Save As（SW 分支不该抢它）。
2. **桌面 Firefox** — 应走 SW 流式；下载完成后**校验文件大小与内容哈希**与原文件一致。
3. **桌面 Safari** — 同上。
4. **iOS Safari** — 同上。**这一项是整件事的目的。**
5. **安卓 Chrome** — 同上。
6. **大文件**（>256 MiB）在 iOS Safari 上：内存提示**不应**出现，且下载应成功。
7. **中途取消下载** → 页面应报错而不是卡死或静默失败。
8. **首次访问**（SW 刚注册、可能还没 claim）立刻点下载 → **绝不能下载到一个 HTML 文件**。清 SW 后重现。

**每一项都要求校验内容完整性，不能只看"有没有下载下来一个文件"** —— Safari 上最坏的情况是"看起来成功但文件是截断或损坏的"，那比现在的提示更糟，因为用户以为下载好了。清单里要写明用什么命令比对（例如 `shasum -a 256`）。

---

## 收尾验证

```bash
cd web && npm run check && npx vitest run 2>&1 | tail -5 && npm run build 2>&1 | tail -3
cd ../server && go build ./... && go test ./... 2>&1 | grep -cE "^ok"
```

**已知既有 flake**：`store-crypto.interop.test.ts` 的多文件 Go 向量用例约 10-15% 概率抛 `_malloc` TypeError，与本计划无关，撞上重跑。

## Self-Review 记录

- **本步刻意不做**：流式 ZIP、ZIP64、多文件、实时接收路。
- **最大风险**：SW 生命周期（空闲终止）与流注册表的交互，以及 Safari 上"静默产出损坏文件"的可能——后者只能靠 S3 的手工清单发现，所以那份清单的质量决定了这一步是否真的拿到了答案。
- **需实现者判断的项**：`Content-Length` 给不给；`pickSaveTarget` 里 SW 分支相对目录句柄分支的顺序；SW 空闲终止是否存在无法规避的窗口。
