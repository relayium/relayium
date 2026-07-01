# 管理员双因素认证(2FA / TOTP)

本文档面向**自托管部署者**,说明如何为 `/admin` 后台的管理员登录开启基于时间的一次性验证码(TOTP)双因素认证——即 Google Authenticator、1Password、Authy 等 App 里那种每 30 秒刷新一次的 6 位数字。

## 概述:启用模型

- 2FA 由一个环境变量控制:`RELAYIUM_ADMIN_TOTP_SECRET`(对应 CLI flag `-admin-totp-secret`),值是一个 base32 编码的 TOTP 密钥。
- **留空 = 关闭**:不设置这个变量时,管理员登录和现在完全一样,只需账号 + 密码。
- **2FA 是密码之上的第二层,不是替代**:开启后,登录 `/admin` 需要同时填对账号、密码、以及当前的 6 位验证码,三者缺一不可。
- 密钥只存在于部署的环境变量 / `.env` 文件里,**不会写入数据库**。

### 前提:必须先启用管理后台

`/admin` 后台本身只有在设置了 `RELAYIUM_ADMIN_PASS`(管理员密码)时才会挂载路由;密码为空时整个 `/admin` 是禁用的(404,回退到 SPA 首页)。

如果你设置了 `RELAYIUM_ADMIN_TOTP_SECRET` 但 `RELAYIUM_ADMIN_PASS` 是空的,服务端会在启动日志打印一条警告并**忽略这个密钥**——`/admin` 依旧保持禁用状态,2FA 不会单独生效。也就是说,2FA 永远建立在密码认证之上。

## 启用步骤

### 1. 生成一个新密钥

在 `server/` 目录下,用源码运行:

```bash
cd server
go run . -gen-admin-totp
```

如果你用的是已编译好的二进制:

```bash
./relayium -gen-admin-totp
```

这条命令会:

- 生成一枚全新的 TOTP 密钥;
- 在终端打印一个**可直接扫描的二维码**(ASCII/半块字符渲染,终端里就能扫);
- 同时打印 base32 格式的密钥原文,以及完整的 `otpauth://` URL(供无法扫码时手动导入);
- 然后**直接退出,不会启动服务**。

二维码里的账号名是当前生效的管理员用户名(即 `RELAYIUM_ADMIN_USER`,默认 `admin`),签发方(Issuer)固定为 `Relayium`。输出大致如下(具体密钥每次运行都不同):

```
扫描下面的二维码,或手动输入密钥到你的验证器 App:

█▀▀▀▀▀█ ▀▄█▀▄ █▀▀▀▀▀█
█ ███ █ ▄▀ ▀█ █ ███ █
█ ▀▀▀ █ █▀▄▀▄ █ ▀▀▀ █
▀▀▀▀▀▀▀ █▄▀▄█ ▀▀▀▀▀▀▀
...

Secret (base32): JBSWY3DPEHPK3PXP
otpauth URL:     otpauth://totp/Relayium:admin?secret=JBSWY3DPEHPK3PXP&issuer=Relayium

把 Secret 填入 RELAYIUM_ADMIN_TOTP_SECRET 后重启服务即可启用 2FA。
```

### 2. 用验证器 App 扫码

用手机上的 Google Authenticator、1Password、Authy(或任何标准 TOTP 客户端)扫描终端里的二维码;如果终端字体渲染不清晰导致扫不出来,直接在 App 里手动输入打印出来的 base32 密钥字符串。

### 3. 把密钥写入配置并重启

把上一步的 base32 密钥(如 `JBSWY3DPEHPK3PXP`)填进 `RELAYIUM_ADMIN_TOTP_SECRET`,例如在 `.env` 里:

```bash
RELAYIUM_ADMIN_USER=admin
RELAYIUM_ADMIN_PASS=你的管理员密码
RELAYIUM_ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXP
```

或者作为环境变量 / systemd unit 里的 flag:

```bash
relayium -admin-pass '你的管理员密码' -admin-totp-secret 'JBSWY3DPEHPK3PXP'
```

保存后重启服务(如 `systemctl restart relayium`,或重新执行你的启动命令)。

### 4. 登录时输入验证码

重启完成后打开 `/admin`,登录表单会多出一个"6 位验证码"输入框。在同一个页面里一次性填好:管理员账号、管理员密码、以及验证器 App 当前显示的 6 位数字,一起提交。

- 三者只要有一项错(账号、密码或验证码),都会返回同一句**通用错误提示**"账号、密码或验证码错误"(HTTP 401)——不会告诉你具体是哪一项错,避免给攻击者可探测的信息。
- 全部正确才会登录成功,签发管理员会话(与之前一样,cookie 有效期 12 小时)。

## TOTP 参数

- 算法:SHA1
- 位数:6 位
- 时间步长(period):30 秒
- 时钟漂移容差:±1 个时间步(即当前、前一个、后一个时间步的码都算有效,总窗口约 90 秒),用于容忍手机与服务器之间小幅的时钟误差。

这些参数是主流 TOTP 实现的标准默认值,与 Google Authenticator、1Password、Authy 等 App 完全兼容,不需要在 App 里做任何特殊配置。

同一个验证码在同一个时间步内只能用一次(服务端会记录已接受过的最近时间步并拒绝重放),所以不要尝试把截获的验证码在有效期内重复提交。

## 登录失败限流

为了防止 2FA 上线后 `/admin/login` 端点被暴力破解,登录接口按客户端来源 IP 做了限流:

- 同一 IP **连续 5 次登录失败**后,会被**锁定 15 分钟**,期间该 IP 的所有登录请求直接返回 HTTP 429,不再做任何凭据比对。
- 登录成功会清零该 IP 的失败计数。
- 这两个数字(5 次 / 15 分钟)是写死的常量,当前不支持配置。

> 限流依赖正确识别客户端 IP:如果部署在反向代理之后,代理必须**覆盖(overwrite)而不是追加(append)** `X-Forwarded-For` 请求头。如果代理只是把自己的地址追加到已有的 `X-Forwarded-For` 后面,攻击者可以在请求里伪造头部第一段来假冒任意 IP,从而绕过按 IP 的限流。请检查 nginx/Caddy 等反代配置,确保它们清空或覆盖客户端传入的 `X-Forwarded-For`,只保留反代自己观察到的真实来源 IP。

## 启动期安全校验

服务器每次启动时都会校验 `RELAYIUM_ADMIN_TOTP_SECRET`:如果这个变量非空但**不是合法的 base32 字符串**(比如手滑打错了),服务会**直接拒绝启动**(fatal 错误),而不是静默地把 2FA 关掉或忽略这个错误配置。这个校验独立于数据库是否可用,每次启动都会执行——目的是避免"密钥打错导致 2FA 悄悄失效,管理员却毫不知情"的情况。

如果启动失败并提示密钥不是合法 base32,检查是否复制粘贴时漏字符、混入了空格或换行。

## 丢失设备 / 更换手机 / 恢复

密钥本身就活在你的部署环境变量 / `.env` 文件里,这就是它的"恢复机制"——本功能**不提供恢复码**,因为拥有 env/部署配置的访问权限本身就是恢复路径。

- **换了新手机,想恢复原来的验证器**:直接把 `.env` 或部署配置里现有的 `RELAYIUM_ADMIN_TOTP_SECRET` 值,在新手机的验证器 App 里手动输入(或者如果你还留着原来生成时打印的二维码/`otpauth://` URL,直接扫码也行),不需要改任何服务端配置,也不用重启。
- **弄丢了旧密钥、想换一把新的**:重新运行一次 `go run . -gen-admin-totp`(或 `./relayium -gen-admin-totp`),生成一枚全新密钥,重复上面的"启用步骤"扫码 → 更新 `RELAYIUM_ADMIN_TOTP_SECRET` → 重启服务。旧密钥会随之失效。
- **验证器彻底用不了了,又暂时进不去 `/admin`**:直接在部署环境里把 `RELAYIUM_ADMIN_TOTP_SECRET` 注释掉(或删除该变量)并重启服务,即可临时回退到"仅账号+密码"登录,不受影响地进入后台;之后想重新开启 2FA 再按上面的步骤走一遍即可。

## 安全提示

- `RELAYIUM_ADMIN_TOTP_SECRET` 等同于**第二个密码级别的凭据**,请像对待管理员密码一样对待它:不要提交进版本库,不要明文贴在聊天记录 / issue 里,只保存在 `.env`(git-ignored)、部署平台的密钥管理或 systemd unit 的环境配置里。
- 打印出的二维码 / `otpauth://` URL 同样包含完整密钥,截图或终端记录也应妥善处理,避免泄露。
- 如前所述,反向代理必须正确覆盖 `X-Forwarded-For`,否则登录限流可以被伪造 IP 绕过,失去防暴力破解的意义。
