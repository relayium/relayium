# 端到端测试

两个脚本，共用 `harness.mjs`（CDP 客户端、标签页把手、浏览器生命周期、另存为桩）。
共用而不是各抄一份：两份迟早会漂移，而漂移的那一份会安静地变成一个测不出东西的假绿。

- `lan-transfer.mjs` —— 默认产物的回归网，`npm run test:e2e`，**默认跑**。
- `mixed-link.mjs` —— 统一链路（`link/1`）的回归网，`npm run test:e2e:mixed`，
  **选择性**，需要一个专门的构建（见下）。

## `lan-transfer.mjs` — 两个真标签页之间的一次真传输

`npm run test:e2e`

跑之前要有两件东西：

```bash
# 1) 构建产物（服务器直接吐 web/dist，测的就是它——别拿旧 dist 测出一个假绿）
cd web && npm run build

# 2) 本地服务器（同时兜 SPA、/ws 信令和 /api/ice）
cd server && RELAYIUM_ADDR=:8099 go run .
```

然后 `cd web && npm run test:e2e`（换端口用 `node e2e/lan-transfer.mjs --url http://localhost:1234`；
调试时加 `--keep` 保留 Chrome 的临时 profile）。

### 它测的是什么

vitest 那 580 条测试**一行都覆盖不到实时传输管道**：收发两条管道原本长在 App.svelte
里、现在在 `transfer-session.svelte.ts` 里，两者都需要两个真实的浏览器上下文、一条真
WebSocket 信令和一个真 RTCPeerConnection 才跑得起来。这个脚本就是它们唯一的回归网：

1. **握手到落盘的全链路**：两个标签页进同一个 LAN 房间 → 互相发现 → 塞进一个 3MB 文件
   → commit-reveal → DataChannel → 分块 AES-GCM → 流控 ACK → 逐文件完整性校验 → 落盘。
   最后按 **SHA-256 比对收到的字节**，不是"看见进度条到 100% 就算过"。
2. **文件名出现在确认卡片上** —— 那是用户做信任决策的地方。
3. **两侧 SAS 一致**（中间人防护里用户看得见的那一半）。SAS 只在传输**进行中**显示，
   所以是从点下"接受"起后台采样的；采不到就算失败，而不是悄悄跳过。
4. **断线续传**：传输中途（第一 MB 落盘之后）把两端的连接同时判死，然后断言
   续传后的文件与发出的字节**逐字节一致**、总字节数正好等于文件大小（从 0 重来会超），
   且收方确实新建过至少两个 RTCPeerConnection —— 最后这条是防"掉线注入还没落地就传完了"
   的假绿。断线续传是这条链路上最复杂的一段（connectResume + checkpoint + chain hash
   恢复 + pausedRecv 状态机），也是手机上最常发生的事。
5. **建连途中失败要报得干净**：第二幕给收方注入一个"数据通道打开前就 failed"的
   RTCPeerConnection。这一窗口出过真 bug（掉线处理函数当时还在 TDZ 里，抛
   ReferenceError 而不是失败卡片），所以用例直接断言"没有 ReferenceError"。

### 只桩掉一样东西

`showSaveFilePicker`（操作系统的另存为对话框，无头浏览器开不出来）被换成一个把字节
攒进内存的假句柄。除此之外全是真的：真服务器、真信令、真 WebRTC、真加密。

### 已知的环境坑

- **必须关掉 mDNS 候选隐藏**（`--disable-features=WebRtcHideLocalIpsWithMdns`）。
  Chrome 默认把本机 IP 藏成 `.local` 候选，无头环境里没有解析器，两个标签页于是永远
  配不出可用候选对，ICE 直接 failed。
- **Go 服务器的 CSP 必须带 `'wasm-unsafe-eval'`**（`server/spa.go`）。libsodium 是
  WASM，缺这个 token 浏览器拒绝编译它，应用连信令都连不上。有 Go 单测钉着。
- 脚本启动时会先 `pkill` 掉上一轮残留的浏览器：它们的标签页还挂着 WebSocket，攒够
  几个就会撞上服务器的**每 IP 并发 /ws 上限**，新标签页静默连不上——那种失败看起来
  和真回归一模一样。两个脚本用不同的 `--remote-debugging-port`（9444 / 9445），
  所以谁也不会顺手打死对方的浏览器。

它还顺手钉住一条**默认产物**的规矩：名册层只通告 `text/1`，页面里一个统一工作区节点
都不挂。这条断言搭在消息那一幕上（那一幕本来就要等 caps 到达），不额外花时间。

---

## `mixed-link.mjs` — 一条真的统一链路（`link/1`）

`npm run test:e2e:mixed`

**这一套不在默认的 `npm run test:e2e` 里**，因为 `link/1` 还没被任何发行构建通告：
协调器、两条通道和恢复要一起做完才开这个口子。它需要一个专门开了那个能力的产物：

```bash
# 1) 带 link/1 的构建。产物是 web/dist-link-e2e，**故意不叫 dist/** ——
#    免得哪次部署顺手把一个半成品协议捡走。
cd web && npm run build:link-e2e

# 2) 指着那个产物起服务器（端口也和上面那套分开）
cd server && RELAYIUM_STATIC=../web/dist-link-e2e RELAYIUM_ADDR=:8098 go run .

# 3) 跑
cd web && npm run test:e2e:mixed
#   换端口：--url http://localhost:1234
#   留证据：--screenshots [目录]（默认 web/e2e-screenshots，已 gitignore）
#   调试：  --keep 保留 Chrome 的临时 profile
```

### 那个开关在哪，为什么它不是产品开关

只有一处：`peer-caps.svelte.ts` 里的 `VITE_RELAYIUM_LINK_E2E`。它是 **Vite 的构建期
替换**，默认产物直接折叠成 `false` —— 页面里没有任何查询参数、`localStorage` 项或全局
函数能把它打开，只有重新构建才行。`advertisedCaps()` 是名册通告和 SDP 确认的**同一个**
来源，所以两处不会各说各话。默认那一套的浏览器断言 + `peer-caps.test.ts` 一起钉着
"默认就是关的"。

脚本第一件事就是读页面**真正发出去的**名册通告，确认自己指着的是那个产物；不做这件事
的话，"拿错了 dist" 会伪装成"链路建不起来"——一条看起来像回归的假红。

### 它测的是什么

一条链路，两条通道，全程真东西：真 caps → 真 link 请求/应答 → 真 commit-reveal →
**一条** PeerConnection 上的两条 DataChannel → 两条通道各自的同意状态机。

1. **一条链路一个 SAS**。这是这套 UI 最核心的规矩，所以它是一个在每个阶段都复用的
   断言：数**整页**的 `.sas` 必须是 1 且在头部里，同时点名文件进度卡、请求卡和消息
   面板那三个历史渲染点必须是 0。路径徽标同理。两个标签页的六位码必须一致。
2. **手机上下一步就在第一屏**：390×844 下，40 个文件的同意卡和消息同意卡，SAS 与
   同意按钮都在视口内，没有横向溢出，也没有替用户聚焦任何"接受/发送"。
3. **粘性头部**：长清单滚到底之后，唯一那个 SAS 仍然钉在验证语境里（先断言页面确实
   可滚，否则这条检查什么也证明不了）。
4. **队列可见可取消**：传输中再选文件不会禁用文件控件，而是排成一条带取消按钮的队列。
5. **文件同意可以拒绝**，而链路活下来——拒绝一批文件不等于断开一条链路。
6. **消息同意可以接受**，正文**逐字节一致**（比 UTF-8 十六进制，含 tab、空行、CJK、
   阿拉伯语和星平面 emoji），而且全程仍然只有那一个 SAS。
7. **320px / RTL / 深色**：三种组合下头部不溢出、SAS 和断开按钮都在视口里、断开按钮
   镜像到行尾（证明用的是逻辑属性而不是写死的 left/right）、粘性头部有不透明背景。
   `--screenshots` 会把每一格存成 PNG，但每条几何规矩下面都有真断言钉着。
8. **显式断开收干净**：一次点击关掉两条通道，两个标签页的头部、队列和输入框都消失，
   对端也跟着收——然后那个对端重新可选。

最后和默认那一套一样：两页都不许有 console 错误。

---

## `a11y-scan.mjs` — 已构建产物的无障碍扫描

`npm run test:a11y`（CI 在 `npm run build` **之后**跑同一条命令）

```bash
cd web && npm run build && npm run test:a11y
#   另存机读结果：--json a11y-report.json（全量，永远不聚合）
#   只跑某几格：  --only pricing
#   展开 incomplete：--verbose-incomplete
#   打一个已经跑着的服务器：--url http://localhost:8099
```

不给 `--url` 时它自己起一个 `vite preview` 吐 `dist`，跑完收掉。不自己写 HTTP 服务器
是有意的：手写一份就得重现 nginx 的 `try_files` 规则，而那份复制品一定会和
`server/spa.go` 漂移，然后用一条测不准的路由给出一条测不准的结论。

### 为什么必须是真浏览器

SPA 壳的 `<body>` 里只有一个 `<noscript>`——真正的界面全靠 JS 挂上去。扫原始 HTML
等于在扫一段给爬虫看的备份文案，一条违规也发现不了却显示全绿。颜色对比度同理：它要的
是**计算后**的样式，不是源码里的变量名。

### 扫什么

14 格。静态那 7 格覆盖全部 6 种模板（landing / article / guides-index / legal /
mode / 404）：landing 的代表页本身是 RTL，article 再加一份 RTL 分支；mode 模板只有本地化
语言有静态页（英文走 SPA 路由），所以它那一格是 `/zh/cross-network/`。SPA 那 7 格覆盖首页
的桌面浅色与移动深色、cross-network / pricing / apps / cli，以及一个**动态决策态**（账户弹窗）。

每格都钉死视口、`prefers-color-scheme` 和 `prefers-reduced-motion`，等的是各自的
readySelector 而不是固定 sleep——固定 sleep 在快机器上浪费时间，在慢机器上给出一张
还没画完的页面，然后同一份代码今天绿明天红。

### 规则口径与允许清单

范围是 WCAG 2.0/2.1/2.2 的 A 与 AA，外加 10 条**逐条点名**的 best-practice 规则
（每条在 `a11y-core.mjs` 里都写了为什么要它）。按 tag 圈定范围不是压制违规，它是一条
写下来、可被复核的验收线。

`e2e/a11y-allowlist.json` 目前是**空的**，而且应当保持为空。每条记录必须精确到
「哪个目标、哪条规则、哪个节点」，外加理由、负责人和到期日。三种情况一律判红：
没被认领的违规、**这一轮什么都没匹配到**的陈旧条目、过期条目。通配符和多规则条目在
加载阶段就被拒掉——这张表只能用来记账，不能用来消音。

`incomplete`（axe 自己算不出来的那些，绝大多数是"背景是渐变，测不了对比度"）默认只按
目标/规则聚合计数，**从不判红**；要逐节点看用 `--verbose-incomplete`，`--json` 里永远
是全量。

### 真场景里的那几格（在上面两套 E2E 里）

静态扫描器没有对端也没有信令服务器，所以它永远到不了同意态、进行中的进度条和消息记录
——而那恰好是这个产品里最需要读屏的三个地方：用户正在那里做信任决策。所以
`scanLiveState()`（`a11y-core.mjs` 导出）被挂进了两套真 E2E：

- `lan-transfer.mjs`（默认套件）：文件同意卡（accept 之前）、传输进行中（`role="progressbar"`
  唯一活着的时候）、掉线续传完成后的终态、消息会话（`role="log"` + 输入框）。
- `mixed-link.mjs`（opt-in）：统一工作区头部、390px 下的 40 文件同意卡、文本通道同意后
  两条通道都活着的状态。

这一层**不读允许清单**，是有意的：真场景状态本来就少、本来就该干净，接上清单等于给它们
开一条可以静音的口子。有违规就抛，`incomplete` 只打印。

这几格不是摆设——它们上线当天就抓到了静态扫描看不见的四类真问题：进度条没有可访问名、
`<ol role="log">` 顶掉列表语义让 40 个 `<li>` 变成孤儿、消息面板把 `opacity` 叠在本来
就是次要色的 `--text` 上（掉到 3.3:1）、以及 40 文件同意清单滚得动却聚不上焦点。
