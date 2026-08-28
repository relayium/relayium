# Relayium 优化需求清单（2026-07）

> **实施状态（2026-08-05 逐条对代码复核）。** 复核方式是读当前代码，不是读交付记录。
>
> | 条目 | 状态 | 依据 / 缺口 |
> |---|---|---|
> | P0-1 独立 /security 页 | ✅ | `content/legal/security.mjs`，9 语言静态页 |
> | P0-2 首屏降密度 + 视觉演示 | ⏳ **部分** | 技术细节已下沉到 `/security`（FeatureStrip 链接）。**三张流程截图已完成并上线**（2026-08-06 复核）：`web/public/shots/<lang>/{01-devices,02-confirm,03-done}.png`，九语言各一套共 24 张，由 `web/e2e/landing-shots.mjs` 从一次真实的双标签页传输里截出（`4ddacdff`），落地页引用见 `landing-template.mjs`（`4709072a`）。**仅剩 20–30 秒演示动图**，因体积与录制成本单独评估而推迟，需 Owner 定夺 |
> | P0-3 「无需账号」如实修正 | ✅ | 九语言文案已改，并由 `content-claims.test.mjs` 的"发送无需账户"规则锁死（9 语言注入验证） |
> | P0-4 Dockerfile + docker-compose | ✅ | 仓库根 `Dockerfile`、`docker-compose.yml` |
> | P1-1 PWA：SW + share_target | ✅ | `site.webmanifest` 的 `share_target` + `/share-target` 路由 + `sw-template.js` |
> | P1-2 Wake Lock / 断点续传 / 连接路径徽标 | ✅ | `wakelock.ts`、续传 E2E（`web/e2e/lan-transfer.mjs` 第三幕）、`pathLan/pathP2p/pathRelay` |
> | P1-3 文件夹发送 / >10 文件 / ZIP | ✅ | 上限 1,000、`webkitdirectory`（iOS 隐藏）、zip 4GiB |
> | P1-4 CLI 客户端 | ✅ | 已发布，`server/cmd/relayium`，22 个版本见 `/releases/` |
> | P1-5 持久设备配对（UI 层） | ✅ **已交付（2026-08-24，被"设备收件箱"取代）** | 见本节下方 2026-08-28 的更正说明；原始快照写于 2026-08-05，当时确属未做 |
> | P2 A-1 信任背书区（MIT/无跟踪/GitHub/changelog） | ⏳ **基本完成** | `/releases/` 已上线（`1140ed55`）并进入页脚；**注意报告里的「MIT」已过时**——项目已改为开放内核：`server/`+`web/` AGPL-3.0、`apps/` Apache-2.0、`docs/` CC BY 4.0。首页尚无集中的"背书区"区块，链接分散在 FeatureStrip / 页脚 |
> | P2 A-2 独立 Use Cases / Compare / Docs 页 | ✅ | 12 篇 compare 文章 + `/compare/` 真 hub + `/how-to/` 真 hub（`5e4addaf`）；UseCases 卡片已可点 |
> | P2 B-3 中继策略统一叙事（降级链可视化） | ❌ **未做**（依赖 P1-2 之后的自动降级功能本身） |
> | P2 B-4 管理后台国际化 | ✅ **已完成**（2026-08-06 复核） | `server/account/admin_i18n.go`（24 KB）+ `admin_i18n_test.go`；`adminLangFrom()`、语言 Cookie、`POST /admin/lang`（`admin.go`），`Lang` 已贯穿每个模板结构体。提交 `0c9e30d4`…`bf8e527d`。有意保留中文的只剩切换器自身的「中文 / EN」（语言名以自身语言呈现）与 Go 注释 |

> **更正（2026-08-28）。** 上表其余各行仍是 2026-08-05 那次逐条复核留下的快照，
> 不再逐行重核；只有 P1-5 这一行被就地更新，因为它已经被实现取代，而"❌ 未做"
> 会把一件已交付的能力读成待办。
>
> P1-5「持久设备配对」由 **设备收件箱（Device Inbox / My Devices）** 交付并
> **取代**，2026-08-24 合并（提交 `c63d4c5e`）。交付形态与原需求写的不同，
> 因此记为 superseded 而非逐字完成：设备不是靠一次 SAS 比对互相"记住"，而是
> 在账户下**登记为设备**并注册可轮换、可吊销的长期 X25519 公钥；发送方把任务
> 内容密钥用 sealed box 封给目标设备的公钥，中央既读不到明文也读不到密钥。
> 原需求想解决的痛点（自己的机器之间反复传文件不必每次比对校验码）因此成立，
> 而且比原方案更强：目标离线时任务进队列等待，设备上线后自己领取、解密、校验并
> 落盘，只有设备回报"已写入磁盘"才算 `saved`。
>
> 可核对的入口（本仓库内，不依赖任何未发布文档）：
> 线路协议 `docs/protocol/relayium-device-inbox-v1.md`（§7 密钥生命周期、
> §13 状态机、§15 领取与租约）与 `relayium-device-inbox-v2.md`；
> 冻结不变量 `docs/DEVICE-INBOX-ADMISSION-CONTRACT.md`；
> 实现 `server/internal/inbox/`、`server/account/deviceinbox*.go`、
> `server/internal/inboxclient/`、`web/src/lib/device-inbox.ts`；
> 公开产品页 `/device-inbox`。
>
> 下方"P1-5 持久设备配对（UI 层）"小节保留 2026-07 的原始需求措辞，作为当时的
> 记录，不再作为待办。

> 来源：一份基于公开页面的竞品调研报告（LocalSend / PairDrop / ShareDrop / ToffeeShare / Wormhole / AirDrop / Quick Share），
> 经过与代码库实况逐条核对后筛选。报告作者未读源码，因此部分建议已实现、部分建议与实际情况有偏差，本文档只保留**真实缺口**，并补充了报告没有发现的问题。
>
> **实施进度（2026-07-02）**：P0 四项全部完成并验证——
> - P0-1 `/security` 六语言威胁模型页（生成 18 个静态页、footer 已链接、真实 Go 服务器路由已验证）
> - P0-2 首屏「如何使用」改为可视化步骤流（内联 SVG，已截图确认）+ FeatureStrip 增加「了解如何加密」跳转 /security
> - P0-3 修正「无需账号」不实文案（README / index.html / llms.txt；应用内 i18n 本就准确）
> - P0-4 根目录 `Dockerfile` + `docker-compose.yml` + `.dockerignore`（两阶段构建已在本机验证）+ 旧版部署文档的 Docker 章节（该文档后来被拆分：面向公众的部分并入 `docs/self-hosting.md`，运维专属部分移入私有 relayium-ops 仓库）
> P1（含 CLI）与 P2 待后续。
>
> **P1 进度（2026-07-02 续）**：
> - P1-1 PWA ✅ 完成——手写 Service Worker（自写 Vite 插件注入 hashed 资源预缓存 + 版本失效）+ manifest `share_target` + 入站分享落地（Android/Chromium；iOS 不支持已如实说明）。
> - P1-2 ✅ 全部完成——Wake Lock + 连接路径徽标；断点续传（同会话重连 + 按 chunk + 自动重连，复用已认证密钥、单调 nonce，经四智能体评审加固，见 `specs/2026-07-02-p1-2-resumable-transfer-design.md`）。协议层充分单测；连接编排需真机验证。
> - P1-3 ✅ 完成——文件夹发送（webkitdirectory + 拖拽目录递归、保留相对路径）、`MAX_FILES` 10→1000（含 manifest 字节守卫）、接收端嵌套目录写入、缺 FSA 浏览器手写 store-only ZIP 兜底。
> - P1-4 CLI、P1-5 持久配对 待后续。

---

## 一、报告建议中「已经实现、无需再做」的部分

核对代码后，以下报告建议实际已存在，不列入需求：

| 报告建议 | 实况 | 证据 |
| --- | --- | --- |
| QR 码配对（报告列为 P1） | 已有三处 QR：配对码加入链接、分享链接、下载链接 | `web/src/lib/CodePairing.svelte`、`CrossNetwork.svelte`、`StoredUpload.svelte` |
| 两个模式的用户化包装 | 跨网络页已有三张卡片（配对码 / 分享链接 / 下载链接）+ 模式对比表 | `web/src/lib/CrossPage.svelte`、`ModeCompare.svelte` |
| FAQ + 竞品对比 | FAQ 组件 + JSON-LD + README/首页对比表（vs AirDrop/WeTransfer/Snapdrop/PairDrop） | `web/src/lib/Faq.svelte`、`web/index.html` |
| TURN / 复杂网络回退 | coturn + TURN-REST 临时凭证已接好 | `server/account/turn.go`（生产 coturn 配置见私有 relayium-ops 仓库，公开的 Docker relay profile 见 `docs/self-hosting.md`） |
| 多文件传输、进度/速度显示、关页警告 | 最多 10 文件、进度+实时速率、beforeunload 警告均有 | `web/src/lib/transfer.ts`、`App.svelte` |
| 多语言 | 6 语言 i18n 已全量覆盖 | `web/src/lib/i18n.svelte.ts` |
| SAS 命名用户化 | UI 已叫「校验码 / Verification code」，非报告担心的裸「SAS」 | i18n `codeLabel` |

**结论：报告约三分之一的 P0/P1 建议已经落地。真正值得做的是下面这些。**

---

## 二、真实缺口 — P0（现在做）

### P0-1 独立 Security / 威胁模型页面【✅要做】
- **现状**：安全叙事散落在首页 FeatureStrip、FAQ、README、SECURITY.md，SPA 无 `/security` 路由。
- **需求**：新增 `/security` 页面（可复用 legal 静态页生成方式 `web/scripts/gen-pages.mjs`，6 语言）。内容：服务器能看到什么 / 看不到什么、SAS + commit-reveal 防什么、何时走 TURN、下载链接的 URL fragment 密钥如何处理、浏览器兼容限制。
- **理由**：这是 Relayium 相对 Snapdrop/PairDrop 唯一的硬差异（应用层 E2EE + SAS + 密钥承诺握手，`web/src/lib/crypto.ts` 里实现相当扎实），但目前没有一个可链接的信任资产页。首屏可以因此减负——把技术细节从首屏移到这里。

### P0-2 首屏信息降密度 + 视觉演示【✅要做】
- **现状**：Hero 一句 tagline + 连接状态，但 How-it-works 是文字列表，无截图/动图；首页信息密度偏文档化。
- **需求**：
  1. 首屏改为「一句产品承诺 + 两个入口（立即传 / 生成加密链接）」；技术参数下沉到 /security。
  2. 增加一段 20–30 秒演示动图或三张流程截图（打开两设备 → 选文件 → 比对校验码 → 完成）。
- **理由**：LocalSend/PairDrop 的经验：用户 5 秒内要看懂「怎么传」，而不是密码学参数。这是纯前端/内容工作，成本低收益高。

### P0-3 「无需账号」宣传与实际不符 —— 按实际情况如实讲【已定：如实修正文案，✅要做】
- **决策**：不采取「给匿名用户开放下载链接」的方向。宣传本来就说错了——实际上有些方式确实需要账号，那就**按实际情况如实说明**，不为了对齐口号去改产品。
- **现状**（报告没发现的问题）：README / 首页宣传「无需账号 no account」，但跨网络的「分享链接」和「下载链接」两个模式**发送方必须登录**（`CrossPage.svelte` 用 `session().user` 门控），只有局域网和配对码是匿名的。这是事实性错误。
- **需求**：全面修正对外措辞，明确区分——
  - **免账号**：局域网实时传输、配对码（`POST /api/pair` 本就免认证）；
  - **需登录**：分享链接、下载链接（托管模式）。
  - 落地位置：README 的「无 account」表述与对比表、首页 Hero / FeatureStrip / FAQ 文案、六语言 i18n（`web/src/lib/i18n.svelte.ts`）、`llms.txt` 等 SEO 文案。措辞方向：不再笼统说 "No account"，改为如「实时传输免账号；生成托管链接需登录」。

### P0-4 Dockerfile + docker-compose【✅要做】
- **这是什么（补充解释）**：
  - **Dockerfile** = 一份「打包配方」。它把 Relayium 服务器连同运行环境封装成一个标准化镜像，任何装了 Docker 的机器上一条 `docker run` 就能跑，不用手动装 Go、配 nginx、写 systemd 服务。
  - **docker-compose** = 一份「编排配方」（一个 `docker-compose.yml` 文件）。它把多个容器——Relayium 服务器 + coturn（TURN 中继）+ redis（中继流量计量）——一次性拉起来、自动连好网络，`docker compose up` 一条命令启动整套。
- **现状**：README 提到 Docker、旧版部署文档（已拆分/下线，见上）有 nginx+systemd 手动部署教程，但仓库里**没有任何 Dockerfile**。
- **需求**：单体 Dockerfile（服务端 Go 二进制已内嵌前端静态文件，一个镜像即完整应用）+ 可选 `docker-compose.yml`（server + coturn + redis 一键编排）。
- **理由**：自托管用户最怕的就是「照着部署文档手动装一堆东西」。Relayium 服务端本来就是单个 Go 二进制，打成镜像几乎零额外成本，却能把自托管门槛从「一小时折腾」降到「一条命令」——这是吸引隐私用户 / 公司内网 / 开发者的入场券，PairDrop 已支持。

---

## 三、真实缺口 — P1（下一阶段）

### P1-1 PWA 补全：Service Worker + share_target
- **现状**：有 manifest（可安装），但无 Service Worker（无离线壳），manifest 无 `share_target`，也没用 `navigator.share`。
- **需求**：加 SW 缓存应用壳（注意：信令/传输本身需在线，SW 只解决秒开与安装体验）；manifest 加 `share_target`，支持从 Android/iOS 系统分享菜单直接把文件发进 Relayium。
- **理由**：移动端「分享菜单 → Relayium」是 PairDrop 验证过的高频路径，也是不做原生 App 前提下最大的移动端体验提升。

### P1-2 传输可靠性三件套：Wake Lock、断点续传、连接路径显示
- **现状**：无 `navigator.wakeLock`（手机息屏会断传输）；无字节级续传（只有 ICE-restart 和整体重试）；UI 不显示当前走直连还是中继（`webrtc.ts` 未读 `getStats()`）。
- **需求**，按性价比排序：
  1. **Wake Lock**（几十行代码，直接消灭移动端最常见的失败原因）；
  2. **连接路径徽标**：读 `getStats()` 的 selected candidate pair，显示「局域网直连 / P2P / 中继」——同时是信任资产（呼应 README 的 LAN→P2P→relay 协议愿景）；
  3. **断点续传**：大文件按 chunk 序号续传（协议已有 chunk 计数和链式 SHA-256，有基础）。这条工程量最大，可单独立项。

### P1-3 文件夹发送 / 超过 10 文件 / ZIP 下载
- **现状**：发送上限 `MAX_FILES = 10`，无 `webkitdirectory` 文件夹选择，无 ZIP 打包；接收端已能用 File System Access API 流式写目录（`filesink.ts`），基础是好的。
- **需求**：发送端支持文件夹选择（保留相对路径）；放宽/移除 10 文件上限；对不支持目录写入的浏览器（Safari/Firefox）提供 ZIP 流式下载兜底。
- **理由**：目标用户（开发者、多设备工作流）传目录是刚需；Magic Wormhole/PairDrop 均已支持。

### P1-4 CLI 客户端【📌已确认要做，本轮暂不实施 —— 待办记录】
- **状态**：确认后面要做，现在暂时不做。先在此登记，避免遗漏。
- **现状**：无 CLI，README 排在 M3。
- **需求**：Go CLI（`relayium send <file>` / `relayium receive <code>`），复用现有配对码 API（`POST /api/pair` 本就免认证）+ X25519/AEAD 协议层。
- **理由**：这是项目最初的定位（服务器之间传文件、CLI-first），也是与所有浏览器竞品拉开差距的一步。README 说「crypto layer is deliberately decoupled from transport」——CLI 是兑现这句话的证明。
- **提醒**：协议层已与传输解耦，越晚做越容易被 Web 端假设绑死；正式开工前建议先出一版协议层复用设计，确保 CLI 与 Web 共用同一套 X25519/AEAD/SAS 实现。

### P1-5 持久设备配对（UI 层）—— 已由设备收件箱取代（2026-08-24，`c63d4c5e`）

> **状态：superseded。** 以下三条是 2026-07 写下的原始需求，原样保留作为记录。
> 交付物是设备收件箱（Device Inbox / My Devices），形态与这里描述的"轻量版
> 互相记住"不同——见本文档开头 2026-08-28 的更正说明与其中列出的仓库内权威。
> 不要把这一节当作待办来排期。

- **现状（2026-07 原文）**：服务端 `/api/devices` 设备注册表已存在，但 UI 层的「常用设备免重复确认」被显式推迟（`docs/superpowers/specs/2026-06-30-cross-device-my-files-DEFERRED.md`）。
- **需求（2026-07 原文）**：不必等「我的文件」保险库方案，可先做轻量版：两台设备完成一次 SAS 验证后可互相「记住」，下次直接出现在附近列表，跳过校验码比对（密钥指纹固定，变更即警告，类似 SSH known_hosts）。
- **理由（2026-07 原文）**：自己的 MacBook ↔ 手机反复传文件每次都要比对校验码，是留存杀手；PairDrop 的 Persistent Pairing 已验证需求。注意与已推迟的 my-files Mode 2 解耦，避免范围蔓延。

---

## 四、真实缺口 — P2（中长期储备，暂不排期）

> 本节为「待办储备」：先登记、不排期，等 P0/P1 推进后视数据与资源再取用。按依赖关系归为两组。

**A. 站点内容与信任（可在 P0 首页重构之后顺势做）**
1. **信任背书区**：首页放 MIT / no tracking / GitHub 链接 / 公开 changelog；有数据后再加传输量、stars。目前无 changelog 页、无 stats 页。
2. **网站信息架构扩展**：独立 Use Cases / Compare / Docs 页面（目前 UseCases 是首页组件，Compare 只在 README 和跨网络页表格里）。等 P0 首页重构落地、看 SEO 效果后再决定是否拆页。

**B. 工程与运营（依赖前序功能或面向自托管者）**
3. **中继策略统一叙事**：目前 LAN 模式只发 STUN、配对码/分享链接才发 TURN（`/api/ice` 按 token 门控）。未来做「LAN direct → P2P → Relay → Encrypted Link 自动降级」时，把 P1-2 的路径徽标升级为完整降级链可视化。（依赖 P1-2）
4. **管理后台国际化**：admin 界面目前纯中文（`server/account/admin_templates.go`），开源自托管用户是国际的，需要至少英文。（配合 P0-4 自托管一起考虑）

---

## 五、报告建议中「不采纳 / 缓做」及理由

- **「Nearby Transfer 单独作为一个模式卡片」**：现状 LAN 发现就是默认首页行为，无需再包一层模式概念，只需在文案里讲清楚。
- **「持久配对照抄 PairDrop 的 room 机制」**：Relayium 有应用层密钥，应基于密钥指纹做（见 P1-5），照抄反而丢掉差异化。
- **「首页放 GitHub stars/下载量」**：项目早期数据不好看时放数字是负资产，P2 再说。
- **「模式改名 Direct Transfer / Encrypted Link」**：现 UI 命名（配对码/分享链接/下载链接）已经是用户化命名且六语言落地，是否再改英文品牌名属于文案层决策，随 P0-2 首页重构一起定，不单独立项。

---

## 六、建议的执行顺序（本轮决策后）

**本轮确认要做（P0 全部）：**
1. **P0-3 文案如实修正** — 先定「哪些免账号、哪些需登录」的准确口径，因为它决定 P0-2 首页文案与 P0-1 安全页怎么写。
2. **P0-1 + P0-2** — /security 页与首页重构一起做（安全细节从首屏下沉到 /security，内容互相搬运）。
3. **P0-4 Dockerfile / docker-compose** — 半天工作量，独立可做。

**已确认、后续再做（不在本轮）：**
4. **P1-2 之 Wake Lock + 路径徽标**、**P1-1 PWA**、**P1-3 文件夹发送**、**P1-5 持久配对** — 按移动端流量与资源决定先后。
5. **P1-4 CLI** — 📌已登记，本轮不做；正式开工前先出协议层复用设计。

**储备、暂不排期：** 第四节 P2 全部。

---

## 七、下一次 macOS 功能版本必须评估的体验优化（2026-08-25 新增）

> 本节只登记需求，不进入当前订阅服务端修复，也不触发本次发版。下一次 macOS 功能版本立项时必须纳入范围评估、实现或给出明确的延期决定。

### M-1 跨网络传输与设备收件箱支持文件拖拽

> **状态：in progress（实现完成，待 Codex 独立评审与验收）。2026-08-26。**
> 分支 `work/macos-1.3.8-drag-drop`，随 macOS 1.3.8 / build 26 交付。
> **实现**：新增可复用投放适配器 `RelayiumAppKit/FileDropAdmission.swift`
> （`admitFileDrop` 决定接受/整批拒绝/忙碌拒绝）与 SwiftUI 修饰符
> `FileDropReceiver` / `View.acceptsFileDrop`（`apps/mac/Relayium/FileDropZone.swift`）。
> 两个目标界面复用同一 `SelectionStore.add`，与文件选择器完全同一条校验链
> （`expandSelection`、`MAX_FILES`、单路径字节上限、符号链接拒绝、根去重、
> 沙盒扩展语义），不新增任何并行校验或发送逻辑。
> - **跨网络传输**：投放落在**已配对**的 `TransferLinkPane`（`link/1` 工作区），
>   而非配对前的 `CrossNetworkConnectPane`——后者按既有产品决策不得暂存任何内容，
>   已加 `testTheDragDidNotReachEitherPreConnectScreen` 守护。投放只暂存，
>   由新增的 `link-drop-send` 显式发送；`link-drop-clear` 为取消。
>   闸门为 `link.acceptsWork`（连接已开启且 SAS 已比对），与两个选择器按钮一致。
> - **设备收件箱**：投放落在 `DeviceConversationPage` 的文件分组，闸门为
>   `target == nil`（失效目标即无投放目标），发送仍为既有 `inbox-send-start`。
> - **一致性**：拖拽不自动发送、不选择对端/设备、不绕过任何闸门；两个界面的
>   键盘可达文件选择器均保留未改动。
> - **整批语义**：任一项目无法解码即整批拒绝并提示（`drop.refusedUnreadable`），
>   不再静默丢弃个别项目——这是本轮相对旧投放实现的行为收紧。
> - **新增文案**：仅 en 与 zh-Hans 两种维护语言（`drop.sendHint`、
>   `drop.refusedUnreadable`）。
> - **失效目标（Codex 评审发现的竞态，已修复）**：`isBusy` 只能回答“此界面此刻
>   是否可写”，无法回答“它是否仍是被投放的那个界面”。`TransferLinkPane` 在
>   `.ended` 下仍会渲染（`hasSession` 为真），且 `connect` 可从 `.ended` 直接开启
>   下一次尝试而无需 `dismiss`，因此该界面连同其 `@StateObject SelectionStore`
>   会跨越一次尝试存活：在尝试 N 上被接受的拖拽，若其 `NSItemProvider` 解析期间
>   N 结束且 N+1 已开启，`!link.acceptsWork` 会再次为假，旧投放便会暂存到新的
>   对端上。修复落在可复用适配器边界：`FileDropContext` 为界面身份的不透明取值，
>   `FileDropReceiver` 在 `onDrop` 接受的同一同步时刻捕获它（早于 `Task` 跃迁），
>   在项目解析完成后与当前取值再次比对，不一致即 `refusedStaleContext`，与忙碌
>   同样静默拒绝且不落入 `store.add`。顺序上失效先于忙碌判定：目标一旦被替换，
>   `isBusy` 描述的是替换者，用它命名拒绝理由会指向用户从未投放过的界面。
>   `LinkWorkspaceModel` 新增只读 `attemptGeneration`（`beginAttempt` 是其唯一
>   写入点，覆盖主动与被动全部新尝试路径），跨网络传输以尝试号为取值。
> - **设备收件箱是否需要该取值**：需要，取 `peerID`。其 `target` 语义（`target == nil`
>   即无合法目标）只回答能否发送，不回答“这是哪台设备”。`peerID` 虽是 `let`，
>   但视图身份归宿主所有：宿主若不给该页自己的身份，从一台已打开设备直接切到
>   另一台就会复用该视图及其 `@StateObject selection`。传入 `peerID` 只多一次比较，
>   即可让该页遵守与链接界面同一条规则，而不是依赖当前导航路径恰好会经过 `nil`。
>   **后续更新（M-3，2026-08-26）**：`DeviceInboxSurface` 此后已显式加上
>   `.id(peer.id)`，结构身份成为该页的**主机制**；此处传入的 `peerID` 保留为
>   纵深防御，覆盖"宿主漏加身份"这一情形，两者各有守护断言。
> - **拖拽区（`FileDropZone` 虚线框）保持不变**：其唯一使用者的目标是本账号自身的
>   存储，不随任何连接改变，因此显式传入 `FileDropContext.fixed` 并由守护测试
>   断言全仓仅此一处使用该取值——`fixed` 不得成为任何持有对端/链接/设备的界面
>   绕开该检查的方式。
> - **已暂存批次跨目标存活（Codex 二轮评审接受的第二个阻断项，同族，已修复）**：
>   上一条只关闭了**一次拖拽之内**的窗口——目标在 `NSItemProvider` 解析期间被替换。
>   它之后还有更宽的一段：在尝试 N 上干净落地、或为设备 A 选好的批次，就留在界面
>   自己的 `@StateObject SelectionStore` 里，而两个宿主都会复用该视图。
>   `TransferLinkPane` 跨 `.ended` 一直渲染到下一次尝试；`DeviceInboxSurface`
>   当时在 `if let peer = openPeer` 内渲染 `DeviceConversationPage` 且未显式 `.id`
>   （该页的显式身份由后续 M-3 补上，见下）。两种情况下都没有任何东西清空该 store，
>   于是下一次按下发送，就把用户为别人暂存的文件发给了此刻在场的对象。`admitFileDrop` 帮不上忙：它只覆盖拖拽期间，
>   而这批文件是在替换发生**之前**干净落地的。
>   修复：`RelayiumAppKit` 新增 `StagedSelectionLifetime`——界面在每次渲染时报告
>   自己正在服务的目标，该取值回答 store 无法回答的那个问题：这是否仍是该批次
>   当初被暂存时的那个目标。首次报告永不算替换（刚建好的界面尚未暂存任何东西，
>   把“此前没有答案”当成变化会丢掉 `adoptOpenedFiles` 在首帧之前采纳的批次）。
>   - `TransferLinkPane`：`.onChange(of: link.attemptGeneration)` 上判定替换，
>     并清空 `dropped`、`dropRefusal` 与本界面的 `actionError`。
>     `link.actionError` 不动——它归模型所有，`beginAttempt` 在推进代数的同一
>     路径上已清除它。
>   - `DeviceConversationPage`：`.onChange(of: peerID)` 上判定替换，并清空
>     `selection` 与 `dropRefusal`；已交给 `InboxSendModel` 的发送不受影响
>     （字节已按持久计划复制进本应用自有存储，且已定址到发起时的那台设备）。
>     **后续更新（M-3）**：宿主已加 `.id(peer.id)`，换设备即换视图，因此在当前
>     宿主下这条接线不会触发；它保留为宿主漏加身份时的兜底，且 `.id` 覆盖范围更广
>     （草稿、Copy 确认、两个删除确认等全部重置）。
>   - **链接结束不清空**，这是刻意的：链接结束仍是同一条链接，数字消失了，但该
>     批次暂存给的对端就是重连后要发给的对端，为一次掉线丢弃用户的工作是错的。
>     判定只挂在尝试代数上，不挂在 `connection`、`verification`、`acceptsWork`
>     或模型的 `selectedCandidate` 上，`MacSurfaceGuardTests` 对此有反向断言。
>   - 两个界面在同一目标内的选择器与拖拽行为完全不变：`serving` 只在取值真正
>     改变时返回真，重复渲染（消息到达、字节计数跳动、传输推进）不清空任何东西。
>   - 覆盖：`FileDropAdmissionTests` 以真实 `SelectionStore` 驱动该规则（首次报告、
>     同目标重复渲染 64 次、设备替换、尝试推进、A→B→A 回摆、`.fixed` 永不替换）；
>     `MacSurfaceGuardTests.testAStagedBatchIsDiscardedWhenItsTargetIsSubstituted`
>     断言两个界面确实接线、清空清单完整、且不因其他原因清空。四处变异均已验证
>     会导致测试失败：关闭替换判定、无条件判定为替换、拆掉链接界面接线、拆掉
>     设备页接线。
> - **已知未覆盖**：旧版对端回退界面 `TransferSessionPane` 仍仅支持选择器；
>   拖拽手势本身无自动化覆盖（XCUITest 无法发起 Finder 拖拽），其全部决策由
>   `FileDropAdmissionTests` 覆盖，界面接线由 `MacSurfaceGuardTests` /
>   `InboxSurfaceGuardTests` 覆盖。失效目标另由 `LinkWorkspaceModelTests` 以真实
>   状态机驱动（尝试 N 结束 → 开启 N+1 → 断言 `acceptsWork` 确已恢复为真 →
>   旧投放被拒、同一批次在自身尝试上被接受）。详见 `DEVELOPMENT-LOG.md` 同日检查点。

- **现状**：局域网传输和 Send a Link 已支持直接拖入文件；跨网络传输与设备收件箱仍要求通过文件选择器寻找文件，交互不一致。
- **需求**：跨网络传输和设备收件箱都支持从 Finder 拖入单个或多个文件，并复用现有文件校验、数量/大小限制、配对后发送顺序、错误提示和取消机制。
- **一致性要求**：拖拽只是文件选择入口，不能绕过“先配对/选设备，再发送”的既有产品流程，也不能绕过套餐、大小、安全或沙箱权限限制。
- **验收**：分别验证拖入文件、多个文件、文件夹或不支持对象、重复拖入、取消、失效目标、跨网络中继与设备收件箱接收；键盘文件选择入口继续可用。

### M-2 传输性能与等待体验专项

> **2026-08-25 第一阶段已实施并进入验证。** 当前改动保持线协议不变，旧版与新版可共用；具体兼容边界、已采纳/拒绝/延期项和第二阶段剥离条件见 `docs/transfer-performance-compatibility.md`。本轮不提升最低 macOS 版本，也不删除旧路径。

- **现状**：各模块功能可用，但设备收件箱等路径的上传与接收等待明显，整体尚未达到“好用”的体验标准。
- **要求**：先建立端到端基线，再优化，避免只凭主观感受或只改某一端。至少拆分测量文件准备、加密/哈希、首字节等待、上传、服务端排队/存储、接收发现、下载、解密/落盘和完成确认。
- **覆盖模块**：局域网传输、跨网络传输、设备收件箱；分别覆盖小文本、小文件、多文件和大文件，以及局域网直连、跨网络中继等实际路径。
- **优化方向**：检查串行等待、重复读写/加密、分块与并发、进度刷新、后台轮询/推送、首字节延迟和失败重试；不得以降低完整性校验、端到端加密、接收确认或稳定性为代价。
- **体验验收**：除吞吐量外，同时验证选择后即时反馈、阶段化进度、速度/剩余时间准确性、接收方及时出现、取消响应和失败恢复。形成优化前后同设备同网络的可复现实测对比。

### M-3 设备收件箱「发送内容」在切换目的地后失效（1.3.8 阻断项）

> **状态：in progress（实现完成并本地验证，待 Codex 独立评审与验收）。2026-08-26。**
> 分支 `work/macos-1.3.8-drag-drop`，随 macOS 1.3.8 / build 26 交付。
> 未改动发布标识（1.3.8 / build 26）与最低系统版本（macOS 13.0）。

- **现象（用户报告）**：跨网络传输完成配对后切到设备收件箱，按对方设备的
  **发送内容**，点击无反应、设备页面打不开；取消该次跨网络配对后重试仍然无效；
  只有强制退出并重新启动才恢复。
- **根因（已在源码与运行时验证，与配对无关）**：「哪台设备的页面是打开的」曾有
  **两个权威答案**，而两者生命周期不同。
  - `InboxSendModel.selectedTargetID` 是 App 作用域的，除进程退出外不会消失。
  - `DeviceInboxSurface.selectedConversationID` 是该视图的 `@State`。
    `AppShellView` 的 detail 列以 `switch navigation.selection.macSurface` 分支渲染，
    切换侧边栏目的地会**销毁并重建**该视图，其 `@State` 归零；从菜单栏关闭再打开
    唯一窗口是同一类重建。
  - 打开页面的唯一入口是 `.onChange(of: deliveries.selectedTargetID)`，而
    `DeviceSendSection` 的**发送内容**只调用 `deliveries.selectTarget(candidate.id)`。
    重建之后本地镜像为 `nil`、模型仍指向该设备，于是这次写入**写进了同一个值**；
    等值写入不是变化，`onChange` 不触发，镜像保持 `nil`，按钮在本次启动的余下时间
    里恒为无效。强制退出清空了模型，这正是只有重启才恢复的原因。
  - 跨网络只是「离开又回到设备收件箱」这一动作的载体：它既不拥有也不参与设备
    收件箱的导航，取消配对自然无从修复。
- **修复（根因修复，非时序规避）**：
  - **唯一持久权威**：模型改为只存 `focusedPeerID`（`@Published`），
    `selectedTargetID` 与 `selectedCandidate` 由它**派生**
    （`candidates.first { $0.id == focusedPeerID && $0.isSendable }`）。
    界面每次渲染直接读模型，不再保留任何本地镜像，也不再依赖任何变化沿；
    打开一台**已经是焦点**的设备因此是幂等的，且照样渲染其页面。
  - **两道门、一个答案**：`focusPeer(_:)` 接受任意对端（含不可发送的已移除设备与
    早于鉴权归属的只读会话桶），`selectTarget(_:)` 保留「被封锁行不得成为选择」
    的既有拒绝规则；两者写同一个存储值。只读会话因此不再需要第二个答案。
  - **失效即失去构图能力，而非关闭页面**：设备被吊销、关闭接收或移出账号时，
    派生结果立即为 `nil`（撤除构图区），但 `focusedPeerID` 保留——用户仍在看那台
    设备，其本地历史仍真实可读；页面上是否还有内容可渲染由 `openPeer` 自行判断。
    `adopt(_:)` 因此不再需要「记得去清除」的那段代码，也就没有清除前的窗口。
  - **账号变更**是模型唯一主动关闭页面的地方：`isolateFromPreviousAccount` 与取消
    该账号工作在同一次同步事件里清空 `focusedPeerID`（放在视图里的版本在视图不在
    屏幕上时根本不会执行）。
  - **同族的视图复用生命周期问题一并解决**：宿主对 `DeviceConversationPage` 施加
    `.id(peer.id)`，以**结构身份**取代逐项清除清单。换设备即换视图，暂存批次、
    消息草稿、Copy 的「已复制」确认、两个删除确认以及未来新增的任何 `@State` 全部
    重置；同一设备的重绘（消息到达、设备列表刷新、传输推进）身份不变，用户正在写的
    内容不会被抹掉。页面自身的 `stagedFor` 替换守卫（M-1 第二个 Codex 发现的修复）
    **原样保留**，作为宿主忘记加身份时的兜底，两者各有守护断言，均不可被静默删除。
  - 保持 macOS 13 兼容（仅用 `onChange(of:perform:)`，无 macOS 14 API），
    无障碍标识符与既有可达性行为未改动。
- **证据**：
  - `swift test` 4401 通过 / 0 失败 / 1 项既有跳过（基线 4391，新增 10）。
  - 新增 `InboxNavigationAuthorityTests`（8 项）覆盖：重复打开同一设备、只读对端
    可打开且永不成为目标、被封锁行的两道门、吊销后撤除构图但保留页面、设备移出
    账号、重新可发送后重新可定址、账号切换关闭页面、返回清空唯一答案。
  - 新增 `InboxSurfaceGuardTests` 两项：无本地镜像/无变化沿/模型侧单一存储值，
    以及 `.id(peer.id)` 身份隔离与页面兜底守卫同时在位；并断言三个设备收件箱源文件
    **不出现** `TransferPresence` / `LinkWorkspaceModel` / `TransferModules` /
    `crossNetworkTransfer`——跨网络永远不得成为设备收件箱导航的闸门。
  - 新增 macOS UI 回归 `DeviceInboxUITests`（2 项，在真实 App 中运行并通过）：
    `testSendContentOpensTheDeviceSpaceAfterTheDestinationIsRebuilt` 打开设备页 →
    切到**带真实待配对会话**的跨网络目的地 → 切回 → 断言页面仍在 → 返回列表 →
    再次打开；`testTheOpenDeviceSpaceSurvivesClosingAndReopeningTheWindow` 走关闭
    窗口并从菜单栏重开这条同类生命周期路径。
  - 为此新增 UI 夹具 `--relayium-ui-testing-inbox-devices`（默认关闭，不影响任何既有
    验收路径）：`/api/devices` 增加 `Inbox` 子树，使 `dev_other` 成为真正可发送的候选，
    因此**发送内容**按钮首次进入自动化覆盖。其公钥是真实 X25519 公钥（固定标量乘基点），
    因为 `InboxTargetEligibility` 会跑中央同款 `ValidatePublicKey`（含低阶点拒绝）。
  - 变异验证（每一处均已证明会导致测试失败）：①还原镜像 + `onChange` 旧设计 →
    UI 回归在「切回设备收件箱」处失败，即用户报告的现象；②删除 `.id(peer.id)` →
    身份隔离守护失败；③`selectedCandidate` 不再重问 `isSendable` → 4 项行为测试失败；
    ④`focusPeer` 改为拒绝非候选对端 → 只读对端测试失败；⑤重新引入
    `.onChange(of: deliveries.selectedTargetID)` → 单一权威守护失败。
  - 既有设备页 UI 测试全部通过（历史+构图同页、删除确认、完成投递、完整登录态界面），
    证明 `.id` 未破坏 `Form` 的分节渲染。
  - 两个 Release 分发（`-scheme Relayium`、`-scheme RelayiumAppStore`）与
    `build-for-testing` 均构建成功。
- **证据边界（明确声明）**：UI 回归中的跨网络会话来自离线夹具（已铸码、等待对端），
  **不是**一次真实的端到端配对；本轮未在签名 Release 构建中做人工 QA。
  「真实配对完成后」这一条仍属人工验收项。
- **剩余人工 QA**：真实双机跨网络配对完成后切换到设备收件箱并发送；设备页打开状态下
  在对端关闭接收/吊销设备；切换账号；从菜单栏关闭并重开窗口；连续在多台设备页之间
  切换并确认草稿与已选文件不串台。
