# 管理员后台 Passkey (WebAuthn) 登录

日期：2026-07-19
状态：设计已确认，待实现

## 背景与目标

管理员后台目前要求账号 + 密码 + TOTP 三段输入，日常进后台的摩擦明显。目标是让**日常登录**降为一次生物识别（Touch ID / Face ID / 安全密钥），同时不降低安全水位。

现状（实现时需要知道的既有事实）：

- 管理员凭据是纯配置项 `RELAYIUM_ADMIN_USER` / `RELAYIUM_ADMIN_PASS` / `RELAYIUM_ADMIN_TOTP_SECRET`，**没有 admin 表**，明文常量时间比对（`server/internal/account/admin.go:228-264`）
- 会话是进程内 map `adminSessions`（`service.go:146`），TTL 12h，重启即失效
- 后台是 Go `html/template` 服务端渲染，**零 JS**（`admin_templates.go`）
- 全项目无 WebAuthn 痕迹；`go.mod` 无相关依赖
- 产线 `-base-url https://relayium.com`（`deploy/relayium.service:23`），secure context 满足

## 已确认的产品决策

1. **passkey 完全替代密码+TOTP 作为日常登录方式**；密码+TOTP 保留为后备通道（新设备、passkey 丢失）。不做「只认 passkey」的无后备模式。
2. **不顺带持久化 admin 会话**。重启掉线的痛点被「一键刷脸重登」消解，会话落库是独立议题，需要时单独做。
3. **注册新 passkey 要求 step-up**：重新输入密码 + TOTP 才能注册。
4. 可注册**多枚** passkey；**免用户名一键登录**（discoverable credential）；后台提供列表 + 命名 + 删除。

决策 3 的理由：凭据表可写 == 可植入长期后门。若仅凭已登录会话即可注册，则任何一次会话 cookie 泄露（公共电脑未登出、XSS、cookie 窃取）都可升级为永久访问权，且在列表里只表现为一行「未知设备」。注册是低频操作（一年数次），在其上收紧几乎无体感成本，却封掉了本功能引入的最大新增攻击面。

## 1. 身份与存储

**依赖**：`github.com/go-webauthn/webauthn`。Go 生态事实标准，纯 Go 无 cgo（与 `modernc.org/sqlite` 的无 cgo 路线一致）。不自行实现：WebAuthn 验证涉及 CBOR 解码、COSE 公钥解析、attestation 校验。

**新表** `admin_credentials`，追加进 `sqlite.go` 的 `schema` 常量，沿用既有 `CREATE TABLE IF NOT EXISTS` 惯例（本项目无正式 migration 机制）：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | credential ID，base64url |
| `public_key` | BLOB | COSE 公钥 |
| `sign_count` | INTEGER | 克隆检测计数器 |
| `name` | TEXT | 用户命名，如「MacBook」 |
| `created_at` | INTEGER | unix 秒 |
| `last_used_at` | INTEGER | unix 秒，0 表示从未使用 |

**user handle 必须与用户名解耦**。WebAuthn 要求稳定的 user ID；`RELAYIUM_ADMIN_USER` 是可变配置项，若直接用作 handle，改用户名会静默作废全部已注册 passkey 且极难排查。做法：首次注册时生成 32 字节随机 handle 存入既有 `settings` 表（key `admin_webauthn_user_handle`），此后永不变更。用户名仅作 `DisplayName` 展示。

**RP ID** 从 `Config.BaseURL` 的 host 推导并去掉端口（`localhost:8080` → `localhost`；RP ID 不允许含端口）。origin 校验使用完整 BaseURL。

**启用条件**跟随既有 `AdminEnabled()`，不新增开关。

**sign_count 策略**：仅当上报值非 0 且**小于**已存值时判定为克隆并拒绝。iCloud 钥匙串等同步型 passkey 恒报 0，严格要求递增会把管理员锁在门外。

## 2. 端点与流程

### 登录（免用户名）

```
POST /admin/passkey/login/begin   → PublicKeyCredentialRequestOptions
   ↓ navigator.credentials.get()
POST /admin/passkey/login/finish  → 验签 → newAdminSession() → 种 relayium_admin cookie
   ↓ JS 跳转 /admin
```

成功后复用既有 `newAdminSession()` 与 `relayium_admin` cookie，会话机制完全不动——passkey 只是新增一种身份证明方式。

challenge（go-webauthn 的 `SessionData`）存进程内 map，TTL 5 分钟，与 `adminSessions` 同一套做法。

### 注册（step-up）

「添加 passkey」先渲染密码 + TOTP 表单；验证通过后才发 creation options；浏览器 `create()` 后连同用户所起名字提交入库。TOTP 复用 `matchAdminTOTPStep` / `commitAdminTOTPStep`（含防重放），不重复实现。

### 删除

`POST /admin/passkey/delete`，已登录 + CSRF 即可，**不要求 step-up**：其危害是自我锁定（可回退密码通道）而非提权。允许删至零枚。

### Throttle：必须使用独立计数桶

现有 `loginThrottle` 为 5 次失败锁 IP 15 分钟（`throttle.go:11-14`）。passkey 登录失败**不得**计入密码桶，否则攻击者可通过反复触发 passkey 失败连带锁死密码后备通道——而后备通道正是 passkey 故障时的唯一退路，两者共用一把锁等同于没有后备。

- passkey 登录失败 → 独立桶
- step-up 失败 → 共用密码桶（它验证的确实是密码+TOTP）

### CSRF

新增 POST 端点挂既有 `csrfGuard`。但 `csrfGuard` 当前对**缺失 Origin 头的请求豁免**（`handlers.go:54-84`）——这对表单提交是必要兼容妥协，对 fetch 发起的 JSON 端点则是漏洞（fetch 必带 Origin，豁免只便利攻击者）。本组端点要求 Origin 必须存在且匹配。

### CSP

`server/spa.go:16-27` 的 CSP 含 `script-src 'self' 'unsafe-inline'`，内联脚本可行。实现时确认 `/admin` 路由是否经过该头部中间件（`/admin` 是 Go handler，未必经过 `spa.go`）。

## 3. 前端与错误处理

后台首次引入 JS，原则是**渐进增强，绝不破坏既有路径**。

**登录页**：密码表单保持原样，上方增加「使用 passkey 登录」按钮与内联 `<script>`（原生 `navigator.credentials`，不引第三方 JS 库；仅需约 15 行 base64url 编解码辅助）。若 `window.PublicKeyCredential` 不存在、JS 被禁或脚本抛错，按钮不渲染，页面退化为当前完全一致的密码+TOTP 表单。**任何 passkey 路径失败都不得使密码表单不可用**。

**点击触发，不做加载时自动弹窗**：自动弹生物识别弹窗打扰用户，且部分浏览器要求用户手势。Conditional UI（输入框 autofill 式提示）体验更佳但需额外代码路径，本期不做。

**错误分三类**：

- 用户取消（`NotAllowedError`）→ 静默返回，不显示报错。取消是正常操作。
- 本设备无可用凭据 → 提示「这台设备还没注册 passkey，请用密码登录后在设置里添加」，给出出路而非 "authentication failed"。
- 服务端 / 网络错误 → 显示具体信息便于排查。

**设置页**新增 passkey 区块：列出各凭据的名字、创建时间、最后使用时间，各带删除按钮，另有「添加 passkey」入口。`last_used_at` 是发现「有一枚凭据从未使用过」的唯一线索，即上述后门攻击路径的事后检测手段。

## 4. 测试

**核心投资：最小软件 authenticator 测试辅助**（约 120 行，ES256 + `none` attestation，手工构造 `clientDataJSON` / `authenticatorData` 并签名）。`finish` 端点是全功能中唯一执行密码学验证、唯一决定谁能进入后台的代码；没有该辅助，它只能靠手点浏览器验证，等同于无回归保护。有了它，注册与登录的完整往返可在 `go test` 内跑通。

安全边界各自成测（均不需要真实签名）：

- **step-up 强制**：不带密码+TOTP 直接请求 `register/begin` 必须被拒
- **throttle 隔离**：刷爆 passkey 失败后，密码登录仍必须可用
- **CSRF**：无 Origin 头的 JSON 请求必须被拒
- **user handle 稳定性**：变更 `RELAYIUM_ADMIN_USER` 后已注册凭据仍有效
- **sign_count**：恒 0 放行，回退拒绝
- **克隆凭据 / 错误 challenge / 过期 challenge** 分别拒绝

测试惯例遵循现状：`_test.go` 同包内部测试，真实内存 SQLite（`newTestStore`），`httptest.Server`，纯 `testing` 无 testify，helper 参照 `admin_test.go:14-27` 的 `newAdminServer`。

**浏览器端**：CDP 的 `WebAuthn.addVirtualAuthenticator` 可在 headless 中注册并使用虚拟 passkey，手法同 `docs/TESTING.md` 的 CDP 双标签 WebRTC 验证。建议实施，但列为独立的最后一步——若其比预期棘手，前述 Go 测试已覆盖安全关键面，不应被阻塞。

**手工验证清单**（机器无法覆盖）：

- 真机 Touch ID 与 Face ID 各走一遍
- 手机跨设备扫码登录
- 禁用 JS 后密码表单仍可用

## 非目标

- 不做 admin 会话持久化
- 不做 Conditional UI / autofill 式 passkey 提示
- 不做多管理员账户或 admin 表重构
- 不做用户侧（非管理员）passkey——用户侧 passkey PRF 见 `2026-06-30-cross-device-my-files-DEFERRED.md`，与本设计无耦合
