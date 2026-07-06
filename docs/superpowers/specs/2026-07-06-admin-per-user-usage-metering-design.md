# 后台按月计量：每用户上传/下载/中继流量 + 存储占用

**日期：** 2026-07-06
**状态：** 已批准，待实现

## 背景与目标

`/admin` 后台目前每用户只展示**累计中继流量**（`usage_events` 全量求和）。需要补上**上传流量、下载流量、当前存储占用**，并且口径要能**按月**——因为这些数字以后是**计费依据**（用户选择：按周期/月计量；存储按当前快照计费）。

本设计新增一张月度计量账本，把三类流量在后台统一成"按选定月份"展示，存储占用为当前快照。

## 现状盘点（决定了工作量）

| 维度 | 现有数据 | 能否按月 |
|---|---|---|
| 中继流量 | `usage_events(user_id, relayed_bytes, recorded_at)`，按 `alloc_id` 取 `MAX`，**永不清理** | ✅ 直接 `GROUP BY 月份` |
| 上传流量 | `user_stats.upload_bytes`（累计）；`upload_events`（带时间戳但 GC 25h 后清掉） | ❌ 无法按月，需新账本 |
| 下载流量 | `user_stats.download_bytes`（累计），无带时间戳流水 | ❌ 无法按月，需新账本 |
| 存储占用 | `stored_files.size`（当前快照） | ⚠️ 仅"当前占用"，按快照计费即可 |

**关键约束（中继为何不进新账本）：** coturn 按 allocation **累计上报**字节，`RecordUsage` 用 `MAX(relayed_bytes)` 按 `alloc_id` 去重（`sqlite.go:331`）。这种"累计上报取最大值"的语义**不能增量累加**进月度桶，否则重复计数。而 `usage_events` 本身带 `recorded_at` 且永久保留，按月分组即得正确结果。因此中继保持从 `usage_events` 派生，只有上传/下载（一次性事件，可安全累加）进新账本。

## 架构（三个数据来源，各司其职）

### 1. 新表 `usage_monthly` —— 计费账本（仅上传/下载）

```sql
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id        TEXT    NOT NULL,
  period         TEXT    NOT NULL,          -- 'YYYYMM'（UTC）
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_period ON usage_monthly(period);
```

- 表大小 = 用户数 × 月数，永久保留，无清理压力。
- 通过 `migrate()` 里 `CREATE TABLE IF NOT EXISTS` 建表（与现有表同一处），旧库自动补建。

### 2. 中继 —— 复用 `usage_events`

后台按月对 `usage_events` 做 `SUM(relayed_bytes) WHERE recorded_at ∈ [该月区间] GROUP BY user_id`。已按 `alloc_id` 取 MAX，不重复计。跨月的 allocation 归入其最后上报时间 `recorded_at` 所在月（可接受的近似）。

### 3. 存储占用 —— `stored_files` 当前快照

`SUM(size) WHERE user_id=? AND expires_at > now`。与所选月份无关，UI 明确标注"当前存储占用"。

## 写入路径

新增 store 接口方法（**不要**复用已存在的 `RecordUsage(UsageEvent)`——那是中继写入）：

```go
type UsageKind int
const (
    MeterUpload UsageKind = iota
    MeterDownload
)

// RecordMeter 把一笔一次性用量累加到该用户当月的计量桶。best-effort。
RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error
```

SQLite 实现按 `kind` 选列（`switch`，不拼字符串），period 由 `periodOf(at)` 得出：

```go
func periodOf(at int64) string { return time.Unix(at, 0).UTC().Format("200601") }
```

```sql
INSERT INTO usage_monthly (user_id, period, upload_bytes, download_bytes, updated_at)
VALUES (?, ?, ?, 0, ?)                       -- 上传：第 3 个占位符为 bytes；下载则装到 download_bytes 那列
ON CONFLICT(user_id, period) DO UPDATE SET
  upload_bytes = upload_bytes + excluded.upload_bytes,   -- 对应 kind 的那一列
  updated_at   = excluded.updated_at;
```

三处调用点，全部 best-effort（`_ =`，失败仅日志，不影响用户传输，与现有 `AddUploadStat`/`AddDownloadStat` 一致）：

| 事件 | 位置 | 调用 |
|---|---|---|
| 上传提交成功 | `files.go:138`，紧接 `AddUploadStat` 后 | `_ = s.store.RecordMeter(r.Context(), u.ID, MeterUpload, size, now)` |
| 下载完成 | `files.go:197`，紧接 `AddDownloadStat` 后 | `_ = s.store.RecordMeter(r.Context(), sf.UserID, MeterDownload, sf.Size, s.now().Unix())` |
| 中继记账 | 不动 | 按月从 `usage_events` 派生 |

**归属规则**（沿用现状，保持零知识）：上传计给上传者 `u.ID`；下载**只计给文件属主** `sf.UserID`，不读取也不记录下载方身份。

## 后台读取与 UI

### 月份参数

新增查询参数 `?period=YYYYMM`，与现有 `search/sort/page` 同走 query string。缺省/非法值回退当月（`periodOf(now)`）。页面顶部下拉列出最近 12 个月，默认当月；切月份时保留 search/sort。

### 每用户表格（口径统一为"选定月"）

列：邮箱 / 方式 / 设备数 / **上传·选定月** / **下载·选定月** / **中继·选定月** / **当前存储占用**。

- `AdminUserRow` 增加字段：`UploadBytes, DownloadBytes, RelayBytes, StorageBytes int64`（`RelayBytes` 语义由累计**改为选定月**）。
- `AdminUserQuery` 增加 `Period string`。
- `AdminListUsers` 查询：
  - `LEFT JOIN usage_monthly um ON um.user_id=u.id AND um.period=?`（取 upload/download，无行则 0）；
  - 子查询 `SUM(usage_events.relayed_bytes)` 限定该月区间 → 选定月中继；
  - 子查询 `SUM(stored_files.size) WHERE expires_at>now` → 当前存储。
- 排序 `SortBy` 支持 `created | email | upload | download | relayed | storage`。沿用现有键名 `relayed`（保持现有排序链接兼容），但其排序依据由"累计中继"改为"选定月中继"；新增 `upload`/`download`/`storage`。

**语义变更（已确认）：** 每用户"中继流量"列由累计改为**按月**，不保留累计列。

### 顶部汇总卡片

- **保留**：总用户数、未过期暂存文件数、占用存储（总，当前快照）。
- **移除**：中继·24h、中继·7d、上传·24h 三个滚动窗卡片（与按月口径不一致，易混）。
- **新增**：上传·选定月、下载·选定月、中继·选定月（`SUM` over 该月 `usage_monthly` / `usage_events`）。
- `AdminMetrics` 相应增删字段；`AdminMetrics(ctx, now)` 签名改为 `AdminMetrics(ctx, period, now)`（period 决定按月卡片，now 决定当前存储/文件数快照）。

## 边界与取舍

- **不做历史回填**：计量自本功能上线起累加。下载历史本就不存在，上传历史已被 GC 清除；若只回填中继会造成"中继有历史、上传下载为 0"的误导。过去月份一律 0，spec/文档写明"计量自 X 日上线起生效"。
- **月份边界用 UTC**。若日后要按北京时间出账，把 `periodOf` 改成固定 UTC+8 偏移即可（单点改动）。
- **存储为当前快照**，非 GB-月。真正的存储时长计费（GB-月）需定期采样，属后续独立工作，本设计不含。
- **best-effort 写入**：计量失败绝不阻断用户的上传/下载。
- **计费本身不在本设计范围**：本设计只做"准确记录 + 后台展示"，出账单/定价是后续。

## 测试（沿用 `sqlite_test.go` / `admin_test.go` 写法）

1. `RecordMeter`：同月累加、跨月开新行、`kind` 选对列、并发/重复调用累加正确。
2. `periodOf`：跨月边界（UTC）取值正确。
3. `AdminListUsers`：带 period 的 LEFT JOIN 正确；无 `usage_monthly` 行显示 0；存储子查询**排除过期文件**；选定月中继聚合正确；各列排序。
4. `AdminMetrics(period, now)`：按月三卡片求和正确；存储/用户/文件快照与 period 无关。
5. 端到端：一次真实上传 → 后台当月该用户上传列 = 该文件 size；一次下载 → 属主下载列增加、下载方无记录。

## 涉及文件

- `server/internal/account/sqlite.go` — 建表、`RecordMeter`、`periodOf`、改 `AdminListUsers` / `AdminMetrics`。
- `server/internal/account/store.go` — `UsageKind`、`RecordMeter` 接口、`AdminUserRow` / `AdminUserQuery` / `AdminMetrics` 字段。
- `server/internal/account/files.go` — 两处 `RecordMeter` 调用。
- `server/internal/account/admin.go` — 解析 `period`、组织月份下拉、传参。
- `server/internal/account/admin_templates.go` — 月份下拉、新表格列、汇总卡片增删、排序表头。
- 对应 `_test.go`。
- `docs/DEPLOYMENT.md` 或 admin 页脚注 — "计量自上线起生效"。
