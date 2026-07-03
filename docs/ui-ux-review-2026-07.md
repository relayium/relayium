# Relayium 前端 UI/UX Review（2026-07）

> 范围：`web/src` 下全部页面与交互组件（LAN 首页、跨网络页、配对码、分享链接、存储上传、下载页、账户弹窗、导航、营销区块），基于源码通读，未跑真机多设备实测。
> 与 `optimization-requirements-2026-07.md`（功能/协议层缺口）互补，本文只关注 **UI 呈现与交互体验**。
> 每条附代码位置，便于逐条转成 issue。

## 总体评价

前端整体质量高于典型 MVP 水准：全局 `:focus-visible` 焦点环、统一按钮系统、暗色模式、拖拽全窗投放层、传输进度写入标签页标题、wake lock、断点重连/续传的状态呈现（resuming/finishing）、QR 懒加载、FAQ 用原生 `details`……这些细节都做对了。下面的优化点大多是"从能用到顺手"的打磨，按优先级分三档。

---

## P0 — 直接影响核心流程的体验问题

### 1. 错误提示颜色语义混乱：紫色（accent）被当作错误色

`CodePairing`、`CrossNetwork`、`StoredUpload`、`DownloadPage`、`CrossPage` 的 `.error` 全部使用 `color: var(--accent)`（品牌紫），只有 `Account.svelte` 的 `.err` 用了 `var(--danger)`（红）。

- 紫色不传达"出错了"的语义，且与页面上大量正常的 accent 元素（按钮、badge、链接）无法区分——用户可能把"链接已失效"当成一句普通提示。
- 位置：`CodePairing.svelte:153`、`CrossNetwork.svelte:99`、`StoredUpload.svelte:127`、`DownloadPage.svelte:223`、`CrossPage.svelte:176-180`。
- 建议：统一改用 `var(--danger)`，错误块（如 `linkDead`）背景/边框也换成 danger 系。`--danger` 变量已存在且有暗色适配，改动成本极低。

### 2. 登录/注册表单不是 `<form>`，密码管理器基本失效

`Account.svelte:176-186`：email/password 是裸 `<input>` 堆在 `<div>` 里，提交靠按钮 `onclick`。

- 没有 `<form>` + `type="submit"`：浏览器/1Password/iCloud 钥匙串很难识别为登录表单，自动填充与"保存密码"提示不可靠——对一个跨设备工具，用户在新设备上登录是高频动作，这是真实摩擦。
- 没有任何 `autocomplete` 属性（`email` / `current-password` / `new-password`）；改密表单的三个密码框同样裸奔（`Account.svelte:157-160`）。
- email 输入框按 Enter 不提交（只有 password 框绑了 Enter，`Account.svelte:178`）。
- 建议：包一层 `<form onsubmit|preventDefault={onSubmit}>`，按钮改 `type="submit"`，补全 `autocomplete`、`name` 属性；注册/改密场景用 `new-password` 以触发密码管理器的强密码生成。

### 3. 配对码倒计时归零后界面停在"0:00 + 等待中"，不进入过期态

`CodePairing.svelte:35-38`：`left <= 0` 时只把文案定格为 `0:00` 并停止 tick，出码方界面仍显示大号配对码、复制按钮、QR 和"等待对方加入"。

- 码其实已失效，对方此时输码会失败，而出码方毫无提示，两边互相干等——这是配对流程里最容易出现的死角。
- 建议：归零时切换到已有的 `expired` 分支（提示已过期 + "重新生成"按钮），把 `expired` 从纯 prop 改为"prop || 本地倒计时归零"。

### 4. 存储上传：加密到 100% 后进入无进度的"上传中"，且无法取消

`StoredUpload.svelte:10-13, 43-49`：进度条只反映加密阶段，之后的 POST 没有任何进度；上传期间唯一的交互是被 disable 的选择按钮，没有取消。

- 传一个几百 MB 的文件时，用户会长时间面对一根停在 100% 的进度条 + 一行"正在上传"，无法判断是否卡死，也无法中止（只能刷新页面）。
- 建议：① 用 `XMLHttpRequest.upload.onprogress`（或 fetch duplex stream）拿到真实上传进度，与加密阶段合成一根两段式进度条；② 提供取消按钮（`AbortController` / `xhr.abort()`）。

### 5. 对端忙时发送方静默挂起，最后报"连接失败"

`App.svelte:348`：接收端 busy 时直接 `return` 丢弃 offer。发送方会停在 "connecting"，直到 ICE 超时才落到 `connectFail`。

- 用户拿到的错误归因是错的（"连不上"），实际是"对方正在传别的文件"。在"一次只允许一个传输"的产品约束下，这个场景并不罕见。
- 建议：接收端 busy 时通过信令回一个 busy 信号，发送端立即显示"对方正忙，请稍后再试"；纯前端兜底方案是把 `connectFail` 文案改为涵盖"对方可能正忙"。

### 6. 设备名不可读、不持久、不可编辑

`App.svelte:327-330`：设备名为 `navigator.platform + 随机三位数`（如 `MacIntel-742`），每次刷新都变。

- 对端看到的是一串机器味十足且刷新即变的名字，多设备场景（用户画像正是"many servers/devices"）下无法稳定辨认谁是谁；`navigator.platform` 本身已废弃，未来只会更不准。
- 建议：① 首次生成后写入 `localStorage` 持久化；② 默认名改为更友好的"形容词+设备类型"或基于 UA-CH 的可读名；③ 在 Hero 的"已连接为 X"处允许点击改名（同类产品 LocalSend/PairDrop 均支持）。

---

## P1 — 明显可感知的打磨点

### 7. 配对码输入：Enter 不提交、无自动提交、进入后无返回

`CodePairing.svelte:112-123`：

- 输入满 6 位后必须用鼠标点"加入"，`Enter` 无效；也可以在输满 6 位时自动提交（数字验证码的通用惯例）。
- 从"选择模式"进入"输码模式"后没有返回按钮，想改为"发送方"只能刷新或切页。

### 8. 下载页把网络失败也报成"解密失败"

`DownloadPage.svelte:94-97`：`downloadBlob` 的 catch 一律 `errKey = "decryptFail"`。中途断网的用户会以为链接坏了/密钥错了，而实际重试即可。建议区分网络错误与完整性/解密错误，网络错误给"重试"按钮。

### 9. 上传大小限制没有前置展示

`StoredUpload.svelte:51`：用户只有在传完、吃到 413 后才知道超限。建议在选择文件入口旁标注上限（可从后端 config 接口带出），选择超限文件时本地即时拦截。

### 10. 分享链路缺 Web Share API

`StoredUpload` / `CrossNetwork` / `CodePairing` 生成链接后只有"复制"和 QR。移动端上 `navigator.share` 是把链接发进微信/WhatsApp 的最短路径，一行能力检测即可渐进增强。

### 11. 传输进度缺剩余时间（ETA）

`App.svelte:967-973` 的 meta 行已有速度和百分比，`(total - sent) / speed` 即可算 ETA。大文件传输时"还要多久"比"多快"更被关心。

### 12. LAN 空状态是死文案，缺引导

`App.svelte:894-895`：无设备时只显示一句"等待设备出现"。这是新用户的第一屏，建议：① 提示"在同一 Wi-Fi 的另一台设备上打开 relayium.app"（可配 QR 指向本站）；② 附一句"设备不在同一网络？→ 跨网络传输"引流到 cross 页。目前首页那张跨网 CTA 卡在营销区块里，位置太低。

### 13. 传输完成缺主动通知

标签页标题的进度百分比已做（`App.svelte:137-142`），但完成时用户若在别的标签页/应用中不会得到任何提醒。建议：完成/失败时用 Notification API（权限仅在首次传输时请求）或至少让标题闪烁提示。

### 14. 账户弹窗无焦点管理

`Account.svelte:147-203`：modal 打开后焦点仍留在触发按钮，Tab 会穿透到背后的页面元素（无 focus trap），打开时也没有 autofocus 到 email 输入框。Esc 关闭已做。对话框建议换 `<dialog>` 元素或补 trap + 初始聚焦。

### 15. 动态状态对屏幕阅读器不可见

- toast（`App.svelte:999-1001`）、传输状态行、上传阶段文案都没有 `aria-live`，状态变化读屏无感知。
- 三处进度条（App/StoredUpload/DownloadPage）都是纯 `div`，缺 `role="progressbar"` + `aria-valuenow`。
- 建议：toast 和状态行加 `aria-live="polite"`，进度条补语义属性。

### 16. 密码登录没有"忘记密码"路径

`Account.svelte`：开启 magic link 的部署尚可绕行，纯密码部署下忘记密码 = 永久失联。至少在登录错误时提示可用的找回方式，或补一个基于邮件的重置流程。

---

## P2 — 低优先级 / 锦上添花

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 17 | "发送文件夹"按钮在 iOS Safari 上不可用（`webkitdirectory` 无 UI 支持），点了行为怪异 | `App.svelte:920-923` | iOS 上隐藏该按钮 |
| 18 | toast 用 `position: sticky` 占文档流，出现/消失会把下方内容顶来顶去 | `App.svelte:1058-1064` | 改 fixed overlay，消除 layout shift |
| 19 | 导航守卫用原生 `confirm()`，观感与站内风格割裂 | `App.svelte:277` | 换站内确认弹层（低收益，可不做） |
| 20 | 主题只跟随系统，无手动亮/暗切换 | `app.css:56` | 加三态切换（跟随/亮/暗）持久化到 localStorage |
| 21 | 存储上传 TTL 只有 1/3/7 天三档 | `StoredUpload.svelte:74-78` | 视需求加 1 小时档（阅后即焚场景常配短 TTL） |
| 22 | `i18n.svelte.ts` 110KB，7 种语言全量进主 bundle | `lib/i18n.svelte.ts` | 按语言动态 import，首屏只带当前语言 |
| 23 | Nav 用 `role="tablist"/"tab"` 但实为页面路由，缺 `aria-controls`，语义不准 | `Nav.svelte:17-27` | 改为普通 nav 链接语义（`aria-current="page"`） |
| 24 | `folder-btn`（约 33px 高）、`button.x`（✕）触摸目标偏小 | `App.svelte:1111, 1170` | 移动端保证 ≥44px 命中区 |
| 25 | 传输完成卡片需手动 ✕ 关闭，连续传多批时旧卡叠着 | `App.svelte:948-976` | 成功卡片可 N 秒后自动淡出（失败卡保留） |
| 26 | 出码方"等待对方加入"无动效，像卡死 | `CodePairing.svelte:111` | 加个轻量 spinner/呼吸点 |
| 27 | 输错配对码与码过期共用"已过期"文案 | `CrossPage.svelte:74`（linkDead → expired） | 文案改为"码无效或已过期" |
| 28 | 站内无"传输历史/最近发送"（MVP 取舍，已知） | — | 与"我的文件"Mode 2 一起规划 |

---

## 做得好的（不要在后续改动中回退）

- 全局 `:focus-visible` 焦点环 + 统一 `.btn` 体系（`app.css:130-165`）
- 传输中：wake lock、beforeunload 拦截、标签页标题进度、连接路径徽标（LAN/P2P/中继三色点）、断线自动 resume 的状态呈现
- 全窗拖拽层 `pointer-events: none` 不抢卡片 drop；drag 深度计数避免闪烁
- QR / qrcode 库懒加载并处理竞态取消
- ModeCompare 的表格在窄屏重排为卡片、FAQ 用原生 `details`
- 下载页的零知识说明、阅后即焚警告、过期倒计时（临期变色）

## 建议落地顺序

1. **一小时内可完成的**：#1 错误色统一、#8 下载错误归因、#27 文案、#3 倒计时过期态。
2. **半天档**：#2 表单语义化、#7 配对码输入交互、#6 设备名持久化+可编辑、#15 aria 补齐。
3. **一天以上**：#4 上传真实进度+取消、#5 busy 信令、#13 完成通知、#22 i18n 拆包。
