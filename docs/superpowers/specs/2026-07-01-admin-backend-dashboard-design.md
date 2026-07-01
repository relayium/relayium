# 管理员后台优化设计:数据看板 + 列表可用性

**日期**: 2026-07-01
**范围**: 只做管理员后台的「快照数据看板」与「用户列表分页/搜索/排序」。是 2026-07-01 管理员 2FA 之后约定的独立后台优化 spec 的第一块。

## 目标

- 在 `/admin` 首页顶部加一排**快照指标卡**,让运营者一眼看到关键运行数据。
- 把只读用户列表从「一次性拉全表」升级为**分页 + 搜索 + 排序**。
- 继续服务端渲染,保持后台零构建、无前端框架的现状。

## 非目标

- 不引入任何**写操作**(不禁用/删除用户、不重置密码、不删文件、不按用户调配额)。
- 不做时间序列趋势图/交互式图表/SPA(看板只呈现当前快照数字)。
- 不引入前端框架、图表库或新的重依赖。
- 不做内容/文件管理视图(stored_files 明细的浏览/删除是后续 spec)。

## 现状(实现前)

- 后台是 `server/internal/account/admin.go` 里两个内联 `html/template`:登录页 + 首页。首页 = 只读用户表 + 4 项暂存设置表单。
- 用户列表:`handleAdminHome` → `store.AdminListUsers(ctx)`,`SELECT ... ORDER BY created_at DESC` **一次性拉全表**,无分页/搜索/排序。行类型 `AdminUserRow{Email, DisplayName, CreatedAt, Methods, DeviceCount, RelayedBytes}`(`store.go`)。
- `stored_files` / `usage_events` / `upload_events` 等表后台完全不可见,无任何聚合。
- `Store` 接口在 `store.go`,唯一实现 `SQLiteStore`(`sqlite.go`)。设置读写走 `settings` 表(`settings.go`)。
- admin.go 现已承载:登录、TOTP 2FA、内存 session、首页、设置——文件偏大。

相关表字段(`sqlite.go`,均为 unix 秒时间戳):
- `users(id, email, display_name, created_at)`
- `stored_files(id, user_id, blob_key, size, burn_after_read, created_at, expires_at, downloaded_at)`;已有 `idx_stored_files_expires(expires_at)`
- `usage_events(alloc_id, token, user_id, relayed_bytes, recorded_at)`;已有 `idx_usage_user(user_id)`
- `upload_events(id, user_id, bytes, uploaded_at)`;已有 `idx_upload_events_user(user_id, uploaded_at)`
- `devices(id, user_id, name, created_at, last_seen_at)`

## 设计

### 1. 数据看板(快照指标卡)

首页表格上方渲染一排卡片。取值来自 `Store` 新增的一个聚合方法,一次调用返回全部指标,避免多次往返。

**新增 Store 方法**(接口 + SQLiteStore 实现):
```go
// AdminMetrics 是后台首页的快照指标。所有字节数为累计值,时间窗口以调用时的 now 为基准。
type AdminMetrics struct {
    TotalUsers        int64
    ActiveStoredFiles int64 // 未过期暂存文件数
    ActiveStoredBytes int64 // 上述文件的 size 之和(近似当前磁盘占用)
    RelayedBytes24h   int64
    RelayedBytes7d    int64
    UploadedBytes24h  int64
}

// AdminMetrics 计算首页快照指标。now 由 Service 注入(便于测试)。
AdminMetrics(ctx context.Context, now int64) (AdminMetrics, error)
```

**各指标 SQL 语义**(全部用 `COALESCE(SUM(...),0)` 防 NULL):
- `TotalUsers` = `SELECT COUNT(*) FROM users`
- `ActiveStoredFiles` / `ActiveStoredBytes` = `SELECT COUNT(*), COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > now`
  - 口径说明:以「未过期」近似当前磁盘占用。阅后即焚已下载但尚未被 GC 清理的文件可能被计入,属可接受的近似;在卡片旁或代码注释注明。
- `RelayedBytes24h` = `SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= now-86400`
- `RelayedBytes7d` = 同上,`now-604800`
- `UploadedBytes24h` = `SELECT COALESCE(SUM(bytes),0) FROM upload_events WHERE uploaded_at >= now-86400`(滚动 24h,与 daily_quota 口径一致)

**新增索引**(`sqlite.go` 的 schema 常量里追加,`CREATE INDEX IF NOT EXISTS` 幂等):
- `idx_usage_recorded ON usage_events(recorded_at)`
- `idx_upload_uploaded ON upload_events(uploaded_at)`

**渲染**:5 张卡片(总用户数 / 未过期暂存文件数 + 占用存储 / 中继流量·近 24h / 中继流量·近 7d / 上传量·近 24h),字节数用现有 `humanBytes`。样式沿用现有内联 CSS 风格,加一个简单的卡片 grid。

### 2. 用户列表可用性(分页 / 搜索 / 排序)

把 `AdminListUsers` 从「拉全表」改为带查询参数、返回一页 + 总数。

**Store 接口变更**:
```go
type AdminUserQuery struct {
    Search  string // 空 = 不过滤;非空按 email/display_name 模糊匹配
    SortBy  string // "created" | "email" | "relayed";非法值回退 "created"
    SortDir string // "asc" | "desc";非法值回退 "desc"
    Limit   int    // 页大小
    Offset  int    // (page-1)*Limit
}

// AdminListUsers 返回一页用户行与匹配总数(用于分页)。
AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)
```
- **搜索**:`WHERE email LIKE ?  OR display_name LIKE ?`,参数 `%q%`;`q` 里的 `%`/`_` 需转义(用 `LIKE ... ESCAPE '\'`)。`total` 是同一 WHERE 下的 `COUNT(*)`。
- **排序**:白名单映射 `SortBy` → 列(`created`→`created_at`,`email`→`email`,`relayed`→中继流量聚合列),`SortDir` → `ASC/DESC`;**绝不把用户输入拼进 SQL**,只在白名单内取列名。`relayed` 排序依赖行内已算的中继流量聚合(现有 `AdminListUsers` 已计算 `RelayedBytes`,把该表达式用于 ORDER BY)。默认 `created_at DESC`。稳定排序:次级键固定 `id`。
- **分页**:`LIMIT ? OFFSET ?`。

**Handler `handleAdminHome`**:
- 解析 query:`q`(搜索)、`sort`、`dir`、`page`(默认 1;`<1` 或非数字回退 1)。
- 页大小常量 `adminUsersPerPage = 50`。
- 组装 `AdminUserQuery{Search:q, SortBy:sort, SortDir:dir, Limit:50, Offset:(page-1)*50}`,调用 `AdminListUsers` 拿 rows+total,连同 `AdminMetrics` 一起塞进模板数据。
- 计算总页数 `ceil(total/50)`;`page` 超出末页时按末页处理(或显示空列表 + 提示,实现时择一并在计划里定死为「钳制到 [1, maxPage]」)。
- 模板渲染:搜索框(`GET` 表单,保留当前 sort/dir)、可点击排序的表头(链接切换 sort/dir,携带 q/page)、上一页/下一页链接(携带 q/sort/dir),显示「第 X/Y 页,共 N 条」。所有链接用 `url.Values` 构造,值经模板转义。

### 3. 代码组织(顺手改善)

admin.go 已偏大(登录 + 2FA + session + 首页 + 设置)。本次:
- 把内联 HTML 模板从 admin.go **拆到新文件 `server/internal/account/admin_templates.go`**(登录模板、首页模板及模板 FuncMap);admin.go 只留 handler / session / 校验逻辑。
- 看板与列表的查询参数解析辅助函数就近放在 admin.go 的 handler 附近。
- 不做本范围之外的重构。

### 4. 测试

`server/internal/account/` 下,沿用现有表驱动 + `now` 注入风格:
- **AdminMetrics(Store 层)**:在含样例数据的库(`:memory:`)上,构造已知的 users / stored_files(部分已过期)/ usage_events(部分在 24h 内、部分在 24h-7d、部分更早)/ upload_events(跨 24h 边界),断言 6 个指标的精确值,尤其**窗口边界**(recorded_at == now-86400 的取舍)。
- **AdminListUsers(Store 层)**:搜索命中(邮箱/显示名,含 `%` 转义用例)、total 计数与 WHERE 一致、三种 SortBy × 两种方向、Limit/Offset 分页正确、非法 SortBy/SortDir 回退默认。
- **handleAdminHome(Handler 层)**:登录态下渲染出指标卡与用户表;带 `q/sort/dir/page` 的请求命中对应子集;`page` 超界被钳制;未登录跳登录页(回归)。
- 现有 admin/2FA/settings 测试保持绿。

## 涉及文件(预估)

- `server/internal/account/store.go` — 新增 `AdminMetrics` 类型、`AdminUserQuery` 类型;`Store` 接口加 `AdminMetrics(...)`、改 `AdminListUsers(...)` 签名。
- `server/internal/account/sqlite.go` — 实现 `AdminMetrics` 聚合查询;改写 `AdminListUsers`(WHERE/ORDER/LIMIT/OFFSET + COUNT);schema 追加两个索引。
- `server/internal/account/admin.go` — `handleAdminHome` 解析分页/搜索/排序参数,调用新方法,组装模板数据;移出模板。
- 新增 `server/internal/account/admin_templates.go` — 迁出的登录/首页模板 + FuncMap。
- 测试:`server/internal/account/sqlite_test.go`(或就近)+ `admin_test.go`。

## 关键决策记录(均已与用户确认)

- 只做**读取/观测向**:看板 + 列表可用性;不做写操作、不做文件管理。
- 看板只呈现**当前快照数字**,服务端渲染,无图表库/SPA。
- 指标卡固定 5 项(总用户、未过期暂存文件+存储、中继近 24h、中继近 7d、上传近 24h)。
- 用户列表:搜索(邮箱/显示名)、排序(注册时间默认倒序/邮箱/中继流量)、每页 50。
- SQL 排序列走白名单,绝不拼接用户输入;`LIKE` 转义;存储口径用「未过期」近似。
