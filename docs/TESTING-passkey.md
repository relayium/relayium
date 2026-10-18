# Admin Passkey — 端到端验证指南

后台登录是 **Passkey-only**（无密码、无 TOTP），新 passkey 只能由服务器上的
`relayium-server admin` 命令发起一次性注册链接、在浏览器里创建为「待批准」，再回到
终端按指纹批准。运行手册见 [admin-passkeys.md](admin-passkeys.md)。

Go 测试已覆盖安全关键面，并用一枚软件 authenticator（`server/account/passkey_authenticator_test.go`）
跑真实的 ES256 仪式密码学：

| 面 | 测试文件 |
|---|---|
| 会话：绑定凭据、30 分钟空闲 / 12 小时上限、旧会话失效、只读查询不续期 | `server/account/admin_session_test.go` |
| 注册：一次性 grant、待批准不可登录、指纹/绑定/过期/重放/跨种类/外源/无 UV、并发批准恰好一次、grant 不入日志 | `server/account/admin_enroll_test.go` |
| 撤销竞态：已验签登录在 revoke-all / 撤销凭据后不能发会话、无孤儿会话复活、step-up 证明跨撤销失效、宽限期随撤销失效 | `server/account/admin_revocation_race_test.go` |
| 浏览器不能增删凭据、旧密码登录 410、旧 pending 删除动作失败关闭 | `server/account/passkey_register_test.go` |
| 高危步进只认 passkey、零凭据无回退 | `server/account/stepup_factor_test.go` |
| 本地命令：链接只打印一次且只给终端、拒绝不存在的库、撤销/全部撤销 | `server/admincmd/admincmd_test.go` |
| `admin` 子命令先于服务器配置分发、`-h` 不泄露旧密钥、开关解析 | `server/admin_command_test.go` |

**没有被 Go 测试覆盖的是模板里的内联 JS**：`navigator.credentials.create()/get()`、
base64url 编解码、注册页读取并抹掉 URL 片段（`#grant`）、零凭据/不支持 WebAuthn 时的提示。
下面的流程补这一段。

标记：`[AUTOMATED]` 可用 headless Chrome + CDP 虚拟 authenticator 跑；`[MANUAL]`
需要真机 / 真生物识别 / 人工判断。

---

## 0. 前提

1. **CDP 的 `WebAuthn` 域可以注入虚拟 authenticator**（`hasUserVerification: true`,
   `isUserVerified: true`, `hasResidentKey: true`），headless 下无需硬件即可完成真实仪式。
2. **`localhost` 是 WebAuthn 安全上下文的豁免项**，纯 HTTP 即可；RP ID 由 BaseURL 的 host
   去掉端口得出，即 `localhost`。

只用临时数据库和合成密钥，绝不连生产、不碰真实账户或真实 passkey。

## 1. 起服务 `[AUTOMATED]`

```bash
cd server && go build -o /tmp/relayium-passkey .
DIR=$(mktemp -d)
RELAYIUM_ENV_FILE=$DIR/none.env RELAYIUM_ADMIN_ENABLED=true \
  /tmp/relayium-passkey -addr 127.0.0.1:18080 -db $DIR/relayium.db \
  -blob-dir $DIR/blobs -base-url http://localhost:18080 &
```

`GET /admin` 应只显示「后台只能用 passkey 登录，目前还没有注册任何 passkey」与
`relayium-server admin enroll start` 提示；页面上**不得**出现任何密码、账号或验证码输入框。

## 2. 注册第一枚 passkey `[AUTOMATED]`

```bash
/tmp/relayium-passkey admin --db $DIR/relayium.db --base-url http://localhost:18080 \
  enroll start --name "virtual-1"
```

（在自动化里 stdout 不是终端，需要加 `--allow-non-terminal`；生产上不要加。）

1. 在挂了虚拟 authenticator 的标签页打开打印出的 `http://localhost:18080/admin/enroll#<grant>`。
2. 断言：响应头 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；脚本运行后
   `location.hash === ''`（grant 已从地址栏抹掉）。
3. 点「在这台设备上创建 passkey」，页面应显示指纹与 `enroll approve` 命令。
4. **批准前**：用这枚 passkey 尝试登录必须失败；`enroll approve <ID> --fingerprint 0000-...`
   必须失败；终端 `enroll status <ID>` 显示同一指纹。
5. `enroll approve <ID> --fingerprint <页面指纹>` 成功；再次批准必须失败。
6. 重新打开同一链接点创建，必须失败（grant 一次性）。

## 3. 登录与高危步进 `[AUTOMATED]`

1. `GET /admin` 出现「使用 passkey 登录」，点击后进入后台。
2. 概览页「Passkey 登录」表只读：有 ID、指纹、最后使用时间，**没有**删除按钮或添加表单。
3. 发起一项高危操作（例如铸造节点 token）：确认页出现「用 passkey 确认执行」，完成断言后操作生效；
   60 秒内第二项高危操作显示宽限期提示，确认页仍然展示 diff。
4. 带着已登录 cookie 直接 `POST /admin/passkey/register/begin`、`/register/finish`、
   `/admin/passkey/delete`、`/admin/login`：全部 `410`，凭据表不变。

## 4. 撤销与过期 `[AUTOMATED]`

1. `sessions revoke-all` 后旧 cookie 立即失效（访问后台回到登录页）；用 passkey 重新登录成功。
2. 注册第二枚 passkey 并用它步进后，`credentials revoke <第二枚 ID>`：第一枚登录的会话仍在，
   但下一项高危操作需要重新用 passkey 确认（宽限期已失效）。
3. `credentials revoke <最后一枚 ID> --allow-last` 后旧 cookie 与步进均被拒；登录页回到零凭据提示。
4. 空闲：把服务器时钟或会话 `last_seen_at` 推到 31 分钟前（仅限临时库），再访问必须回到登录页。

## 5. 人工项 `[MANUAL]`

- 真机平台 authenticator（Touch ID / Windows Hello / 手机）完成注册、登录、步进，提示文案正确。
- 硬件安全密钥（USB/NFC）作为备份密钥注册并登录。
- 已同步 passkey（iCloud 钥匙串等）在第二台同账户设备上再注册：页面应提示「这台设备上已经有一枚后台 passkey」。
- 不支持 WebAuthn 的浏览器：登录页与注册页给出不支持提示而不是可点的死按钮。
- 中英文两套文案（`Accept-Language: en` 或语言切换）检查一遍登录、确认、注册页。

## 6. 收尾

关掉服务和浏览器，删除临时目录 `$DIR`。
