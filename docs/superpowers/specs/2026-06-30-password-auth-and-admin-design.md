# 账号密码登录 + 管理后台 设计

日期：2026-06-30
状态：已确认，待实现

## 背景与目标

当前 `account` 包提供两种登录方式：Google OAuth 和邮箱 magic-link。两者都遇到了配置/发信问题。本次工作：

1. **保留但停用** Google 与邮箱 magic-link 登录（代码完整保留，可随时翻开关恢复）。
2. **新增**邮箱 + 密码的注册/登录方式，不依赖发邮件。
3. **新增**一个服务端渲染的管理后台 `/admin`，用独立管理员密码访问，只读查看注册用户情况。

## 已确认的决策

- 账号密码以 **邮箱** 为登录标识，沿用现有 `users` 表的 email 唯一键。
- 密码注册 **不做邮箱验证**，注册即登录。
- 停用 Google/magic-link 的方式：**前端隐藏入口 + 后端开关关闭路由**。
- 管理后台用 **独立管理员密码 + `/admin` 页面**，与普通用户体系隔离。
- 同一邮箱将来可同时绑定密码与 Google，共用同一个账号。
- 后台为 **只读** 展示，本期不含封禁/删除等操作。
- 管理员登录态用 **内存存储**，服务器重启需重新登录。

## 架构

沿用现有分层：`Store` 接口（SQLite 实现）↔ `Service`（业务逻辑）↔ HTTP handlers。前端为 Svelte 5 单页（`Account.svelte` + `auth.svelte.ts`）。

### 1. 账号密码注册/登录

**数据层（`sqlite.go`）**
- `users` 表新增可空列 `password_hash TEXT`。
- 新库：直接在 `CREATE TABLE` 中含该列。
- 老库迁移：`OpenSQLite` 中执行幂等的 `ALTER TABLE users ADD COLUMN password_hash TEXT`，忽略 "duplicate column name" 错误（SQLite 无 `IF NOT EXISTS` for ADD COLUMN，靠捕获错误实现幂等）。

**Store 接口新增（`store.go`）**
```go
SetPassword(ctx context.Context, userID, passwordHash string) error
GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)
```
`ok=false` 表示该邮箱不存在或未设密码。

**Service（新文件 `password.go`，依赖 `golang.org/x/crypto/bcrypt`）**
- `Register(ctx, email, password, displayName) (Session, error)`：
  - `normEmail` 规范化邮箱；校验密码长度 ≥ 8，否则返回错误。
  - 若 `GetCredentials` 显示该邮箱已设密码 → 返回 `ErrEmailTaken`（handler 映射 409）。
  - `UpsertUserByEmail` 取/建用户 → `bcrypt.GenerateFromPassword` → `SetPassword` → `LinkIdentity("password", email, userID)` → `IssueSession`。
- `Login(ctx, email, password) (Session, error)`：
  - `GetCredentials`；`ok=false` 或 `bcrypt.CompareHashAndPassword` 失败 → 统一返回 `ErrBadCredentials`（不区分"用户不存在"与"密码错误"，防枚举）。
  - 成功 → `IssueSession`。

**Handlers（`handlers.go`）**
- `POST /api/auth/register`，JSON body `{email, password, displayName?}`。成功设 session cookie，返回 `{"user":{…}}`；密码过短 400；邮箱已占用 409。
- `POST /api/auth/password/login`，JSON body `{email, password}`。成功设 cookie 返回用户；失败 401 `{"error":"invalid credentials"}`。

### 2. 停用 Google + magic-link

**Config（`service.go`）** 新增：
```go
EnableGoogle bool
EnableMagic  bool
```
**Routes（`handlers.go`）**：仅当对应开关为 true 时才 `mux.HandleFunc` 注册 google / magic 路由。关闭时端点不存在（404）。

**main.go** 新增 flag：`-enable-google`（默认 false）、`-enable-magic`（默认 false），写入 Config。

**新增端点** `GET /api/auth/methods`（公开，无需登录）返回：
```json
{"password": true, "google": false, "magic": false}
```
`password` 恒为 true；`google`/`magic` 反映开关。前端据此渲染入口。

### 3. 管理后台

**main.go** 新增 flag `-admin-pass`（默认空 = 后台禁用）。写入 `Config.AdminPassword`。

**鉴权（新文件 `admin.go`）**：与普通 session 隔离。
- 独立 cookie：`relayium_admin`，值为登录时生成的随机 token。
- Service 持有内存集合 `adminSessions map[string]int64`（token → 过期时间戳），带互斥锁；TTL 例如 12 小时。
- `POST /admin/login`：表单字段 `password`，与 `AdminPassword` 常量时间比较（`crypto/subtle.ConstantTimeCompare`）；成功生成 token、入表、设 httpOnly cookie、重定向 `/admin`；失败重新显示带错误的表单。
- `POST /admin/logout`：删 token、清 cookie。
- `requireAdmin` 包装器：校验 cookie token 在表中且未过期。

**页面（`html/template` 服务端渲染）**：
- `GET /admin`：未登录 → 密码登录表单；已登录 → 用户表格。
- 仅当 `AdminPassword != ""` 时才注册这些路由（否则后台整体禁用）。

**数据（Store 新增）**：
```go
AdminListUsers(ctx context.Context) ([]AdminUserRow, error)
```
`AdminUserRow` 字段：`ID, Email, DisplayName, CreatedAt, Methods []string, DeviceCount int, RelayedBytes int64`。
- `Methods` 由 `identities` 表按 provider 聚合（`password`/`google`/`email`）。
- `DeviceCount` 来自 `devices` 表计数。
- `RelayedBytes` 来自 `usage_events` 求和。
- 实现可用一条主查询 + 子查询/JOIN；按 `created_at DESC` 排序。

页面展示列：邮箱、显示名、注册时间（格式化）、登录方式、设备数、中继流量；顶部显示总用户数。

## 错误处理

- 注册/登录失败返回明确但不泄露枚举信息的 JSON。
- 后台密码错误不区分原因，仅提示"密码错误"。
- DB 不可用时（现有逻辑）整个 `/api` 与 `/admin` 不挂载，LAN 传输不受影响。

## 测试

**Go（`account` 包）**
- `Register` 成功路径、密码过短、重复邮箱返回 `ErrEmailTaken`。
- `Login` 成功、错误密码、不存在邮箱均返回 `ErrBadCredentials`。
- `password_hash` 迁移在老库上幂等（连续 OpenSQLite 两次不报错）。
- `methods` 端点随 `EnableGoogle/EnableMagic` 变化。
- google/magic 路由在开关关闭时返回 404。
- `requireAdmin`：无/错 cookie 拒绝，正确 token 放行；`AdminPassword` 为空时 `/admin` 不存在。
- `AdminListUsers` 聚合正确（方法、设备数、流量）。

**Web**
- `Account.svelte` 根据 `/api/auth/methods` 条件渲染（密码表单始终在，google/magic 隐藏）。
- 注册/登录调用打到正确端点。

## 改动文件清单

后端：
- `server/internal/account/store.go` — 接口 + `AdminUserRow` 类型
- `server/internal/account/sqlite.go` — schema 列 + 迁移 + `SetPassword`/`GetCredentials`/`AdminListUsers`
- `server/internal/account/service.go` — Config 新字段
- `server/internal/account/password.go`（新）— `Register`/`Login` + bcrypt + 哨兵错误
- `server/internal/account/handlers.go` — register/login/methods 路由；google/magic 条件注册
- `server/internal/account/admin.go`（新）— 管理员鉴权 + 后台页面
- `server/main.go` — `-enable-google`/`-enable-magic`/`-admin-pass` flag + 接线
- `server/go.mod` / `go.sum` — 加 `golang.org/x/crypto`

前端：
- `web/src/lib/auth.svelte.ts` — `register`/`passwordLogin`/`fetchAuthMethods`
- `web/src/lib/Account.svelte` — 密码注册/登录表单 + 条件渲染
- `web/src/lib/i18n.svelte.ts` — 新增文案（多语言）

## 非目标（YAGNI）

- 密码找回 / 重置（依赖发邮件，本期跳过）。
- 邮箱验证。
- 后台的用户编辑/封禁/删除。
- 管理员登录态持久化（重启需重登）。
- 限流 / 验证码（可后续按需加）。
