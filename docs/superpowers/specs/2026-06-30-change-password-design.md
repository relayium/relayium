# 设置 / 修改密码 — 设计文档

日期：2026-06-30
状态：已批准，待写实现计划

## 目标

让登录用户在个人中心（账号下拉菜单）设置或修改自己的登录密码：
- 已有密码的用户 → 验证当前密码后修改。
- 用 Google / 魔法链接注册、尚无密码的用户 → 直接设置一个密码，使其之后也能用邮箱+密码登录。
- 改密成功后，登出该账号在其他设备/浏览器上的所有会话（保留当前会话）。

## 约束与既有事实

- 已有：`bcrypt` 哈希、`Service.Register`/`Login`、`store.SetPassword(uid, hash)`、
  `store.GetCredentials(email) → (uid, hash, ok)`、`store.LinkIdentity(kind, key, uid)`、
  `store.RevokeSession(sessionID)`、`minPasswordLen = 8`。
- 账号 UI 目前是 `Account.svelte` 的一个小下拉菜单（登录态仅显示邮箱 + 退出）。
- 鉴权中间件 `RequireSession` 注入 `User`，但不传 session id；改密需要当前 session id 来"撤销其他会话"，
  故在 handler 内从 cookie（`sessionCookie`）直接取当前 session id。

## 后端（Go）

### 新接口 `POST /api/auth/password/change`（`RequireSession`）

请求体：`{ "currentPassword": string (可选), "newPassword": string }`

逻辑：
1. `uid, hash, hasPass, err := store.GetCredentials(u.Email)`（判断是否已有密码并取哈希）。
2. 若 `hasPass`：`bcrypt.CompareHashAndPassword(hash, currentPassword)` 失败 → `401`（`{"error":"current password incorrect"}`）。
3. 校验 `len(newPassword) >= minPasswordLen`，否则 `400`（复用 `ErrWeakPassword` → `{"error":"password too short"}`）。
4. `newHash = bcrypt.GenerateFromPassword(newPassword)` → `store.SetPassword(u.ID, newHash)`。
5. 若 `!hasPass`：`store.LinkIdentity("password", normEmail(u.Email), u.ID)`（无密码用户首次设密时建立 password 身份，使其可邮箱+密码登录）。
6. 撤销其他会话：从 cookie 取当前 session id，`store.RevokeUserSessions(ctx, u.ID, currentSessionID)`。
7. `200`（`{"status":"ok"}`）。

服务层方法 `Service.ChangePassword(ctx, u User, currentSessionID, currentPassword, newPassword string) error`
封装 2–6 步，返回哨兵错误（`ErrBadCredentials` 用于旧密码错、`ErrWeakPassword` 用于太短），
handler 负责状态码映射。

### 新存储方法

- `RevokeUserSessions(ctx context.Context, userID, exceptID string) error`
  —— `DELETE FROM sessions WHERE user_id = ? AND id <> ?`。
- `HasPassword(ctx context.Context, userID string) (bool, error)`
  —— 是否存在 `password` 类型凭据/身份（按 schema 选 credentials 或 identities 表查询；
  实现时以现有 `GetCredentials`/`LinkIdentity` 落表方式为准）。

两者都加入 `Store` 接口，并在 `SQLiteStore` 实现。

### `/api/me` 增加 `hasPassword`

`handleMe` 调 `store.HasPassword(u.ID)`，响应体的 user 对象增加 `"hasPassword": bool`，
供前端决定显示"设置密码"（无需当前密码）还是"修改密码"（需当前密码）。

## 前端（Svelte）

### `auth.svelte`
- `session().user` 类型增加 `hasPassword: boolean`；`refreshSession` 从 `/api/me` 读入。
- 新增 `changePassword(currentPassword, newPassword): Promise<{ok: boolean; error?: string}>`，
  `POST /api/auth/password/change`（`credentials: include`）。成功后本地把 `hasPassword = true`。

### `Account.svelte`（登录态菜单）
- 在"退出"按钮旁增加一个可展开的 **「修改密码 / 设置密码」** 区（标题随 `hasPassword` 切换）。
- 表单字段：
  - 「当前密码」—— 仅当 `hasPassword` 为真时显示。
  - 「新密码」「确认新密码」。
- 提交：
  - 客户端先校验两次新密码一致（否则 `errMismatch`）且长度 ≥ 8（否则 `errTooShort`）。
  - 调 `changePassword`；成功 → 显示 `pwChanged` 提示、清空字段、收起表单；
    失败 → 映射错误（旧密码错 `errCurrentWrong` / 太短 `errTooShort`）。

### i18n（`account` 段，6 语言）
新增键：`changePassword`、`setPassword`、`currentPassword`、`newPassword`、`confirmPassword`、
`pwChanged`、`errCurrentWrong`、`errMismatch`。（`errTooShort` 已存在，复用。）

## 错误处理

| 情况 | 状态码 | 前端文案 |
|---|---|---|
| 旧密码错（已有密码用户） | 401 | `errCurrentWrong` |
| 新密码太短 | 400 | `errTooShort` |
| 两次新密码不一致 | 前端拦截 | `errMismatch` |
| 未登录 | 401（RequireSession） | 不显示该入口 |

## 测试

- **后端**
  - `Service.ChangePassword`：已有密码改密成功；旧密码错 → `ErrBadCredentials`；
    新密码太短 → `ErrWeakPassword`；无密码用户设密成功并随后 `Login` 可用（验证 LinkIdentity）。
  - 改密后其他会话被撤销、当前 session 仍有效（`RevokeUserSessions` 行为）。
  - `HasPassword`：有/无密码两种情况。
  - handler：401/400/200 状态码映射。
- **前端**
  - `changePassword` 调用与错误映射；i18n 完整性测试纳入新 `account` 键。

## 集成点

- `server/internal/account/password.go` — `Service.ChangePassword` + 哨兵错误。
- `server/internal/account/handlers.go` — 注册 `POST /api/auth/password/change`；`handleMe` 加 `hasPassword`。
- `server/internal/account/store.go` + `sqlite.go` — `RevokeUserSessions`、`HasPassword`。
- `web/src/lib/auth.svelte.ts` — 类型 + `changePassword`。
- `web/src/lib/Account.svelte` — 改密表单。
- `web/src/lib/i18n.svelte.ts` — `account` 段新键（6 语言）。
