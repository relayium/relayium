# Relayium 教程与页面编排优化报告

> 审查范围：24 篇教程类文章（howto-* 11 篇、cli-* 6 篇、guides-* 7 篇）的中英文版本，逐条对照真实实现(`server/cmd/relayium/`、`server/internal/`、`web/src/`)核验；以及全站信息架构（分类、导航、hub 结构、页面编排、跨语言一致性）。
> 日期：2026-07-26
> 方法：所有可核验的事实性声明都与代码交叉验证，"事实基准"来自实现而非文档。

---

## 执行摘要

你的判断是对的，而且问题比"质量差"更具体：

1. **最严重的是准确性，不是文笔**——有 3 篇 CLI 教程的核心流程在当前服务端实现下**根本无法工作**（教程说"配对码自己随便定"，但服务器只接受账户铸造的注册码）;7 篇 how-to 教程把跨网传输路径描述反了（实际强制走 TURN 中继，教程写的是"优先直连")；还有无法运行的命令示例（`--ttl 7d` 会被 CLI 拒绝，示例码 `428571` 含非法字符 `1`)。
2. **中文版分两个质量梯队**——大部分读感自然，但有 4 篇是明显的机器翻译遗留（全篇半角标点），另有术语漂移（同一概念 3-4 种译法）和一处实打实的误译（"no code" 译成"无需代码"，指配对码被译成编程代码）。
3. **页面编排的核心问题是"平铺"**——文章尾部 36 条全网格相关链接、落地页尾部 37 条平铺列表、hub 页三面链接墙：精心设计的 CTA 之后立刻砸一堵链接墙，"下一步做什么"从单一明确动作退化成无差别检索。主导航零教程入口，从英文首页到任意一篇教程的唯一路径是"滚到底 → 页脚 Guides → 在 37 条列表里肉眼找"。
4. **分类轴不可言说**——没人能回答"为什么《同 Wi-Fi 传文件》是 how-to 而《从终端传文件》是 guide"；备份主题拆在两个分类、CLI 文章整体塞进 guides，组内顺序是 import 书写顺序，入门概念文排在最后。

---

## 第一部分：教程内容质量（中英文）

### 1.1 准确性问题（按严重度）

#### 🔴 高：CLI 配对码教程的核心流程不成立（3 篇受影响）

**代码事实**（基准）:`server/internal/signal/pair.go:124-166` + `main.go:271,316-343` —— 配对码是 6 位字母数字（字符集 `ACDEFHJKMNPRTWXY23456789`)、5 分钟 TTL、只能由登录账户通过 `/api/pair` 铸造；`/ws` 对非注册码直接 403。**CLI 没有铸码命令**。

| 文章 | 错误内容 |
|---|---|
| `cli-send-to-someone.mjs` | en *"Pick any short code and share it out band"* / FAQ *"You make it up. It's any short string both sides type."*;zh *"是你自己定的。任何一个双方都能输入的简短字符串都行"* —— 全流程建立在不成立的前提上；示例码 `428571` 含字符 `1`，连格式校验都过不了 |
| `cli-getting-started.mjs` | FAQ *"send/receive uses a code you agree on out of band. None of them require an account."* —— 铸码必须有账户 |
| `guides-receive-from-cli.mjs` | 重复"配对码双方商定"，同时又说 *"doesn't interoperate with the browser's pairing code or QR flow"* —— 合起来读者**没有任何办法获得一个有效码** |
| `guides-self-host.mjs` | 把同样的错误扩散到自建场景：*"The CLI is free and needs no account either way"* |

> 需要产品决策：要么改文档匹配实现（说明码从哪来：账户铸造、5 分钟有效），要么服务端放开临时码——如果设计意图是后者，那现在是**产品 bug 而非文档 bug**。这个分歧本身必须先在工程层面解决。

#### 🔴 高：跨网传输路径写反了（7 篇）

**代码事实**:`web/src/App.svelte:117-126` —— Web 端配对码房间**强制 `iceTransportPolicy: "relay"`**，为 ~1-2 秒建立连接而设计，不存在"优先直连、失败回落中继"。

受影响文章（同一错误句式）:`howto-send-files-between-computers`、`howto-android-to-iphone`、`howto-pc-to-phone-wirelessly`、`howto-mac-to-windows`、`howto-same-wifi`、`howto-airdrop-for-windows-android`、`howto-transfer-by-qr-code`（均写 *"goes directly peer-to-peer whenever possible, falls back to TURN relay"*)。

讽刺的是 `guides-what-is-p2p-file-transfer` 和 `howto-large-files-without-cloud` 写的是**正确**的（"across networks it uses the TURN relay by default")——语料库自相矛盾。另注意：CLI 端恰好相反，是**只直连、不中继**(`crossnet.go:22-24`)，教程需要把"浏览器跨网=中继、CLI 跨网=仅直连"讲清楚。

#### 🟡 中：配对码被误述为"六位数字码"

`howto-transfer-by-qr-code.mjs`:en *"Typing a six-digit code"*、*"mints a short numeric code"*;zh *"打六位数字码"*、*"短数字码"*。实际是 6 位**字母数字**码；六位数字的是 SAS 校验码，两个码被混为一谈。同站 `howto-send-files-between-computers` 写的 "6-character" 反而是对的——第三处自相矛盾。同篇还过度声称 *"creating a pairing code is the one place Relayium asks for an account"*（存储链接、CLI `up` 也要登录）。

#### 🟡 中：`--ttl 7d` 示例无法运行

`cli-cloud-async.mjs` 教 `relayium up ./report.pdf --ttl 7d`，但 `parseTTL`(`cloud.go:104-116`）用 `time.ParseDuration`，没有天单位 → 直接报错。正确写法 `--ttl 168h`。**根因是产品 bug**(`formatTTL` 输出的 `%dd` 格式 `parseTTL` 读不回来），应一并报给工程侧。

#### 🟢 低：零散失准

- 6+ 篇的 "Firefox/Safari ~200MB 内存缓冲" 规则已过时：实际告警阈值 256 MiB，且有 Service Worker 流式落盘路径，Firefox/Safari 单文件也能流式下载(`filesink.ts:98,114-120`)。
- `cli-sync-large-folder` 排障建议"排除 venv 等目录"，但 `sync` **没有 exclude 参数**——建议不可执行。
- **5 分钟码 TTL 没有任何一篇教程提到**——电话里念码很容易超时，这是每个配对教程都该有的信息。
- 批次上限：这 24 篇都写 1,000，与 `MAX_FILES = 1000` 一致（之前发现的 "10" 在别处，不在教程里）。

**✅ 已核验准确、可作为质量标杆的**：所有 `serve`/daemon 直连细节（端口 9031、TOFU、信任文件）、TTL 选项 1h–14d 与默认 1 天、登录铸码/匿名接收模型、zip 4GiB 上限、全部密码学声明（X25519、AES-256-GCM、commit-reveal)、节点指南的脚本/端口/界面文案。

### 1.2 完整性与精细度

24 篇结构完全统一（lead → sections → FAQ → CTA → related)，中英文结构逐项对齐（程序化验证）。但作为"教程"缺三样东西：

| 缺失 | 现状 |
|---|---|
| **编号步骤** | 所有 how-to 的"step by step"都是 bullet 列表，没有一篇用编号步骤，没有"你应该看到 X"检查点（仅 2 篇 CLI 文章除外） |
| **预期输出** | 仅 `cli-server-to-server`、`cli-sync-large-folder`、`guides-always-on-service` 展示终端输出样例；`cli-getting-started` 的"第一次传输"有命令无输出、无成功标志、无失败示例 |
| **排障章节** | 仅 `cli-sync-large-folder` 有真正的 Troubleshooting（最佳：`ss -tnp | grep 9031` 判 ESTAB/SYN-SENT);`howto-transfer-by-qr-code` 有"扫码失败";**其余 20 篇为零**——码过期、设备互不可见（VPN/CGNAT/不同子网，同 Wi-Fi 最常见的失败）、传输卡住、浏览器权限，一概没有 |

其他：前置条件章节 9 篇 how-to 缺失；每篇配对教程都说"发送方登录"但没有任何一篇解释怎么注册账户；iOS 接收后文件落在哪（Files? zip?）从未说明；全站教程无任何截图/视觉辅助。

**标杆文章**:`cli-sync-large-folder`、`cli-server-to-server`、`guides-always-on-service`、`guides-own-node`（编号步骤+验证+回滚/卸载）。**最弱**:`cli-send-to-someone`（前提崩塌）、`howto-send-a-folder`、`howto-large-files-without-cloud`（基本是营销文案+样板）。

### 1.3 中文版质量

结构完整度 100%，好的一半读感是母语级（如 `guides-own-node` 引用了真实中文界面文案"我的节点/添加节点")。问题集中在：

**a) 4 篇系统性机翻遗留——全篇半角标点**（实测半角逗号数：`guides-is-it-safe` 90、`howto-automate-server-backups` 56、`howto-share-file-expiring-link` 41、`cli-backup-server-ssh` 39；其余文章 0-4)。例：
- *"端到端加密的意思更进一步:文件在离开你的设备之前就已经加密,而这把密钥…"*（半角 `:` `,`)
- *"可选 1 小时、1 天、3 天、7 天、最长 14 天有效期（上限取决于套餐）,或首次下载后即焚"*（全角括号与半角逗号混用）

**b) 误译**:`cli-server-to-server` 中文描述 *"无需中继、无需 SSH、无需代码"* —— en "no code" 指无需**配对码**，被译成无需编程代码；同篇 lead 又正确写着"无需配对码"，自相矛盾。

**c) 术语漂移**（同一概念多种译法）:

| 英文概念 | 出现的译法 |
|---|---|
| daemon direct | 守护进程直连 / daemon direct（不译）/ daemon 直连 / daemon-direct |
| pairing code | 配对码（标准）/ **验证码**(`howto-same-wifi`，与 SAS 的"校验码"撞车） |
| burn after read | 首次下载后即焚 / 阅后即焚 / 即焚 |
| rendezvous | 会合握手 / 撮合 / 中转撮合 |
| updatedLabel | 最近更新 / 最后更新（仅 cli-cloud-async) |

**d) 代码块注释未翻译**:`cli-sync-large-folder` zh 里 `# on BOTH servers`、`# on the RECEIVER (foreground, to approve interactively)`;`cli-server-to-server`、`howto-automate-server-backups` 同样；而 `cli-cloud-async` 翻译了一半(`# 选择它能存活多久`）另一半没翻。

### 1.4 重复与漂移

两块样板在多篇间近乎逐字复制：跨网传输段落（7 篇，且都写错了，见 1.1)、浏览器限制段落（6 篇）。复制已产生实测漂移——**同一事实三种互斥说法**:
- 配对码格式："6-character" vs "six-digit numeric" vs "any short string you make up"
- 跨网路径："TURN by default"(2 篇） vs "direct first, fallback"(7 篇）
- 账户要求："None of them require an account" vs "sender signs in to mint a code"

修复必须连同去重一起做：每个事实只保留一份权威表述（shared snippet 或常量），否则改完还会再漂。

### 1.5 逐篇质量表

| 文章 | en | zh | 准确性问题 | 主要缺口 |
|---|---|---|---|---|
| cli-getting-started | 中 | 良 | "无需账户"错 | 无预期输出 |
| cli-send-to-someone | **差** | 良 | 核心流程不成立；示例码非法 | 整篇需重写 |
| cli-server-to-server | 良 | 良 | 一处误译（无需代码） | — |
| cli-backup-server-ssh | 中 | **差**（半角） | 无 | 无排障；恢复流程单薄 |
| cli-cloud-async | 良 | 中 | `--ttl 7d` 不可运行 | TTL 示例；1GiB 默认上限未提 |
| cli-sync-large-folder | **优** | 良 | "exclude venv" 不可执行 | — |
| cli-getting-started 外 guides-receive-from-cli | 中 | 良 | 码来源悖论 | 必须说明码从哪来 |
| guides-self-host | 良 | 良 | "无需账户"错 | — |
| guides-how-encryption-works | 良 | 良 | 全部核验通过 | — |
| guides-what-is-p2p | 良 | 良 | 正确（准确的异类） | — |
| guides-is-it-safe | 中 | **差**（半角最重） | 无实质问题 | zh 需全文编辑 |
| guides-own-node | 良 | 良 | 核验通过 | — |
| guides-always-on-service | 良 | 良 | 无 | zh 代码注释未译 |
| howto-transfer-by-qr-code | 中 | 良 | "六位数字码"错；TURN 错 | 无 5 分钟 TTL |
| howto-android-to-iphone | 中 | 良 | TURN 错；200MB 过时 | 无 iOS 落点说明；无排障 |
| howto-pc-to-phone-wirelessly | 中 | 良 | TURN 错；200MB 过时 | 样板重 |
| howto-large-files-without-cloud | 中 | 良 | 200MB 过时 | 偏营销，薄 |
| howto-share-file-expiring-link | 中 | **差**（半角） | TTL 值正确 | 命名与 UI 不一致 |
| howto-send-files-between-computers | 中 | 良 | FAQ TURN 错 | 样板重 |
| howto-airdrop-for-windows-android | 中 | 良 | TURN 错 | — |
| howto-mac-to-windows | 中 | 良 | TURN 错 | 重复块最多 |
| howto-same-wifi | 良 | 中（验证码误用） | 正确 | 无发现失败排障 |
| howto-send-a-folder | 中 | 良 | 4GiB 核验通过 | 最薄；无接收端演示 |
| howto-automate-server-backups | 良 | **差**（半角） | 核验通过 | 与 cli-backup-server-ssh 大面积重叠 |

---

## 第二部分：页面信息架构与编排

### 2.1 当前发现路径图（实测）

```
 /  (en 首页 = SPA 应用本体)
 Nav: lan · cross · offline · cli · apps   ← 零教程入口
   │                              │
   ▼                              ▼
 /cross-network /offline-transfer /cli(链 6 篇 CLI 指南)
 /apps (SPA)                        │
                                    ▼
        全站唯一教程入口:首页滚到底 → 页脚 Guides → /guides/(37 篇平铺 3 组)
                                    │
                    37 篇 × 9 语言；每篇尾部 36 条全互联 + 首页
                    /compare/ 与 /how-to/ 根目录 404；无面包屑
```

### 2.2 分类法问题

- **分类纯靠 slug 前缀**(`build-pages.mjs:55`)，无显式的受众/意图/难度元数据。`cli-*.mjs` 六个文件全落在 `guides/` URL 下——"cli"曾是第四类，被并入后从未清理。
- **三类异质内容混在 guides/**：操作教程（终端传文件）、概念科普（什么是 P2P)、运维自建（self-host、own-node)。
- **具体错配**：服务器备份主题拆在 `how-to/automate-server-backups` 和 `guides/back-up-a-server-over-ssh` 两处；`guides/receive-files-from-the-command-line` 是纯 how-to;CLI 跨网发送与两个浏览器 how-to 场景重叠却分散两组。
- **组内顺序 = import 书写顺序**：入门概念文（what-is-p2p、is-it-safe）排在全部教程之后，无 beginner→advanced 路径。
- **中文分类标签同义**:guides=「教程」、howTo=「操作指南」——用户无法区分，分组形同虚设。

**建议**：文章加显式元数据(`audience: browser|cli|selfhost`、`intent: concept|task|compare`、`order`)，按「场景任务 / 命令行 / 自建运维 / 概念与安全 / 对比」五类重组；zh 标签改为「场景教程 / 命令行 / 对比」等可区分词。

### 2.3 导航与可发现性

- **主导航零内容入口**(`Nav.svelte:10-16`);37 篇文章 SPA 内只链 8 篇，how-to 和 compare 两类应用内零入口。
- **非首页路由页脚断链**:`PageFooter.svelte:13-21` 没有 Guides 链接——在 /cli 读完 6 张卡片后想看其余 31 篇，无路可走。
- **UseCases 场景卡片不可点击**(`HomeSections.svelte`)——最天然的教程入口是纯文本。
- **"2 次点击找到 Android→iPhone 教程"测试：失败**（滚到底 + Guides + 37 条列表肉眼检索）。

### 2.4 页面编排逻辑

- **文章页**：单篇叙事（问题→前提→步骤→备选→FAQ→CTA）是各模板里最完整的，CTA 位置正确——但 CTA 卡之后立刻是 36 条全网格"相关文章"，下一步动作被摊薄，且每篇的相关推荐完全相同（对读者零信息量）。
- **落地页**：叙事主线合理，但 compare 区块与 12 篇 compare 文章零互链（内容重复造不导流）;**收尾无 CTA**——页面以 37 链接墙 + footer 结束，最后一个行动召唤在首屏。
- **hub 页**：三面平铺链接墙，无精选、无"第一次用？"路径引导、无最近更新标记。
- **/cli 是编排最好的产品页**（装→选模式→用→进阶→查），但与 `cli-getting-started` 文章内容大面积重叠、单向链接、无主从关系，两个"CLI 权威页"互相稀释。

### 2.5 Hub/Spoke 结构

- 全站只有一个 hub(`/guides/`);`/compare/`、`/how-to/` 根目录 404——URL 层级暗示三个分类，两个没有落地页。
- 无面包屑（文章回 hub 的唯一链接在 footer 最弱位置）。
- sitemap 权重倒挂：hub 0.5 < 文章 0.6。
- mode 页 learn 文章手工配置且几乎为空（cross-network、apps 一篇都没配）。

### 2.6 应用内 vs 站点、跨语言一致性

- **首页营销区顺序不合逻辑**:HowToSteps → crosscta（第二个区块就向上销售）→ FeatureStrip（为什么选我，排错位置）→ CliCallout → UseCases（最能代入的区块排倒数第二且不可点）→ Faq → footer（无收尾 CTA)。建议：HowToSteps → FeatureStrip → UseCases（可点）→ CliCallout → crosscta → Faq → 收尾 crosscta。
- **en 首页与其他语言首页是两种 IA**:SPA 首页（应用+营销混合）vs 静态落地页（纯营销）的区块集合、顺序、内容全不同。
- 9 语言的 hub/文章/模板结构对齐良好（`validateLangs` 强制）；但 en mode 页（SPA）与 zh mode 页（静态）内容分别维护，有漂移风险；`/pricing` 仅英文但全语言 footer 都链它且无提示。

---

## 优化行动清单（按优先级）

### P0 — 事实正确性（教程公信力的底线）

1. **解决 CLI 配对码分歧**：先在工程层面确认设计意图（注册码 vs 临时码），然后重写 `cli-send-to-someone` 并修正 `cli-getting-started`、`guides-receive-from-cli`、`guides-self-host`。
2. **统一跨网路径表述**：7 篇 how-to 改为与实现一致（浏览器跨网=强制中继；CLI 跨网=仅直连），同时把这条事实抽成单一权威来源。
3. 修 `--ttl 7d` → `168h`（并把 `formatTTL`/`parseTTL` 往返 bug 报工程）。
4. 修 `howto-transfer-by-qr-code` 的"六位数字码"→ 6 位字母数字；删掉 "the one place" 过度声称。
5. 每个配对教程补充：5 分钟 TTL、码从哪来（账户铸造）、码长什么样。

### P0 — 编排止血

6. **文章相关链接从 36 全网格改为 3-5 条策展**（按同组/同场景），让 CTA 重新成为唯一下一步。
7. **Nav 或全站页脚加"教程"入口**;UseCases 卡片链到对应 how-to；落地页 learn 区改"分组精选 6 篇 + 查看全部"并补收尾 CTA。

### P1 — 教程精细化

8. 统一教程模板：编号步骤 → 预期输出/成功标志 → 排障块（码过期、发现失败、传输卡住）→ 下一步；前置条件补齐 9 篇。
9. 事实去重：跨网段落、浏览器限制段落各保留一份权威 snippet，全站引用。

### P1 — 中文版提升

10. 4 篇半角标点文章全文编辑（guides-is-it-safe、howto-automate-server-backups、howto-share-file-expiring-link、cli-backup-server-ssh)。
11. 修"无需代码"误译；建立术语表（配对码/校验码/守护进程直连/阅后即焚/会合）并在构建期或 review 中强制；翻译 zh 代码块注释。

### P2 — 架构重组

12. 文章加显式元数据，五类重组 hub + 组内排序；合并/互链两个备份主题。
13. `/how-to/`、`/compare/` 根做成真 hub（或 301 到 `/guides/#分组`)；文章页加面包屑（+BreadcrumbList JSON-LD);sitemap hub priority ≥ 0.8。
14. 明确 /cli（参考+模式选择）与 cli-* 文章（任务教程）的主从关系，双向互链。
15. 对齐 en SPA 首页与其他语言落地页的区块契约；非英语 footer 的 /pricing 链接标注"English"。
