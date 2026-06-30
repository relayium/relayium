# 跨网络异步传输（零知识上传 → 下载链接）— 设计文档

日期：2026-06-30
状态：已确认设计，待写实现计划
范围：模式 1（上传 → 一次性下载链接）。模式 2（跨设备"我的文件"列表）留作后续独立 spec。

## 背景

Relayium 当前的跨网络传输是纯实时 WebRTC 点对点：双方必须同时在线，文件字节从不
经过服务器（连 TURN 中转都是端到端加密的）。数据库只存账户元数据，没有任何文件存储
或对象存储抽象。前端、SEO、隐私政策、服务条款里用绝对措辞反复承诺"文件绝不经过
服务器 / 没有服务器副本 / 绝不收集文件内容、文件名、密钥"。

用户希望跨网络传输新增**异步**能力：登录用户上传文件，生成一次性下载链接，未登录
用户凭链接下载——对方不必同时在线。这是一个全新的服务器端存储子系统，与现有定位
冲突，必须作为一个**明确独立、零知识加密**的产品模式来做，并相应修订法务文案。

## 已确认的产品决策

- **加密信任模型：零知识**。服务器只存密文，读不到文件内容、文件名、密钥。
- **范围：分阶段**。本 spec 只做模式 1。模式 2（账号主密钥 + 跨设备列表）后续再做。
- **一次性语义：两者都要，上传时选**。①「阅后即焚」首次下载完成即删；②「限期多次」
  过期前可多次下载。
- **存储后端：本地磁盘 + 可插拔接口**。首个实现本地磁盘，接口预留 S3。
- **与实时模式并存**：跨网络页同时提供「实时直传」（现有 WebRTC）与「生成下载链接」
  （本功能）。实时模式的"不经服务器"承诺保持不变。
- **限额（可在 /admin 后台修改）**：单文件 50 MB；每账号每天 200 MB 上传额度（滚动
  24 小时窗口）；默认 TTL 1 天；最长 TTL 7 天。

## 加密模型（零知识）

- 上传时浏览器生成一个**随机 256 位密钥**，用 **AES-256-GCM 分块流式加密**文件，复用
  `web/src/lib/transfer.ts` 现有的分块/帧/nonce 派生逻辑（单方加密，无需密钥协商）。
- 文件名 + 大小清单（manifest）用**同一密钥单独加密**成一小段密文。服务器上连文件名
  都是密文——满足"绝不收集文件名"。
- 密钥放进下载链接的 URL 片段：`https://relayium.com/d/<id>#k=<base64url-key>`。
  `#` 片段不发往服务器、不进日志、不进 Referer。
- 服务器全程只见到：密文 blob、密文 manifest、密文字节数、时间戳、所属账号。无明文。
- 完整性：AES-GCM 每块自带认证标签；下载端逐块校验，篡改/截断即报错（复用 transfer.ts
  的 done/ok 语义）。

## 架构与组件

### A. 存储抽象 `server/internal/storage`（新包）

```go
type BlobStore interface {
    // Put streams r into object `key`, returning the number of bytes written.
    Put(ctx context.Context, key string, r io.Reader) (int64, error)
    Get(ctx context.Context, key string) (io.ReadCloser, error)
    Delete(ctx context.Context, key string) error
}
```

- 首个实现 `DiskStore`：把对象写到 `<dir>/<aa>/<key>`（用 key 前两位分片，避免单目录文件
  过多）。`dir` 由 `RELAYIUM_BLOB_DIR`（默认 `./blobs`）配置；startup-only，不进后台。
- `key` 用随机不可猜的 token（与公开 `id` 解耦，便于将来迁移/改名）。

### B. 数据库（新表，仍只存元数据/密文）

`stored_files`（文件生命周期）：

| 列 | 含义 |
| --- | --- |
| `id` | 公开文件 id（进 URL，随机 token） |
| `user_id` | 上传者 |
| `blob_key` | BlobStore 中的对象 key |
| `enc_manifest` | 密文清单（文件名/大小，BLOB） |
| `size` | 密文字节数 |
| `burn_after_read` | 是否阅后即焚 |
| `created_at` | 创建时间 |
| `expires_at` | 过期时间 |
| `downloaded_at` | 首次下载完成时间（可空） |

`upload_events`（每日额度计量，**不可变流水账**，独立于文件生命周期）：

| 列 | 含义 |
| --- | --- |
| `id` | 事件 id |
| `user_id` | 上传者 |
| `bytes` | 本次上传密文字节数 |
| `uploaded_at` | 上传时刻 |

> 为什么单独建表：每日额度是"滚动 24 小时内上传总量"。文件可能被焚毁/过期删除，但
> 当天额度照常计入，所以不能靠 `stored_files` 求和——用一份只增的 `upload_events`。
> GC 顺带清理超过 24 小时（+余量）的流水行。

`settings`（后台可改配置，键值表）：

| 列 | 含义 |
| --- | --- |
| `key` | 配置项名（如 `max_file_size`） |
| `value` | 整数值（字节 / 秒） |
| `updated_at` | 最后修改时间 |

四个键：`max_file_size`(字节)、`daily_quota`(字节)、`default_ttl`(秒)、`max_ttl`(秒)。

配套 Store 方法：
- `CreateStoredFile / GetStoredFile / ListStoredFilesByUser / MarkDownloaded / DeleteStoredFile / ListExpiredStoredFiles`
- `RecordUpload(userID, bytes, at) / UserUploadedSince(userID, since) (int64)`（每日额度求和）
- `GetSetting(key) / SetSetting(key, value) / ListSettings()`

### C. 配置：env 默认 + 后台覆盖

- 启动时各设置项以 env/flag 为初始默认：`RELAYIUM_MAX_FILE_SIZE`(默认 50 MiB)、
  `RELAYIUM_DAILY_QUOTA`(默认 200 MiB)、`RELAYIUM_FILE_TTL`(默认 86400=1 天)、
  `RELAYIUM_FILE_TTL_MAX`(默认 604800=7 天)。
- **精确取值（每个上传请求读 DB）**：`settings` 表有该键则用 DB 值，否则回退 env 默认。
  即"后台改动 > env 默认"。后台保存即写 `settings`，立即对后续上传生效（每请求读取，
  或带失效的轻量缓存）。
- 仅这 4 个进后台；`RELAYIUM_BLOB_DIR` 等路径类配置仍是 startup-only。

### D. HTTP 接口（挂在 account 服务的 mux 上）

- `POST /api/files`（`RequireSession`）：请求头/查询带 `burnAfterRead`、`ttl`（秒，
  服务器夹到 `[最小值, max_ttl]`，缺省用 `default_ttl`）；body 为 `enc_manifest` 长度
  前缀 + 密文流。服务器：① 读实时设置；② 流式写入并**边写边计数**，超 `max_file_size`
  立即中止 + 413；③ 校验当日额度 `UserUploadedSince(user, now-24h) + size <= daily_quota`，
  超限 → 删除已写 blob + 429；④ `RecordUpload` + 插 `stored_files` 行；⑤ 返回
  `{id, expiresAt}`。客户端据此拼 `/d/<id>#k=<key>`。
- `GET /api/files/{id}/meta`（**公开**）：返回 `{encManifest, size, burnAfterRead, expiresAt}`。
  失效/不存在 → 404。
- `GET /api/files/{id}/blob`（**公开**）：流式返回密文（支持 `Range` 以便断点续传/大文件
  友好，可选）。下载完成且 `burn_after_read` → 置 `downloaded_at` + 删 blob + 删行。
- `GET /api/files`（`RequireSession`）：列出本人活跃链接（id/大小/创建/过期/burn/是否
  已下载），用于管理与撤销。**不返回明文文件名**（服务器没有）。
- `DELETE /api/files/{id}`（`RequireSession`，仅本人）：提前撤销 → 删 blob + 删行。

### E. 生命周期 / GC

- 一个后台 goroutine（仿 `metering.Worker` 模式）周期运行（如每 10 分钟）：删除
  `expires_at < now` 的 `stored_files`（连 blob），并清理 `upload_events` 中
  `uploaded_at < now-25h` 的行。
- 阅后即焚在下载完成时同步删除（GC 是兜底）。

### F. 后台（/admin）—— 首次具备写入

- 现有 `/admin` 是只读 html/template + admin 会话 cookie。新增一个"暂存传输设置"区块：
  显示并可编辑 4 个值（以 MB / 小时·天等友好单位展示与回填）。
- `POST /admin/settings`（admin 会话保护）：校验数值（正数、`default_ttl <= max_ttl`、
  合理上限），写 `settings` 表，重定向回 `/admin`。沿用 html/template 自动转义；表单
  受 admin 会话 cookie 保护。

### G. 前端（web）

- 新增 `web/src/lib/store-crypto.ts`：随机 256 位密钥；流式 AES-GCM 加密/解密（复用
  transfer.ts 帧逻辑）；加密/解密 manifest；`base64url` 编解码密钥。
- 新增 `web/src/lib/stored-file.ts`：`uploadFile`(流式 POST)、`fetchMeta`、`downloadBlob`
  （流式取密文）等 API 封装。
- **跨网络页**（`CrossPage.svelte`）：在"实时直传"旁加第二入口"生成下载链接"。选文件 →
  浏览器加密 → 流式上传（带进度）→ 出链接 + 二维码 + 复制 +「阅后即焚/限期」开关 +
  TTL 选择（预设受 `max_ttl` 约束）。仅登录用户可用（沿用现有登录提示）。
- **下载页**：新增公开路由 `/d/<id>`（无需登录，复用已建的 SPA fallback）。读 `#k=` →
  取 meta → 解密 manifest 显示文件名/大小 → 点下载 → 流式取密文、解密、`filesink` 落盘。
  处理：链接无效/已过期/已焚毁、缺少 `#k=`、解密失败、浏览器不支持。
- 路由：在 `router.svelte.ts` 增加 `/d/<id>` 的识别（一个新的下载视图；它与 lan/cross
  Tab 并列但属于"无导航"的独立公开页，登录态不要求）。
- i18n：上传/下载/错误文案补齐 6 语言。

### H. 链接格式

`https://relayium.com/d/<id>#k=<base64url-key>`。`id` 在路径（服务器可见），`k` 在片段
（服务器不可见）。

## 数据流

**上传**：登录用户选文件 → 浏览器生成随机密钥 → 加密 manifest + 分块加密文件 →
`POST /api/files`（流式）→ 服务器查额度/限额、写 blob、记流水、插行 → 返回 `id` →
前端拼链接 `/d/<id>#k=` 给用户复制/扫码。

**下载**：任何人打开 `/d/<id>#k=` → 前端取 `/api/files/{id}/meta` → 用 `#k=` 解密
manifest 显示文件名/大小 → 点下载 → 流式取 `/api/files/{id}/blob` → 解密落盘 →
若 burn，服务器在传输完成后删除。

## 错误处理 / 边界

- 上传超单文件上限 → 流中止 + 413；超当日额度 → 429 + 提示剩余额度与重置时间。
- 下载：无效/过期/已焚毁 id → 404 友好页；缺 `#k=` 或密钥错 → "链接不完整/无法解密"提示；
  解密 GCM 校验失败（篡改/截断）→ 明确失败，不落坏文件。
- 并发：阅后即焚被两端同时下载——以"下载完成才删"为准；用行级状态避免重复删导致 500。
- 配额竞态：两个并发上传可能都通过额度校验——可接受的轻微超额（非安全边界）；如需严格
  可加事务串行化，MVP 不做。
- DB 不可用：账户/存储功能整体禁用，实时 LAN/WebRTC 不受影响（沿用现有降级策略）。

## 测试

- 服务端单测：`storage.DiskStore` Put/Get/Delete + 分片；Store 的 stored_files /
  upload_events / settings CRUD；`UserUploadedSince` 滚动窗口求和；上传 handler 的
  限额（413）、当日额度（429）、TTL 夹取、burn 删除、公开下载、撤销鉴权；GC 清理过期 +
  流水裁剪；admin settings POST 校验（`default_ttl <= max_ttl`、拒负数）。
- 前端单测（vitest）：store-crypto 往返（加密→解密一致、篡改即失败）、manifest 编解码、
  base64url、`/d/<id>` 路由识别、stored-file API 封装（mock fetch）。
- 手动验证：上传出链接 → 另一浏览器无登录下载成功；阅后即焚二次打开失效；超限/超额
  提示；后台改 4 个值后立即对新上传生效。

## 涉及文件（新增/修改）

- 新增 `server/internal/storage/{blob.go,disk.go,*_test.go}`
- 修改 `server/internal/account/{sqlite.go,store.go,service.go,handlers.go,admin.go}`（新表、
  新接口方法、文件 handler、admin 设置表单）
- 新增文件 handler 可独立成 `server/internal/account/files.go`
- 修改 `server/main.go`（blob store 装配、新 env 默认、settings 种子、GC goroutine、
  路由注册）
- 新增 `web/src/lib/{store-crypto.ts,stored-file.ts}` + 测试
- 修改 `web/src/lib/{CrossPage.svelte,router.svelte.ts,i18n.svelte.ts}`，新增下载页组件
- 修改法务/文案：`web/public/{privacy,terms}/**`（+ zh/de/ko/ja）、`web/index.html`、
  `web/src/lib/{i18n.svelte.ts,FeatureStrip.svelte}`、`web/public/llms.txt`

## 法务与定位（硬约束）

- **隐私政策**新增一节"暂存传输（下载链接）"：零知识加密落盘，服务器只存密文，读不到
  内容/文件名/密钥；保留至过期或下载后即删；记录密文大小与时间戳用于额度与清理。
  "我们绝不收集"清单维持成立（拿到的均为密文）。
- **首页 / FeatureStrip / 标语 / llms.txt** 中"文件绝不经过服务器"等绝对句，改为区分：
  "实时直传永不经过服务器；可选的暂存下载链接为零知识加密暂存"。**实时模式承诺不变**。
- **服务条款**新增暂存内容条款：可接受使用、按 id 接受举报下架、保留期与到期删除。

## 已知取舍

- 零知识 ⇒ 服务器无法扫描存储内容（无法做违规内容审查）。缓解：单文件 50 MB、每日
  200 MB 额度、短 TTL（默认 1 天/最长 7 天）、按账号归属、按 id 接受举报下架、限流。
  spec 明确记录此为零知识的固有代价。
- 上传非断点续传（MVP）；大文件/弱网体验后续可加 tus 等。下载可选支持 `Range`。
- 后台 settings 为全局（非按用户）；按用户/套餐的差异化额度属于后续工作。

## 非目标（YAGNI）

- 模式 2（账号主密钥、跨设备"我的文件"、无密码登录的口令方案、恢复密钥）。
- S3/对象存储实现（仅预留接口）。
- 断点续传上传、分片并行、CDN、缩略图/预览。
- 按用户配额套餐、付费、计费。
