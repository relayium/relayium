# 邮箱验证 + 忘记密码（邮件重置）设计文档

- 日期：2026-07-09
- 状态：已定稿，待实现
- 相关代码：`server/internal/account/*`、`web/src/lib/{auth.svelte.ts,Account.svelte,MePage.svelte}`

## 1. 背景与目标

现状：密码注册只收「邮箱 + 密码」，注册即发 session，**从未验证邮箱真实性**；密码只能在登录态下用旧密码修改，**没有「忘记密码」找回入口**。

本次要补齐两件事，并把网站接到服务器上已部署的 docker-mailserver：

1. **注册邮箱验证**：新用户注册后必须点邮件里的验证链接才能登录。
2. **忘记密码 / 邮件重置**：未登录用户可凭邮件里的重置链接设置新密码。

### 已拍板的产品决策（brainstorming 结论）

| 决策点 | 结论 |
|---|---|
| 邮件服务栈 | **docker-mailserver (DMS)**，同机 Docker 容器 |
| 邮件 DNS | MX / SPF / DKIM / DMARC **已全部配好可用** |
| 注册验证体验 | **必须验证后才能登录**（最严格） |
| 存量老用户 | **全部视为已验证**，只有新注册走验证流程，不打扰现网用户 |
| 忘记密码 | **本次一并实现** |
| 发件邮箱 | **`noreply@relayium.com`**（注意：无连字符，与代码旧默认值 `no-reply@` 不同） |
| 邮件主机名 | `mail.relayium.com`（A 记录 → `<production-app-server-IP>` 本机；SMTP 用主机名连接以匹配 TLS 证书 CN） |

## 2. 复用的现有基础设施

代码底子已经很适合加这个功能，尽量复用、少造轮子：

- **`magic_tokens` 模式**（`sqlite.go`）：哈希存储、一次性、带 TTL、`UseMagicToken` 原子消费。→ 新的 `email_tokens` 表照抄这套。
- **`Mailer` 接口 + `SMTPMailer`**（`mailer.go`）：`net/smtp` + `smtp.SendMail`，连接时先 STARTTLS 再认证，`:587` 提交端口天然支持。→ 扩接口、复用 `SMTPMailer`。
- **`loginThrottle`**（`throttle.go`）：per `email+IP` 限流。→ 验证重发、忘记密码复用，防邮件轰炸。
- **`csrfGuard`**、**Store 接口缝隙**、**bcrypt 哈希**、**`RevokeUserSessions`**：直接沿用。
- **幂等 ALTER 迁移套路**（`OpenSQLite`）：`ALTER TABLE ... ADD COLUMN`，靠 `duplicate column name` 字符串判定幂等。→ 加 `email_verified` 列用同一套。

## 3. 数据模型改动

全部走现有的「schema 常量 + 幂等 ALTER」套路，无正式迁移器。

### 3.1 `users` 加 `email_verified` 列 + 老用户兜底

在 `OpenSQLite` 里追加（紧跟现有 `password_hash` 那段）：

```go
// email_verified 是本次新增列。首次成功 ALTER（err==nil）说明是刚建列，
// 此刻把所有已存在的老用户一次性标记为已验证（兜底，避免现网用户被锁）。
// 之后新注册的行按 DEFAULT 0 走验证流程；列已存在时报 "duplicate column name" 幂等跳过。
if _, err := db.ExecContext(ctx,
    `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); err != nil {
    if !strings.Contains(err.Error(), "duplicate column name") {
        db.Close(); return nil, err
    }
    // 列已存在 → 非首次运行 → 不动老数据
} else {
    // 首次建列成功 → 把存量用户全部兜底为已验证
    if _, err := db.ExecContext(ctx, `UPDATE users SET email_verified = 1`); err != nil {
        db.Close(); return nil, err
    }
}
```

**关键性质**：兜底 UPDATE 只在「建列那一次」执行；此后新用户经 `UpsertUserByEmail` 插入，不带 `email_verified` → 落 DEFAULT 0 → 未验证。

### 3.2 新表 `email_tokens`（验证 + 重置两用）

加进 `schema` 常量：

```sql
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,              -- 'verify' | 'reset'
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0  -- 0 = 未用
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);
```

### 3.3 `User` 结构体加字段

`store.go` 的 `User` 加 `EmailVerified bool`，并在 `GetUserByID` / `UpsertUserByEmail` 的 SELECT 里带出（`UpsertUserByEmail` 新建时 verified=false）。让 `/api/me`、`writeUser` 能把状态透出给前端。

## 4. Store 接口新增方法

`store.go` 的 `Store` 接口 + `sqlite.go` 实现：

```go
// email verification state
EmailVerified(ctx context.Context, userID string) (bool, error)
SetEmailVerified(ctx context.Context, userID string) error
// email tokens (verify + reset)
CreateEmailToken(ctx context.Context, t EmailToken) error
// UseEmailToken 原子消费：仅当 未用 且 未过期 且 purpose 匹配 时成功，返回一次。
UseEmailToken(ctx context.Context, tokenHash, purpose string, now int64) (EmailToken, bool, error)
DeleteSpentEmailTokens(ctx context.Context, now int64) error
```

`EmailToken` 领域结构体（`store.go`）：

```go
type EmailToken struct {
    TokenHash string
    UserID    string
    Email     string
    Purpose   string // "verify" | "reset"
    CreatedAt int64
    ExpiresAt int64
    UsedAt    int64
}
```

`UseEmailToken` 的 SQL 照抄 `UseMagicToken`，多一个 `purpose = ?` 条件：

```sql
UPDATE email_tokens SET used_at = ?
 WHERE token_hash = ? AND purpose = ? AND used_at = 0 AND expires_at > ?
```

`DeleteSpentEmailTokens` 与 `DeleteSpentMagicTokens` 一致，接入现有 GC 定时任务（与 magic token GC 同处调用）。

## 5. Mailer 扩展

`mailer.go`：`Mailer` 接口从只会发 magic link 扩成三个方法：

```go
type Mailer interface {
    SendMagicLink(ctx context.Context, email, link string) error
    SendVerifyEmail(ctx context.Context, email, link string) error
    SendPasswordReset(ctx context.Context, email, link string) error
}
```

- `SMTPMailer`：抽一个私有 `send(to, subject, textBody, htmlBody string) error`，用 `multipart/alternative` 同时发 **纯文本 + 品牌 HTML**（提升送达率、观感）。三个公开方法各自拼主题/正文后调 `send`。`SendMagicLink` 改为走 `send`（行为不变）。
- `LogMailer`：新增两个方法照样打日志（开发/测试用，测试靠它抓链接）。
- **解耦 SMTP 与 magic 开关**：`main.go` 里只要 `RELAYIUM_SMTP_ADDR` 非空就启用 `SMTPMailer`，不再与 `EnableMagic` 绑定。验证/重置邮件不依赖 magic-link 功能开关。

邮件文案（中英按 `RELAYIUM_BASE_URL` 站点语言，或先英文为主，i18n 后续）：
- 验证邮件主题：`Verify your Relayium email` / 正文含验证链接 + 「24 小时内有效、非本人请忽略」。
- 重置邮件主题：`Reset your Relayium password` / 正文含重置链接 + 「1 小时内有效、非本人请忽略」。

## 6. 后端流程与端点

### 6.1 Config 新增

`service.go` 的 `Config` 加：

```go
VerifyTTL time.Duration // 邮箱验证链接有效期，默认 24h
ResetTTL  time.Duration // 密码重置链接有效期，默认 1h
```

`main.go` 给默认值（可选 env `RELAYIUM_VERIFY_TTL` / `RELAYIUM_RESET_TTL`，默认 24h / 1h）。

### 6.2 端点清单（`routeMux`）

| 方法 & 路径 | 处理 | 说明 |
|---|---|---|
| `POST /api/auth/register` | 改造 | 建用户(verified=0) + 发验证邮件，**不发 session** |
| `POST /api/auth/email/verify` | 新增 | body `{token}`；验证成功→标记 verified→**发 session 自动登录** |
| `POST /api/auth/email/resend` | 新增 | body `{email}`；防枚举永远 200；throttle |
| `POST /api/auth/password/login` | 改造 | 账密对但未验证→403 `email_unverified`，**不发 session** |
| `POST /api/auth/password/forgot` | 新增 | body `{email}`；防枚举永远 200；throttle |
| `POST /api/auth/password/reset` | 新增 | body `{token,newPassword}`；设新密码+吊销全部 session+标记 verified+发 session |

### 6.3 Service 层方法（`password.go` / 新文件 `verify.go`）

**Register 改造**（`password.go`）：去掉结尾的 `IssueSession`，改为创建 verify token 并发邮件，返回 `(User, error)` 或直接 `error`。Handler 返回 `{status:"verification_sent", email}`，不再 set cookie。

```go
// Register 建密码账号（未验证），发验证邮件；不发 session。
func (s *Service) Register(ctx, email, password, displayName) (User, error)
// SendVerifyEmail 生成 verify token 并发信（供 register / resend 复用）
func (s *Service) SendVerifyEmail(ctx, u User) error
// VerifyEmail 消费 token → 标记 verified → 发 session
func (s *Service) VerifyEmail(ctx, rawToken) (Session, error)  // 失败 ErrInvalidToken
```

**Login 改造**（`password.go`）：bcrypt 校验通过后，查 `EmailVerified(uid)`；false → 返回新错误 `ErrEmailUnverified`（不发 session）。Handler 映射为 403 + `{error:"email_unverified", email}`，前端据此显示「去验证 / 重发」。

**Forgot / Reset**（新文件 `reset.go`）：

```go
// RequestPasswordReset 查用户+有密码则发重置邮件；无声失败（防枚举）
func (s *Service) RequestPasswordReset(ctx, email) error
// ResetPassword 消费 reset token → 设新密码 → 吊销全部 session → 标记 verified → 发 session
func (s *Service) ResetPassword(ctx, rawToken, newPassword) (Session, error)
```

新错误哨兵（`password.go`）：`ErrEmailUnverified`、`ErrInvalidToken`。

### 6.4 Handler 防枚举 & 限流（照抄 `handleMagicRequest`）

`email/resend` 与 `password/forgot`：per `email+IP` throttle（各自一个 `*loginThrottle`，`NewService` 里初始化），超限静默跳过发信，**无论邮箱是否存在/是否超限一律 200**。

### 6.5 链接格式

验证链接指向**前端 SPA 页**（不是后端直跳），让前端展示状态并调 API：

```
验证：{BaseURL}/verify-email?token={raw}
重置：{BaseURL}/reset-password?token={raw}
```

（对比现有 magic-link 是后端 `GET .../magic/verify` 直跳；这里用前端页是为了展示成功/失败 UI 和自动登录后跳转。）

### 6.6 magic-link / Google 流程的一致性（小修）

`VerifyMagicLink`、Google callback 里 `UpsertUserByEmail` 之后调 `SetEmailVerified(u.ID)`——这两条路径本身即证明了邮箱所有权（magic 收信、Google `EmailVerified`）。二者默认关闭，但保持逻辑自洽。

## 7. 前端改动（Svelte 5）

- `web/src/lib/auth.svelte.ts`：
  - `register()` 改为期望 `{status:"verification_sent"}`，不再期望 user/session。
  - 新增 `verifyEmail(token)`、`resendVerification(email)`、`forgotPassword(email)`、`resetPassword(token, newPassword)`。
  - `passwordLogin()` 处理 403 `email_unverified`：抛出可识别错误，UI 显示重发入口。
  - `refreshSession()`/`me` 读取 `emailVerified` 暴露给 UI。
- `web/src/lib/Account.svelte`：
  - 注册成功 → 展示「验证邮件已发到 xxx，请查收」+「没收到？重发」。
  - 登录遇 `email_unverified` → 同上提示 + 重发按钮。
  - 登录表单加「忘记密码？」→ 输入邮箱 → 调 `forgotPassword` → 展示「若邮箱存在已发送重置邮件」。
- 新增两个 SPA 视图（走现有前端路由机制）：
  - `/verify-email`：读 URL `token` → 调 `verifyEmail` → 成功则已登录跳首页，失败提示「链接无效或已过期」+ 重发入口。
  - `/reset-password`：读 URL `token` → 输入新密码 → 调 `resetPassword` → 成功则已登录跳首页。
- i18n：`web/src/lib/i18n/` 补齐上述文案的中英 key。

## 8. 配置 / 环境变量（对接 DMS）

`<production-server>/server/.env` 追加（**发件地址无连字符**）：

```dotenv
RELAYIUM_SMTP_ADDR=mail.relayium.com:587
RELAYIUM_SMTP_FROM=noreply@relayium.com
RELAYIUM_SMTP_USER=noreply@relayium.com
RELAYIUM_SMTP_PASS=<DMS 里 noreply 邮箱的口令>
RELAYIUM_BASE_URL=https://relayium.com
```

- 用 `mail.relayium.com:587` 而非 `127.0.0.1:587`：`SMTPMailer` 走 `smtp.SendMail`，STARTTLS 用 addr 的主机名作 `ServerName` 校验证书，主机名才能匹配 DMS 证书 CN（`mail.relayium.com`）。**无需改 Mailer 代码。**
- 把 `main.go` 里 `RELAYIUM_SMTP_FROM` 默认值从 `no-reply@relayium.com` 改为 `noreply@relayium.com`（保持与实际邮箱一致；即便如此仍以 `.env` 显式值为准）。

## 9. 服务器运维 Runbook（DMS 侧，多数已完成）

> 用户已完成绝大部分；此处留作记录与验证步骤。容器名以 `docker ps` 实际为准。

1. **建发件邮箱**（已完成 ✅）：
   ```bash
   docker exec -ti <dms容器名> setup email add noreply@relayium.com
   # 交互输入口令；此口令即 RELAYIUM_SMTP_PASS
   ```
2. **DKIM/SPF/DMARC**（已完成 ✅）：DNS 已配好。可复核：
   ```bash
   docker exec -ti <dms容器名> setup config dkim   # 若需重生成
   dig TXT mail._domainkey.relayium.com +short
   ```
3. **587 端口可达**（已完成 ✅，`swaks` 已通过）：
   ```bash
   swaks --to <你的邮箱> --from noreply@relayium.com \
     --server mail.relayium.com:587 --tls \
     --auth-user noreply@relayium.com --auth-password '<口令>'
   ```
4. **写 `.env` + 重启**（已完成 ✅）：追加第 8 节变量后重启 relayium 服务（部署步骤见运维文档）。
5. **端到端复核**（部署后做）：网站真实注册一个邮箱 → 确认收到验证邮件、非垃圾箱 → 点链接→自动登录。忘记密码同样走一遍。

## 10. 安全

- Token：32 字节 `crypto/rand`，**只存 SHA-256 哈希**，一次性原子消费，带 TTL（verify 24h / reset 1h）。
- **防账号枚举**：`resend` / `forgot` 无论邮箱是否存在都返回 200；登录仍统一 `ErrBadCredentials`。
- **防邮件轰炸**：`resend` / `forgot` per `email+IP` 限流。
- **重置吊销全部 session**（`RevokeUserSessions(uid, "")`）：防旧 session 在改密后仍有效。
- 重置成功顺带标记 `email_verified=1`（收到重置邮件即证明拥有邮箱）。
- 未验证账号无法登录、无法拿 session，天然挡住「用别人邮箱注册占坑 + 直接用」。

## 11. 测试

Go 单测（用 `LogMailer` 抓链接，`SQLiteStore` 用 `:memory:`）：

- `email_tokens` 建/原子消费/purpose 不匹配拒绝/过期拒绝/二次消费拒绝。
- 老用户兜底迁移：预置用户 → 加列 → 断言 `email_verified=1`；新建用户 → 断言 0。
- 注册：不发 session、发了验证邮件。
- 未验证登录：403 `ErrEmailUnverified`、无 session。
- verify：消费 token→拿到 session→`EmailVerified=true`。
- forgot→reset→login 全链路；reset 吊销其它 session。
- 防枚举：未知邮箱 `forgot`/`resend` 仍 200 且不建 token。

可选：headless 浏览器 E2E（现有 CDP 手法）跑一遍真实注册→验证。

## 12. 上线顺序

1. 后端（DB 迁移 + Store + Mailer + Service + Handler）+ 单测。
2. 前端（auth 客户端 + Account UI + 两个新页 + i18n）。
3. 合并 main → `auto-deploy.sh` 自动构建部署（DB 迁移在服务启动时幂等执行，老用户自动兜底）。
4. 部署后按 §9.5 端到端复核。

## 13. 明确不做（YAGNI）

- 改邮箱地址流程（change-email）——本次不做。
- 邮件模板 i18n 的完整多语言矩阵——先中英双语文案，够用即可。
- 验证码（数字 OTP）替代链接——本次用链接。
- 独立 magic-link 开关的改动——保持现状，仅解耦 SMTP 启用条件。
