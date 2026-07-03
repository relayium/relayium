# 设计：下载次数统计 + 个人中心 /me

**日期**：2026-07-03
**状态**：已与用户确认设计，待落地

## 目标

给存储转发（下载链接）加**下载次数统计**，并新增一个**个人中心整页 `/me`**，向登录用户展示自己的传输统计与文件管理。

## 首要原则：隐私安全优先

一切记录在"隐私安全第一"的前提下做权衡。具体落到本功能：

- **只持久化聚合计数**，不建逐条事件账本（不记每次下载的时间戳）。计数器是留存最少的形态。
- **绝不记录、不展示下载者的任何信息**（身份 / IP / 时间）。下载端点自增时只认文件行里的 owner `user_id`，完全不碰下载者。
- 存储转发是零知识加密的，服务端不知道文件名——列表里也就**不显示文件名**（见下）。

> 计费兼容性说明：按量计费用"计数器快照 + 差值"即可算出任一账期用量，单调递增计数器无需时间戳就能支撑未来计费。故隐私与计费在此不冲突。

## 计数语义（用户确认）

- **上传一次 = 记一笔**（`transfers_total += 1`，`upload_bytes += size`）。
- **每次下载都记**（哪怕同一文件被下载多遍，每遍 `downloads_total += 1`，`download_bytes += size`）；不去重。
- "传输次数"口径 = **用户创建的暂存下载链接数**。实时 P2P 传输是临时会话、不产生存储文件，不计入此数；其流量已计入 TURN 中继项。

## 数据模型（SQLite，`server/internal/account/sqlite.go`）

1. `stored_files` 新增一列：
   ```sql
   download_count INTEGER NOT NULL DEFAULT 0
   ```
   用现有 `OpenSQLite` 里幂等 `ALTER TABLE ... ADD COLUMN`（参照已有的 `password_hash` 加列写法）兼容老库。供"我的文件"列表每行显示该文件下载次数。

2. 新增终身累计表（每用户一行，不随文件过期/删除而减少）：
   ```sql
   CREATE TABLE IF NOT EXISTS user_stats (
     user_id         TEXT PRIMARY KEY REFERENCES users(id),
     transfers_total INTEGER NOT NULL DEFAULT 0,
     downloads_total INTEGER NOT NULL DEFAULT 0,
     upload_bytes    INTEGER NOT NULL DEFAULT 0,
     download_bytes  INTEGER NOT NULL DEFAULT 0
   );
   ```
   为什么不用 `COUNT(stored_files)`：文件过期会被 GC 删除，那样"总传输/总下载"会往下掉，不符合"总共多少次"的语义。

## 计数点（原子自增，仿现有 `ClaimBurnDownload` 的 `UPDATE ... WHERE`）

用 `INSERT INTO user_stats(...) VALUES(...) ON CONFLICT(user_id) DO UPDATE SET x = x + ?` 保证并发安全。

- **上传** `handleUploadFile`（`files.go` ~113-128）：成功写入 `stored_files` 后，`transfers_total += 1`、`upload_bytes += size`。
- **下载** `handleFileBlob`（`files.go` 153-197）：**仅在完整传输后**（`n == sf.Size`，与现有 burn 清理同一处）：
  - `user_stats`: `downloads_total += 1`、`download_bytes += size`（burn 与非 burn 都算）。
  - 非 burn 文件再 `stored_files.download_count += 1`（burn 文件下载即删、无行可加）。
  - 中途中断（未传满）不计。

## API（`server/internal/account/`）

- **新增** `GET /api/stats`（`RequireSession`）→
  ```json
  { "transfers": 12, "downloads": 34, "uploadBytes": 0, "downloadBytes": 0, "relayBytes": 0 }
  ```
  前四项读 `user_stats`；`relayBytes` 复用已有 `UserUsageTotal(userID)`（TURN 中继，未部署 redis 计量则为 0）。
- **改** `GET /api/files`（`handleListFiles`）：列表每项补 `downloadCount`（当前仅返回 `downloaded` 布尔；保留该布尔或由 `downloadCount>0` 派生）。
- **复用** `DELETE /api/files/{id}`（已存在）做文件删除。

## 前端（`web/src/`）

- 新路由 `/me`（在 `lib/router.svelte.ts` + `App.svelte` 的路由分支里加）。
- 新组件 `lib/MePage.svelte`：
  - 顶部 3 张统计卡：**传输次数 / 被下载次数 / 总流量**。总流量 = 上传 + 下载 + 中继，可展开看三项明细。
  - 下方"我的文件"列表（数据源 `GET /api/files`）：每行 **链接短码/id · 大小 · 下载次数 · 过期倒计时 · 删除按钮**。
  - **无文件名**（零知识加密，服务端不知道）。
- 入口：`lib/Account.svelte` 登录态菜单加"个人中心"→ 跳 `/me`。`/me` 未登录时引导登录。
- i18n：新增页面文案，6 语言（zh/en/ja/ko/de/fr）补齐。

### 可选增强（本期标记 optional，默认不做）

发送端浏览器用 `localStorage`（按文件 id）本地记住文件名，仅在同一设备把"我的文件"列表显示得更友好。设备本地、不上传服务器，不影响隐私。

## 测试

- 后端：`user_stats` 自增（上传 +1、下载每遍 +1、未传满不加、burn 下载计入用户累计但不加行计数）、`GET /api/stats` 聚合正确、`GET /api/files` 含 `downloadCount`。用现有 store 测试模式（`sqlite_test` 之类）。
- 前端：`/me` 路由渲染、统计卡取数、文件列表下载次数与删除、未登录引导。

## 实现顺序

先后端（下载计数 + `user_stats` + `/api/stats` + 列表补 `downloadCount`），再前端 `/me` 页。
