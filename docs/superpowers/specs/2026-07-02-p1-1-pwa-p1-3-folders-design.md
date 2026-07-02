# P1-1（PWA）+ P1-3（文件夹/多文件/ZIP）— 设计

> 来源：`docs/optimization-requirements-2026-07.md` 的 P1-1、P1-3。
> 全部零依赖手写；share_target 完整实现。P1-2 断点续传随后独立做。

## 一、P1-1 PWA：Service Worker + share_target

### Service Worker

- **构建**：自写 Vite 插件 `pwaPlugin`（`web/vite-plugin-pwa.ts` 或内联于 `vite.config.ts`）。在 `generateBundle` 阶段收集本次产物里的 js/css/图标等文件名，算出 cache 版本号（清单排序后 hash），把清单+版本注入 `web/src/sw-template.js`（占位符 `__PRECACHE__` / `__VERSION__` / `__SHARE_ROUTE__`），`this.emitFile` 成根路径 **`/sw.js`**（固定名、不带 hash，才能被 URL 注册）。
- **SW 行为**：
  - `install`：`caches.open(v)` 预缓存应用壳（注入的清单 + `/`），`self.skipWaiting()`。
  - `activate`：删除 key 不等于当前版本的旧 cache，`clients.claim()`。
  - `fetch`：
    - 命中 share_target POST（见下）→ 专门处理。
    - 导航请求（`request.mode === "navigate"`）→ network-first，失败回退缓存的壳（离线可秒开）。
    - 同源已预缓存资源 → cache-first（hashed、不可变）。
    - 其余 → 直接 `fetch`（透传）。WSS 信令不经 `fetch`，不受影响。
- **注册**：`App.svelte` 的 `onMount`（或 `main`）中，`window.isSecureContext && "serviceWorker" in navigator` 时 `navigator.serviceWorker.register("/sw.js")`。失败静默。

### share_target

- **manifest**（`public/site.webmanifest`）新增：
  ```json
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "files": [{ "name": "files", "accept": ["*/*"] }] }
  }
  ```
- **SW 处理**：拦截 `POST /share-target` → 读 `formData` 的 `files` → 逐个 `cache.put("/__shared__/"+i, new Response(file, { headers: { "x-name": file.name, "content-type": file.type } }))` 存入专用 cache `share-<token>`，另存一条 manifest（数量）→ `Response.redirect("/?share-target="+token, 303)`。
- **页面接收**：加载时若 `location.search` 含 `share-target=<token>`：用 **Cache API 直接读回**（`caches.open` → `match` 各条 → `blob()` + `x-name` 重建 `File[]`），避免 SW↔页面消息竞态；随后 `caches.delete` 清理、`history.replaceState` 去掉 URL 参数。
- **进入发送**：把重建的 `File[]` 存为 `pendingShared`。LAN 面上：恰好 1 个 peer 直接发送；多个 peer 则显示提示「N 个文件待发送，选择设备」，用户点设备卡片即发。
- **iOS**：Web Share Target 入站分享仅 Android/Chromium PWA 支持，iOS Safari 不支持——文档/文案如实降级说明，不做假承诺。

## 二、P1-3 文件夹发送 / 超过 10 文件 / ZIP 下载

### 协议层（`transfer.ts`）

- `FileMeta` 增加可选 `path?: string`（相对路径，含文件名；扁平文件为 `undefined`，用 `name`）。
- 发送端 `sendFiles` 填充 `path = file.webkitRelativePath || undefined`；`name` 恒为 basename（显示 + 单文件保存用）。
- `Sender.dataFrames` 不变：按 `File[]` 顺序流，与 manifest 顺序一致。
- **manifest 字节守卫**：`batchFrame` 生成后若字节数超过阈值（如 200 KB，留裕量给 256 KB 数据通道上限）→ 抛错，UI 提示「文件过多/路径过长」。
- `MAX_FILES`：`10 → 1000`（配合字节守卫；文件夹场景够用又不撑爆 manifest）。

### 发送端（`App.svelte` + 新助手）

- 加「发送文件夹」入口：`<input type="file" webkitdirectory multiple>`，选中的 File 自带 `webkitRelativePath`。
- 拖拽文件夹：新助手 `filesFromDataTransfer(dt): Promise<File[]>`——items 支持 `webkitGetAsEntry()` 时递归目录（文件按 `entry.fullPath` 去掉前导 `/` 作相对路径），否则回退 `dt.files`。递归遍历逻辑抽成 DOM-free 可测函数（给定假 entry 树）。

### 接收端（`filesink.ts`）

- `SaveTarget.file(name, size, path?)` 增加 `path` 参数。
- **FSA 目录分支**：`path` 含子目录时，按 `/` 切分逐级 `dir.getDirectoryHandle(seg, { create: true })` 建/取子目录，末段 `getFileHandle(basename, { create: true })`；去重按完整 `path` 在批内维护。
- **`SaveTarget` 加批级 `done?(): Promise<void>`** finalize 钩子（默认 no-op）；App 在批次 COMPLETE 后调用。
- **blob 兜底**：`pickSaveTarget` 收到的批次 **含文件夹结构**（任一 `path` 带 `/`）时，返回一个「ZIP 兜底 target」——`file()` 把每个文件字节累积成 ZIP 条目，`done()` 组装成单个 `.zip` 触发下载（保留结构）。扁平多文件（无 path）维持现状逐个 blob 下载，行为不变。

### ZIP 写入器（新 `web/src/lib/zip.ts`）

- 手写 **store-only**（method=0，不压缩，对已压缩媒体/任意文件都无损）。
- 结构：每条目 local file header（sig `0x04034b50`）+ 文件名 + 原始数据；末尾 central directory（`0x02014b50`）+ EOCD（`0x06054b50`）。
- CRC32：标准表驱动实现（~15 行）。
- 收尾用 `new Blob(parts)`（parts 为各 `Uint8Array`），避免一次性大拼接。
- 日期用固定常量（规避时区），或取 `File.lastModified`；取简单固定值。
- **不支持 ZIP64**：单条目或归档 >4 GB 不兜底，如实注明（兜底路径本就面向缺 FSA 的浏览器，属边缘场景）。
- 单测：CRC32 已知向量；构造小 ZIP 校验各段签名与头字段结构。

## 三、i18n / 文案

- 新增：「发送文件夹」按钮、share_target 待发送提示、ZIP 兜底说明（如需）——6 语言。
- 修正/补充：iOS 不支持入站分享的降级措辞（如相关文案出现）。

## 四、测试策略

- 纯函数单测：`filesFromDataTransfer` 的目录递归、`zip.ts` 的 CRC32 与结构、manifest 字节守卫、`filesink` 的嵌套路径去重（对现有 `nextAvailableName` 风格补充）。
- SW 与 share_target 端到端（安装、离线秒开、分享入站、真机文件夹收发、ZIP 兜底解压）走手动 verify——SW/Cache/FSA 在 jsdom 下无法真实驱动。

## 五、实施顺序

1. **P1-1 整块**：SW 插件 + 模板 + 注册 + manifest share_target + 页面接收 + 待发送 UI；验证。
2. **P1-3 整块**：协议 path + 字节守卫 + 上限；发送端文件夹入口/拖拽；接收端嵌套目录；ZIP 写入器 + 兜底 target；i18n；验证。
3. 两块完成后再独立立项 **P1-2 断点续传**。

## 六、风险 / 取舍

- SW 上线后需注意缓存版本正确失效（activate 清旧 cache），否则用户可能卡在旧壳——靠版本号 = 产物清单 hash 保证内容变即换 key。
- share_target 入站仅 Android/Chromium；iOS 如实降级。
- ZIP 兜底在内存中缓冲整个文件夹（缺 FSA 的浏览器无流式落盘手段），大文件夹内存受限——可接受的兜底取舍。
