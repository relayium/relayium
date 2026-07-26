# Admin Passkey 登录 — 端到端验证记录

本文记录后台 passkey（WebAuthn）登录的浏览器端验证。

Go 测试已经覆盖了全部安全关键面（凭据存储、RP 校验、challenge 生命周期、
step-up 鉴权、签名验证——`server/account/passkey_*_test.go` 里有一枚
软件 authenticator 跑真实的仪式密码学）。**没有被 Go 测试覆盖的是模板里那段内联
JS**：`navigator.credentials.create()/get()` 的调用、base64url 编解码、以及
"零凭据时不渲染按钮"这类渐进增强分支。本文补的就是这一段。

**执行状态标记：**
- `[AUTOMATED]` — 本轮真实跑过，输出已抓取。
- `[MANUAL]` — 需要真机 / 真生物识别 / 人工关 JS，机器覆盖不了，留给人跑。

验证环境（2026-07-19 实测）：

```
Google Chrome 150.0.7871.125  (--headless=new)
Node.js v25.9.0               (原生全局 WebSocket，驱动 CDP 不需要任何依赖)
go1.26.3 darwin/arm64
```

---

## 0. 为什么 CDP 虚拟 authenticator 能跑通

两个前提，缺一不可：

1. **CDP 的 `WebAuthn` 域可以注入虚拟 authenticator**，headless 里无需任何硬件即可
   完成真实的 WebAuthn 仪式——密钥是真的、签名是真的、服务端按正常路径验签。
2. **`localhost` 是 WebAuthn 安全上下文的豁免项**，所以纯 HTTP 就够了，不必为验证
   去搞自签证书。RP ID 由 BaseURL 的 host 去掉端口推导得出，此处即 `localhost`
   （已由 `WebAuthn.getCredentials` 返回的 `rpId=localhost` 证实）。

---

## 1. 起服务 `[AUTOMATED]`

```bash
cd server && go build -o /tmp/relayium-passkey ./

RELAYIUM_ADMIN_PASS=testpw /tmp/relayium-passkey \
  -addr 127.0.0.1:8099 \
  -base-url http://localhost:8099 \
  -db /tmp/passkey-test.db \
  -blob-dir /tmp/passkey-blobs
```

预期日志：`relayium signaling server listening on 127.0.0.1:8099`

> 不要开 TOTP（不设 `-admin-totp-secret`）——验证 passkey 通道时它只是噪音。
> step-up 表单里的 `totp` 字段留空即可。

## 2. 起带远程调试端口的 Chrome `[AUTOMATED]`

```bash
rm -rf /tmp/passkey-chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/passkey-chrome \
  --no-first-run --no-default-browser-check \
  about:blank

# 取浏览器级 WebSocket 端点
curl -s http://127.0.0.1:9222/json/version
```

沿用 `docs/TESTING.md` 的 CDP 手法：起一个独立 `--user-data-dir` 的 Chrome，
用 `Target.createTarget` + `Target.attachToTarget {flatten:true}` 拿 session，
之后所有命令带 `sessionId` 下发。

> WebRTC 那套要的 `--use-fake-ui-for-media-stream` 在这里**不需要**——passkey
> 不碰摄像头/麦克风。虚拟 authenticator 完全通过 CDP 注入，没有任何 Chrome flag
> 依赖，这也是这次比 WebRTC E2E 顺利得多的原因。

## 3. 注入虚拟 authenticator `[AUTOMATED]`

```jsonc
// 1) 打开域
{"method": "WebAuthn.enable", "params": {}, "sessionId": "<S>"}

// 2) 加一枚平台 authenticator（等价于 Touch ID / Face ID 那类内置验证器）
{"method": "WebAuthn.addVirtualAuthenticator", "sessionId": "<S>", "params": {
  "options": {
    "protocol": "ctap2",
    "transport": "internal",
    "hasResidentKey": true,
    "hasUserVerification": true,
    "isUserVerified": true,
    "automaticPresenceSimulation": true
  }
}}
// → {"authenticatorId": "53d10eab-4c1b-412e-a36d-e23f2d03493c"}
```

两个参数是这条路走通的关键：

- `isUserVerified: true` — 让 UV 标志位直接置位。缺了它服务端会因
  `user verification required` 拒签。
- `automaticPresenceSimulation: true` — 自动"按下"验证器。缺了它
  `navigator.credentials.get()` 会一直挂着直到超时，headless 里没人能去点。

查看已铸出的凭据（验证用）：

```jsonc
{"method": "WebAuthn.getCredentials", "sessionId": "<S>",
 "params": {"authenticatorId": "<id>"}}
```

## 4. 完整流程实测结果 `[AUTOMATED]`

驱动脚本按顺序走：密码登录 → 加 passkey → 登出 → passkey 登录 → 删除 → 复查。
以下为 2026-07-19 抓取的真实输出：

```
[authenticator]                  added, id=53d10eab-4c1b-412e-a36d-e23f2d03493c
[login page (0 credentials)]     passkey button present = false
[password login]                 landed on: Relayium Admin · 用户 | /admin
[settings page]                  passkey-add form revealed by JS = true
[credentials.create()]           CONTEXT-DESTROYED (navigation — expected on success)
[authenticator state]            1 credential(s) stored; rpId=localhost
[passkey table]                  CDP Virtual 2026-07-19 16:08 从未使用 删除
[login page (1 credential)]      passkey button present = true
[credentials.get()]              CONTEXT-DESTROYED (navigation — expected on success)
[passkey login result]           landed on: Relayium Admin · 用户 | /admin
[signCount]                      2
[delete]                         submitted
[passkey table after delete]     尚未添加 passkey
[login page (0 credentials again)] passkey button present = false
```

逐条对应的结论：

| 步骤 | 断言 | 结果 |
| --- | --- | --- |
| 零凭据登录页 | 不渲染「使用 passkey 登录」按钮 | 通过 |
| 密码登录 | `admin`/`testpw` 进入后台 | 通过 |
| 设置页 | `passkey-add` 表单被 JS 揭开（`hidden=false`） | 通过 |
| 添加 passkey | step-up 表单 + `credentials.create()` 成仪式 | 通过 |
| 凭据落库 | 表格出现该 passkey，RP ID 为 `localhost` | 通过 |
| 一枚凭据登录页 | 按钮出现 | 通过 |
| passkey 登录 | `credentials.get()` → 直接进入后台 | 通过 |
| 删除 | 表格回到「尚未添加 passkey」 | 通过 |
| 删除后登录页 | 按钮再次消失 | 通过 |

### 4a. 补充确认（防"假通过"）`[AUTOMATED]`

上表里「passkey 登录成功」有一个陷阱：如果登出没真正生效，那停在 `/admin`
只是旧 cookie 还在，跟 passkey 一点关系没有。为排除这种假阳性，另跑了一轮确认：

```
logout really cleared session (login page, no dashboard): true
passkey row after passkey login: VerifyPass 2026-07-19 16:09 2026-07-19 16:09 删除
still shows 从未使用 (should be false): false
signCount: 2
wrong step-up password -> rejected: 账号、密码或验证码错误
```

三条独立证据说明这次登录是服务端真验过的，而非 cookie 残留：

1. 点按钮**之前**页面是登录页（`.passkeys` 区块不存在），会话确已清空；
2. 登录后该行「最后使用」由「从未使用」变成了具体时间——**这个字段只有服务端
   验签通过才会写**；
3. 虚拟 authenticator 的 `signCount` 递增，证明确实签发了一次断言。

外加一条负向用例：step-up 表单填错密码被正确拒绝，没有绕过。

### 4b. 自动化里踩到的两个坑

留给下次跑的人，都不是产品缺陷：

1. **成功路径会摧毁 JS 执行上下文。** 注册成功走 `location.reload()`、登录成功走
   `location.href='/admin'`，`Runtime.evaluate` 因此报
   `Inspected target navigated or closed`。这是**成功**的信号，不是错误——驱动脚本
   要把这个异常当成正常分支吞掉，再从新上下文里复查状态。
2. **删除按钮上的 `confirm()` 在 headless 里没人应答。** 表格里的删除表单带
   `onsubmit="return confirm(...)"`。自动化中先 `f.onsubmit = null` 再提交即可；
   真人操作时这个二次确认是应该保留的。

**本轮未发现任何产品缺陷。**

## 5. 清理 `[AUTOMATED]`

```bash
pkill -f relayium-passkey
rm -f /tmp/relayium-passkey /tmp/passkey-test.db
rm -rf /tmp/passkey-chrome /tmp/passkey-blobs
```

---

## 6. 手工验证清单 `[MANUAL — 尚未执行]`

以下四项**机器覆盖不了**，CDP 虚拟 authenticator 再逼真也代替不了真实生物识别、
真实跨设备 CTAP 通道、以及真实的"把 JS 关掉"。**下面每一条都还没跑过，留给人工。**

- [ ] **真机 Touch ID 登录（Mac）**
      Safari 与 Chrome 各走一遍：设置页添加 passkey → 登出 → 登录页点「使用
      passkey 登录」→ 弹出 Touch ID → 按下指纹后进入后台。
      重点看：钥匙串里落的是本机 passkey，且「最后使用」有更新。

- [ ] **真机 Face ID 登录（iPhone）**
      在 iPhone Safari 上打开后台，用已同步到 iCloud 钥匙串的 passkey 登录，
      确认 Face ID 弹窗出现且验证后直接进入后台。

- [ ] **手机跨设备扫码登录**
      在一台**没有**该 passkey 的桌面浏览器上点「使用 passkey 登录」，选「使用
      其他设备上的 passkey」，用手机扫二维码，经蓝牙/CTAP 混合通道完成验证。
      这条走的是与本地平台验证器完全不同的传输层，必须真机验。

- [ ] **禁用 JavaScript 后，密码 + TOTP 表单仍可正常登录** ← **最重要的一条**
      这是整个特性的渐进增强保证：passkey 是**新增**通道，不是替代通道。
      在浏览器设置里彻底关掉 JS，然后确认——
      - 登录页的密码（+ TOTP）表单照常提交，能进后台；
      - 「使用 passkey 登录」按钮即便渲染出来点了也不会破坏页面；
      - 设置页的「添加 passkey」表单**不出现**（它 ship 出来就是 `hidden`，只有 JS
        跑起来才揭开，所以关了 JS 绝不会露出一个点了没用的控件）。

      任何一条不成立都意味着后台在无 JS 环境下被锁死，属于必须立刻修的回归。

> 部署提醒：产线的 `RELAYIUM_ADMIN_PASS` 与 `RELAYIUM_ADMIN_TOTP_SECRET` 必须保持
> 配置正常——passkey 是新增通道，密码后备必须始终可用。首次部署后**先注册一枚
> passkey 再登出**，免得在零凭据状态下反复走密码流程。
