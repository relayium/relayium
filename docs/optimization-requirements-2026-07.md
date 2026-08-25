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
> | P1-5 持久设备配对（UI 层） | ❌ **未做** | 代码里没有任何持久配对 / 信任设备的痕迹；报告指出它需基于密钥指纹做，不是照抄 PairDrop 的 room |
> | P2 A-1 信任背书区（MIT/无跟踪/GitHub/changelog） | ⏳ **基本完成** | `/releases/` 已上线（`1140ed55`）并进入页脚；**注意报告里的「MIT」已过时**——项目已改为开放内核：`server/`+`web/` AGPL-3.0、`apps/` Apache-2.0、`docs/` CC BY 4.0。首页尚无集中的"背书区"区块，链接分散在 FeatureStrip / 页脚 |
> | P2 A-2 独立 Use Cases / Compare / Docs 页 | ✅ | 12 篇 compare 文章 + `/compare/` 真 hub + `/how-to/` 真 hub（`5e4addaf`）；UseCases 卡片已可点 |
> | P2 B-3 中继策略统一叙事（降级链可视化） | ❌ **未做**（依赖 P1-2 之后的自动降级功能本身） |
> | P2 B-4 管理后台国际化 | ✅ **已完成**（2026-08-06 复核） | `server/account/admin_i18n.go`（24 KB）+ `admin_i18n_test.go`；`adminLangFrom()`、语言 Cookie、`POST /admin/lang`（`admin.go`），`Lang` 已贯穿每个模板结构体。提交 `0c9e30d4`…`bf8e527d`。有意保留中文的只剩切换器自身的「中文 / EN」（语言名以自身语言呈现）与 Go 注释 |

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

### P1-5 持久设备配对（UI 层）
- **现状**：服务端 `/api/devices` 设备注册表已存在，但 UI 层的「常用设备免重复确认」被显式推迟（`docs/superpowers/specs/2026-06-30-cross-device-my-files-DEFERRED.md`）。
- **需求**：不必等「我的文件」保险库方案，可先做轻量版：两台设备完成一次 SAS 验证后可互相「记住」，下次直接出现在附近列表，跳过校验码比对（密钥指纹固定，变更即警告，类似 SSH known_hosts）。
- **理由**：自己的 MacBook ↔ 手机反复传文件每次都要比对校验码，是留存杀手；PairDrop 的 Persistent Pairing 已验证需求。注意与已推迟的 my-files Mode 2 解耦，避免范围蔓延。

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
