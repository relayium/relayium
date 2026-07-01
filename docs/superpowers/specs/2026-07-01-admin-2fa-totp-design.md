# 管理员 2FA(TOTP)设计

**日期**: 2026-07-01
**范围**: 只做管理员登录的 TOTP 双因素认证。后台功能优化是另一份独立 spec,不在本文档范围内。

## 目标

- 给 `/admin` 的管理员登录增加一层 TOTP(基于时间的一次性验证码)双因素认证。
- 默认关闭、向后兼容:不配置密钥时,现有"账号+密码"流程完全不变。
- 与项目现有"管理员活在环境变量、数据库无对应账号行"的架构保持一致——不引入管理员 DB 表。

## 非目标

- 不给**普通用户**加 2FA(普通用户认证在 `password.go`/`handlers.go`,是 DB-backed session,与本次无关)。
- 不做恢复码机制(env 密钥方案天然自带恢复,见下)。
- 不重做管理员后台 UI/功能(单独 spec)。

## 现状(实现前)

- 管理员凭据来自环境变量/flag:`RELAYIUM_ADMIN_USER`(默认 `admin`)、`RELAYIUM_ADMIN_PASS`(空则整个 `/admin` 禁用)。见 `server/main.go:63-64`、`server/internal/account/service.go` 的 `Config`。
- 密码是**明文常量时间比对**(非 bcrypt),在 `server/internal/account/admin.go:69-88` 的 `handleAdminLogin`。
- 管理员登录态是**内存 map** `s.adminSessions`(token→过期秒)+ cookie `relayium_admin`(Path=/admin,httpOnly,SameSite=Lax,TTL 12h)。进程重启即失效。
- 后台是 Go `html/template` 服务端渲染的两个内联模板(`admin.go:181-231`):登录页 + 主页。
- 全项目无任何 TOTP/2FA 代码或依赖;`go.mod` 无 OTP 库。
- `/admin/login` **当前没有任何失败限流**。

## 设计

### 1. 启用模型(向后兼容)

- 新增配置项 `RELAYIUM_ADMIN_TOTP_SECRET`(base32 编码的 TOTP 密钥),对应 CLI flag `-admin-totp-secret`,在 `main.go` 与其他 admin 配置并列读取,写入 `Config`(新增字段 `AdminTOTPSecret string`)。
- **启用判定**:密钥非空 → 登录强制要求验证码;密钥为空 → 维持现状(仅账号+密码)。
- **启动期校验**(在 `main.go` 组装 `Service` 后、开始监听前):
  - 若 `AdminTOTPSecret` 非空但**不是合法 base32 / 无法被 otp 库解析** → `log.Fatal`,给出明确报错(避免把管理员锁在外面还查不出原因)。
  - 若 `AdminTOTPSecret` 非空但 `AdminPassword` 为空(后台本就未启用)→ `log.Printf` 警告并忽略该密钥。
- 在 `Service` 上加一个 `AdminTOTPEnabled() bool`(等价于 `AdminEnabled() && cfg.AdminTOTPSecret != ""`),供 handler 和模板判断。

### 2. TOTP 参数与库

- 引入依赖 `github.com/pquerna/otp`(及其 `totp` 子包),生成与校验都用它。
- 参数用主流默认,保证与 Google Authenticator / 1Password / Authy 等兼容:
  - 算法 **SHA1**、**6 位**、周期 **30 秒**。
- 校验时允许 **±1 个时间步**的时钟漂移(有效窗口共 90 秒):用 `totp.ValidateCustom` 传 `Skew=1`。
- **防重放**:在 `Service` 内存里记录"最近一次被接受的验证码所属时间步"(`adminTOTPLastStep int64`,配合已有的 `adminMu` 或单独的 mutex)。若本次通过校验的码落在**已被使用过的时间步**,判为重放并拒绝。挡住"30 秒内偷看验证码后立即重放"。单管理员,成本可忽略。

### 3. 开通方式:CLI 生成器

- 新增 flag `-gen-admin-totp`(bool)。`main.go` 在 `flag.Parse()` 后**第一时间**检查:若为真,则:
  1. 生成一枚新 TOTP 密钥(`totp.Generate`,Issuer=`Relayium`,AccountName 取管理员用户名或固定 `admin`)。
  2. 向 stdout 打印:base32 密钥、完整 `otpauth://` URL、以及 **ASCII 二维码**(用密钥的 URL 生成;可用轻量库如 `github.com/skip2/go-qrcode` 输出到终端,或手写 QR ASCII——实现时择一,优先无新增重依赖)。
  3. `return`/`os.Exit(0)`,**不启动服务器**。
- 操作流程:运行生成器 → 手机扫码或手输密钥 → 把 base32 填进 env 的 `RELAYIUM_ADMIN_TOTP_SECRET` → 重启服务 → 之后登录需验证码。
- **恢复 / 丢手机**:密钥始终在部署者的 env 里,重新扫码即可恢复;临时进不去就先注释掉该变量重启回到仅密码。**因此不需要恢复码。**

> 实现注:ASCII 二维码库的选择在实现阶段确定。若 `go-qrcode` 引入的传递依赖过重,退化为只打印密钥 + otpauth URL(用户可手动生成二维码),不阻塞主功能。

### 4. 登录 handler 改动(单页一次填)

- `adminLoginTmpl`:当 `AdminTOTPEnabled()` 为真时,多渲染一个"6 位验证码"输入框(`name="totp"`,`inputmode="numeric"`,`autocomplete="one-time-code"`);未启用则不渲染。模板需要能拿到"是否启用 2FA"的标志——给登录模板的数据从 `map[string]string` 扩为一个结构体 `{ Error string; TOTP bool }`,`renderAdminLogin` 相应调整。
- `handleAdminLogin`(`admin.go:69-88`)在原有账号/密码常量时间比对之后、签发 session 之前:
  - 若 `AdminTOTPEnabled()`,读取 `r.FormValue("totp")`,用第 2 节的校验(含 skew 与防重放)验证。
  - **任一因素失败(账号错、密码错、或验证码错)都返回同一句** `账号、密码或验证码错误`(HTTP 401),不泄露是哪个因素错。
  - 全部通过后才 `newAdminSession()` 并下发 cookie(逻辑不变)。

### 5. 失败限流(本次新增,已确认要加)

- 在 `/admin/login` 加一个**最简内存限流**,防止加了 2FA 后登录端点被爆破:
  - 按客户端来源 key(取 `RemoteAddr` 的 IP 部分;如部署在反代后,读取 `X-Forwarded-For` 首段——与项目现有取 IP 的方式保持一致,实现时对齐)。
  - 维护"失败次数 + 窗口起点"的内存表(带 mutex)。**连续失败达到阈值 N(默认 5)后,锁定 W(默认 15 分钟)**,锁定期内直接返回 429 并提示稍后再试,不做凭据比对。
  - 成功登录清零该来源计数。
  - 内存实现即可(与 admin session 一样进程级);无需持久化。阈值/窗口用常量,不做成可配置(YAGNI)。

### 6. 测试

在 `server/internal/account/` 下新增/扩展测试(表驱动):

- 密钥未配置:登录流程与验证码字段行为与现状一致(回归)。
- 密钥已配置:
  - 正确的当前验证码 → 通过。
  - 错误验证码 → 401,同一句通用错误。
  - 上一个/下一个时间步的码(±1)→ 通过(skew)。
  - ±2 步的码 → 拒绝。
  - 同一码在同一时间步重放 → 第二次拒绝(防重放)。
  - 账号或密码错但验证码对 → 401 通用错误。
- 启动校验:非法 base32 密钥 → 触发 fatal 路径(将校验逻辑抽成可单测的纯函数,如 `validateAdminTOTPSecret(secret) error`,单测它而非真的 `log.Fatal`)。
- 限流:同来源连续失败达阈值后返回 429;成功后计数清零;不同来源互不影响;窗口过期后恢复。
- 生成器:`totp.Generate` 产出的密钥,其当前码能被登录校验逻辑接受(生成与校验闭环)。

### 7. 文档(交付物)

- 更新 `server/.env.example`:加带注释的 `RELAYIUM_ADMIN_TOTP_SECRET`(说明留空=关闭、如何生成)。
- 在 `README` 和/或 `SECURITY.md` 补一段管理员 2FA 说明。
- **实现完成后,单独产出一份面向部署者的操作文档**:「如何为管理员账号生成并启用 2FA」——覆盖运行 `-gen-admin-totp`、扫码、填 env、重启、登录、丢手机如何恢复、如何临时关闭。位置建议 `docs/admin-2fa.md`(实现时确认)。

## 涉及文件(预估)

- `server/main.go` — 新增 flag `-admin-totp-secret`、`-gen-admin-totp`;生成器分支;启动期密钥校验;把密钥传入 `Config`。
- `server/internal/account/service.go` — `Config` 加 `AdminTOTPSecret`;`Service` 加防重放/限流所需字段与 `AdminTOTPEnabled()`。
- `server/internal/account/admin.go` — 登录模板加验证码字段;`handleAdminLogin` 加 TOTP 校验 + 限流;`renderAdminLogin` 数据结构调整。
- 新增 `server/internal/account/totp.go`(或就近放 admin.go)— TOTP 校验封装、密钥校验纯函数、防重放。
- `server/go.mod` / `go.sum` — 新增 `github.com/pquerna/otp`(及可能的 QR 库)。
- 测试文件:`server/internal/account/admin_test.go` 或新增 `totp_test.go`。
- `server/.env.example`、`README.md`/`SECURITY.md`、`docs/admin-2fa.md`(操作文档)。

## 关键决策记录

- **密钥存 env 静态密钥**,不入 DB、不做自助开通页——与现有管理员架构一致,复杂度最低。(已确认)
- **单页一次填**验证码,不引入两步式中间态 cookie。(已确认)
- **加失败限流**。(已确认)
- 默认参数 SHA1/6/30、±1 步容差、内存防重放、无恢复码。(已确认)
