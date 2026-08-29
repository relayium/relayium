# 端到端测试

四个脚本，共用三份东西：

- `harness.mjs` —— CDP 客户端、标签页把手、浏览器生命周期、另存为桩、`vite preview`
  生命周期。
- `go-server.mjs` —— 一台真 Go 服务器的完整生命周期：先拒绝一个不成立的端口，再拒绝
  缺失/陈旧的 dist、拒绝接管别人占着的端口，然后构建、剥掉继承来的全部 `RELAYIUM_*`
  配置、按墙钟等就绪、有界地终止并收掉临时目录。`mixed-link.mjs` 和 `device-inbox.mjs`
  用它。
- `dom-contracts.mjs` —— 真浏览器运行器和普通 Vitest 单测**共用**的选择器。

共用而不是各抄一份：两份迟早会漂移，而漂移的那一份会安静地变成一个测不出东西的假绿。
`dom-contracts.mjs` 就是被这件事逼出来的——`QueuedBatches` 换成组合 `PendingFiles`
之后，`mixed-link.mjs` 手里那份 `.fname` 和裸 `li` 计数当场过时，而因为当时没有任何
托管道次跑它，几周之后才有人手工跑出来，报的还是一个 `undefined.includes` 的
TypeError。现在同一份选择器由每次推送都跑的 `QueuedBatches.test.ts` 对着真渲染的组件
钉着，DOM 一漂移，先红的是便宜的那条道次。

现在这个模块里有三组（2026-08-29 / Phase 3D C3b-1 加了后两组）：

| 常量 | 覆盖的界面 | 每次推送钉着它的用例 |
|---|---|---|
| `QUEUED` | 传输中再选文件排出来的队列卡 | `src/lib/QueuedBatches.test.ts` |
| `RECEIVE` | 收文件的同意卡（含 `ReceiveActions` 那一行两颗按钮） | `src/lib/ReceiveActions.test.ts` |
| `XFER` | 传输卡，以及它进行中才渲染的 `role="progressbar"` | `src/lib/workspace-orchestration.test.ts` |

`RECEIVE` 里有一条必须读的注意事项：大批次内存提示一起来，主按钮和幽灵按钮的**含义
互换**——`.btn-primary` 变成"拒绝"，唯一能往下走的是一个明确的"仍要接收"幽灵按钮。

所以那两颗按钮的常量按**呈现角色**命名（`RECEIVE.primary` / `RECEIVE.ghost`），不按
语义命名。早先它们叫 `accept` / `decline`，而那正是一个共享标识符**不能**做的事：在提示
分支里 `RECEIVE.accept` 就是拒绝键，于是这个名字会在每个读者的编辑器里、恰好在他判断
"这一下点得安不安全"的那一刻，写着与事实相反的话。`primary` / `ghost` 只说分支之外仍然
为真的那部分——哪颗是哪颗——把"它到底干什么"逼回到调用点去确定。

`mixed-link.mjs` 因此在它两次同意点击之前都先查 `RECEIVE.warning` 在不在，查到就当场
报错而不是改点另一颗；两个分支的真实语义都由 `ReceiveActions.test.ts` 对着真渲染的标记
双向钉住。

`XFER.progressBar` 的**不存在**同样是有意义的，而且两个方向的含义相反：它只在
`{#if !xf.done}` 里渲染，所以"卡片在、进度条不在"是 runner 证明批次进了终局的方式，
"卡片在、进度条也在"是 runner 证明传输真的在进行中的方式——后者是活场景无障碍扫描唯一
能断言到东西的时刻。

四套都跑**默认产物**（`npm run build`）。它们的区别不是构建，是**对端和房间**：

- `lan-transfer.mjs` —— 老对端在场时那条一次一模式的老路，`npm run test:e2e`。
  每个标签页都套了测试侧的降级过滤器（见下）。**⚠️ 截至 2026-08-29 这一套跑不到底**，
  原因和迁移方向见下面那一节；在迁移完成之前，它的尾巴一条信号都不产出。
- `page-shell.mjs` —— auth 落地页、`/apps`、`/pricing` 和不安全上下文单列兜底这四条
  **页面**契约（不是传输契约），`npm run test:e2e:page-shell`，**在 CI 里跑**。
  2026-08-29（Phase 3D C2）从 `lan-transfer.mjs` 搬出来单独成套，见下面专门一节。
- `mixed-link.mjs` —— 两个新版本浏览器在 LAN 房间里的统一链路（`link/1`），
  `npm run test:e2e:mixed`，**在 CI 里跑**（`.github/workflows/web.yml` 的
  `mixed-link-e2e` 作业，2026-08-29 / Phase 3D C3a 新加）。它**自己起服务器**：
  从 `./server` 构建一个真的，起在自己的端口、自己的临时库上，跑完全收掉。
  它仍然和 `test:e2e` 分开的作业跑，因为它要 Go 工具链和自己的端口。
- `code-room.mjs` —— 同一条统一链路，但在**配对码房间**里，
  `npm run test:e2e:code-room`，**在 CI 里跑**（`.github/workflows/web.yml` 的 test
  作业，紧跟 `npm run build` 和 a11y 扫描）。它不需要 Go 服务器：会合与 ICE 由一份
  受控夹具提供（见下）。

## CI 里真正跑的浏览器道次

`.github/workflows/web.yml` 一共起七条真浏览器道次，`test:e2e` **不在其中**：

| 道次 | 脚本 | 作业 |
|---|---|---|
| 已构建产物的无障碍扫描 | `test:a11y` | `test` |
| 页面外壳契约（auth 落地页、`/apps`、`/pricing`、不安全上下文布局） | `test:e2e:page-shell` | `test` |
| 配对码房间里的统一工作区 | `test:e2e:code-room` | `test` |
| 设备发现可发现性走查 | `test:device-discovery` | `test` |
| Device Inbox 入口走查 | `test:device-inbox-entry` | `test` |
| Device Inbox：浏览器 → 服务器 → CLI → 落盘 | `test:device-inbox` | `device-inbox-e2e` |
| LAN 房间里的统一 `link/1` 工作区（真 Go 服务器） | `test:e2e:mixed` | `mixed-link-e2e` |

最后一行是 2026-08-29（Phase 3D C3a）新加的，**已经并入 `main`**（`a703c56f`
"Test unified mixed-link path in hosted CI"）。**只剩 `lan-transfer.mjs` 还只在本地跑**
（而且跑不到底，见下）。

`test` 作业自己带**五**条浏览器道次（a11y 扫描、页面外壳、配对码房间、设备发现、
Device Inbox 入口），所以 `mixed-link` 才单开一个作业——它另外还要 Go 工具链。
`web.yml` 里 `mixed-link-e2e` 旁边的注释现在也写明 `test` 作业是这**五**条浏览器道次。

把 `mixed-link` 托管起来，先要修掉它托管不了的原因：它以前要求人先手工起一台服务器。
现在它自己起（`go-server.mjs`，和 `test:device-inbox` 共用的那套生命周期），所以它
不再依赖"有人记得起服务器"。

## 这套 harness 覆盖不到的两件事

写在最前面，因为"没有断言"和"断言过了"看起来太像：

- **只有 Chromium。** harness 说的是 CDP，起的是本机那个 Chrome/Chromium。
  Firefox 和 WebKit/Safari 在这里**一次都没跑过**，任何报告都不该说跑过。跨引擎会
  分叉的地方（`bufferedAmount` 的行为、DataChannel 的背压、移动端后台策略）只能靠
  真机手测，或者靠 vitest 里那些与引擎无关的状态机/协议用例——后者是有意保留的那一层。
- **没有真的配对码房间。** `/api/pair` 铸码要一个登录且验证过的账号，服务器的 ws
  路由又用 `pairReg.Validate` 卡住未铸出的码，所以这套 harness 进不去一个**真**的
  配对码房间。`code-room.mjs` 用一份受控夹具补上了它缺的那两样服务器职责（会合 +
  ICE 下发），页面本身仍然是原样的构建产物、跑原样的策略——但它证明的是**路由与
  界面**，不是服务器的准入。准入那一半仍然只有服务器端的 Go 用例覆盖。
- **没有 TURN，所以没有中继凭据到期。** 上面那份夹具下发的是**空**的 iceServers
  （否则 `chooseRtcConfig` 会强制 relay-only，而这台机器上没有 TURN 服务器，一个候选
  都收集不到）。中继链路的凭据有效期边界——提前告警、到点进入可信的终局态、绝不拿
  过期凭据去恢复——因此在浏览器里一次都没跑到，它钉在确定性用例上：
  `relay-deadline.test.ts` 和 `mixed-link-lifecycle.test.ts`。这不是懒：真浏览器没有
  办法按需让一份 TURN 凭据在中途过期，而"信令掉了但 DataChannel 还活着"同样只能用
  注入的时钟和手动触发的终局回调来构造。

## `lan-transfer.mjs` — 两个真标签页之间的一次真传输（降级路径）

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

### ⚠️ 现状：这一套跑不到底（2026-08-29）

先说结论，因为下面那份"它测的是什么"读起来像是这些断言每天都在跑，而它们**一条都
没在跑**。

`d175f863`（"Remove legacy Mac and Web transfer paths"，2026-08-27）把 `App.svelte`
里对端卡片上的老控件删了：包着隐藏 `.file-pick-input` 的 `.pa-files` 标签，以及它旁边
那条文件 / 文件夹 / 消息的三选一。现在一张对端卡片上只有**一个**控件
`.open-workspace`，而且只发给能路由 `link/1` 的对端；路由不了的对端拿到的是
`<p class="pa-unsupported">`——一句话，不是一个灰掉的按钮。

这个脚本的前提正好相反。`main()` 在开出第一个标签页之前调 `setDefaultInit(STRIP_LINK_CAP)`，
于是**每一个**标签页都以只通告 `text/1` 的老对端身份出现，然后各幕去驱动这种对端过去
才有的那条分叉。分叉没了，那些选择器指向的节点也就不再渲染。

于是今天这一套的实际情况是：

- **跑到了、而且过了——现在这个文件里一幕都没有了**。以前跑得过的那三幕
  （`authLandingScenario`、`appsHierarchyScenario`、`pricingHierarchyScenario`）连同
  `unsupportedLayoutScenario`（当前单列布局契约；它从来不依赖任何被删的东西，只是因为
  排序原因才轮不到它跑）一起，在 2026-08-29（Phase 3D C2）整体搬进了
  `web/e2e/page-shell.mjs`，细节见下面专门一节。
- **没有跑**：现在是**全部**，从 `mobileRelayFallbackScenario` 起——它现在是 `main()`
  的第一幕。它去驱动已删控件（`lan-transfer.mjs:1420` 取 `.file-pick-input`，现在拿到
  `null`），运行到这里就过不去了。主传输那一幕，以及它后面的 small-message-cap、
  transfer-boundary、early-failure、mobile-no-picker、desktop-picker-cancel、resume、
  四幕消息、multi-page-device、caps-suppressed，全都在这个点的下游，眼下一条信号都不
  产出。

所以下面第 1–5 条**描述的是这个脚本的设计意图，不是当前的覆盖**。它们全部位于尾巴里，
现在一条都没有执行。搬出去的那四幕不再是"设计意图"——它们是 `page-shell.mjs` 里
每次推送都在跑的真实覆盖。

### 真正丢掉的东西，比尾巴的长度小得多

这个脚本一度被称作实时管道"唯一的回归网"。那句话曾经成立，现在不成立了；继续那么说
会高估损失，也会把修复引向错误的方向。对着 `mixed-link.mjs` 和 `code-room.mjs` 做过一次
覆盖审计，结论是**大量重复**：握手到落盘、强制换 PeerConnection 后的逐字节续传、
一条链路一个 SAS、逐文件 SHA-256 完整性、同意状态机、活场景无障碍扫描、断开收尾——
这些那两套都在跑，跑在替代了老分叉的统一 `link/1` 界面上，而且 `code-room.mjs` 每次
推送都在托管 CI 里跑。

审计当初认定搁浅的有**八条**。其中六条已经改了状态，所以现在是**两条搁浅、三条已托管
迁移、一条本地已迁移待托管 CI、两条已退役**：

| # | 独有断言 | 状态 |
|---|---|---|
| 1 | 移动端一个 picker 都不开（手机上产品主动不开） | **本地已迁移，待托管 CI**（C3b-6） |
| 2 | 桌面端另存为对话框被取消 | **已托管迁移**（C3b-4，exact-main `daadc94a`） |
| 3 | SCTP 协商出来的单条消息上限边界（RFC 8841 默认值 64 KiB） | **已托管迁移**（C3b-5，exact-main `b08457d6`） |
| 4 | 应答竞态（发起方还在接管通道时，应答方已经接受） | **已退役**，见下 |
| 5 | 数据通道打开前 PeerConnection 就 `failed` | **已退役**，见下 |
| 6 | 传输进行中 `role="progressbar"` 的活场景无障碍 | **已托管迁移**（C3b-1，exact-main `129e4cd`） |
| 7 | 多页设备身份与焦点（一个浏览器的两页 + 第三台独立设备） | 搁浅 |
| 8 | 有界的中继池失败（池里发了凭据然后被丢掉） | 搁浅 |

**第 1 条的措辞在这里被更正，而这条更正很重要——退役 runner 比审计那句话强。** 审计
当年写的是"没有 `showSaveFilePicker`"，读起来像"一个没有这套 API 的浏览器"。
`lan-transfer.mjs` 的 `mobileNoPickerScenario` 布置的**不是**那个条件：在 exact-main 上，
它的 `WORKING_PICKERS`（第 317-329 行）装的是**能用**的 `showSaveFilePicker` 和**能用**的
`showDirectoryPicker`，两者返回的句柄 `createWritable()` 真的收字节、真的计数；它还伪造了
安卓 UA，然后断言 picker 调用数为零、经由句柄的字节数为零、并且文件只靠浏览器下载逐字节
到手。那本来就已经是产品**主动**的那条规则——`pickersAllowed()` 在手机上**即使两个 picker
都在、都能用**也拒绝走 File System Access 分支，而且同意卡在用户点下去之前就先把"会落到
下载目录"说出来。C3b-6 **是把这份证明搬过来**，不是替掉一条更弱的断言；这里任何一句都不
应被读成"老那一幕证明得更少"。

C3b-6 改变的是**这份证明落在哪里、以及仪表打得多紧**。它从那个没接进托管 CI、已经数周
没有执行过的本地 runner，迁到当前统一的托管 `link/1` 旅程上，于是这条规则被证明在产品真正
发布的那条管道上，而不是在被它替代的老 LAN 分叉上。在搬过来的核心之上，它新增：两条
picker 分支分开计数，而不是共用一个计数器——于是"走了目录 picker"的 run 不能冒充"保存
picker 从没打开过"；一次显式的运行时可用性探针，先各花一次再清零，而不是把"picker 能用"
留成桩的一条没人查的性质；`ReceiveActions.test.ts` 里一条按维护语言对真实渲染标记的文案
契约，垫在 runner 那条与语言无关的模式匹配后面；四个被替换的浏览器边界与 UA 按**同一性**
在一个不会抛的 `finally` 里还原；以及按文件名限定的终局卡片，让这次新的成功不能满足后面
某一幕的完成等待。审计那句措辞描述的"没有 API"的情形，以及 `filesink` 层同一条手机闸门，
仍然由 `src/lib/filesink.test.ts` 确定性覆盖；只有真浏览器才能补上的，是"活的管道端到端
确实遵守它"。它到底证明了什么、又没证明什么，见下。

**第 3 条写的是 SCTP，这不是抠字眼。** 这个产品里有两个互不相干的 64 KiB，点错名字就会
把修复引到错误的模块去。这一条是**传输层**的限制：按 RFC 8841 协商出来的
`a=max-message-size`，从 `RTCPeerConnection.sctp.maxMessageSize` 读，对端什么都不通告时
默认就是 65 536——所以一个 Android WebView 对端能把桌面发送方整个拽下来，文件流也因此
必须分片（`src/lib/wire-limit.ts` 的 `CONSERVATIVE_MAX_MESSAGE_BYTES`）。它**不是**
`TEXT_MAX_BYTES`，那是产品自己给单条消息定的 64 KiB 上限（`src/lib/text-wire.ts`），
存在的意义是"再大就算文件"，而不是把用户当成一整块的东西悄悄切开。两者在边界上连数值都
对不上：64 KiB 明文封出来是 65 557 字节的帧，塞不进一条协商成 65 536 的通道。
`lan-transfer.mjs` 的 `smallMessageCapScenario` 独有的是传输那一半——它改写 SDP，在真
Chromium 上强制协商出 64 KiB，然后证明旧的 192 KiB 分块帧会被拒、装得下的那个会被收。
分片本身的算术已经有确定性用例（`src/lib/transfer-fragmentation.test.ts`）；C3b-5 已把原先
搁浅的协商搬进现有真 Chromium mixed 旅程，并已在 exact-main `b08457d6` 托管通过，细节见下。

**第 4 条是退役，不是迁移，证据如下（精确到用例名）。** `messageDefaultRaceScenario`
把那次线上故障强制复现：A 的 `getStats()` 路径采样被挂住时，B 自动接受并立刻发出第一条
消息，两个帧都落在"通道已开、A 的 lane 还没挂上处理器"的窗口里。这个窗口现在在结构上
已经关掉了——传输层会把挂上之前到达的帧捕获下来，挂上之后再按序回放——而且这件事由每次
推送都在 `npm test` 里跑的确定性用例钉着：

- `src/lib/mixed-session.test.ts` —— "replays a text request captured before lane
  attachment"（REQUEST 在 `attach` 之前到达，回放后状态是 `incomingRequest`）、
  "fails quickly instead of replaying into a declined lane capture sink"、
  "re-attaches both lanes to a replaced transport before replaying its capture"
  （换传输时两条 lane 都先接管，才回放第一个被捕获的帧）。
- `src/lib/peer-link.test.ts` —— "holds an inbound offer and replays the frames
  that chased it, in order"，以及那条断言 `{ file: [1, 2], text: [9] }` 按序落到替换
  通道上、且同一帧不会被回放两次进 codec 的用例。

**顺序**就是这条规矩的全部内容，而上面这些用例直接断言顺序。

**第 5 条同样按可执行证据退役，不算迁移。** 老浏览器场景强制在已删除的接收构造入口里
同步触发 `onconnectionstatechange("failed")`；它独有的回归是尚未初始化的 callback 被读取
而抛 TDZ `ReferenceError`，不是某种浏览器专属 ICE 行为。统一实现现在有两层每次
`npm test` 都跑的确定性证据：`src/lib/peer-link.test.ts` 在 transport promise 返回前同步
触发终局 callback，证明 manager 干净失败且没有 current link；`src/lib/webrtc.test.ts` 则让
初始 `connectLink` 在两条 DataChannel 都未打开时进入 `failed`，直接证明具名拒绝、调用方收到
状态、PeerConnection 关闭，而且迟到的 open 事件不能把已经拒绝的建立过程翻成成功。旧接收
构造器和控件都已不存在，再搬它那个人工浏览器 hook 不会增加当前路径事实。

理由的另一半在于那一幕的**手法**，而这一半才是"退役"而非"缓办"的依据。它不是去等那次
竞态，是**造**出来的：把 `RTCPeerConnection.prototype.getStats` 换成一个由用例手动放行的
promise。这招当年管用，是因为路径采样正好卡在"通道已开"和"lane 已挂上"之间。现在不是了。
`src/lib/mixed-session.svelte.ts` 的 `onLinkChange` 里，发布链路（`publishedLink = link`）、
两条 lane 都挂上（`file.attach(link)`、`text.attach(link)`，紧跟着一句"任一通道没有
`onmessage` 就抛"）、把捕获到的帧全部回放——这些**全是同步的**——之后才调用
`observePath(link)`，而它只是把 `conn.path()` 采样发出去就返回，并不等它。`conn.path()`
就是 `pc.getStats().then(classifyPath)`（`src/lib/webrtc-core.ts`），所以现在挂住
`getStats`，挂住的是一个早已被它本该领先的那次挂载超过去的诊断调用。注入点还在，它背后
那个窗口没了。

把话说准：统一工作区**是可以**为这条写一幕的。`link/1` 没有任何东西挡着，也**不**需要
把删掉的对端卡片消息控件加回来。没了的是那根**杠杆**——再没有一个能按需撑开这个间隙的
钩子，于是迁过来的那一幕只能去赌计时，而当年那次 `getStats` 挂起正是为了不赌计时才写的。
加上上面那些每次推送都跑、且直接断言这条性质的确定性用例，所以这是退役，不是丢失。

剩下这六条才是真实的回归暴露面，也正是下面的迁移必须搬过去的东西。尾巴里的其余部分可以
**退役而不是移植**——已经有托管套件在断言它们了。

### 迁移方向（分阶段）

修法**不是**把删掉的控件加回来，也不是加一个只有测试能打开的降级开关去重新渲染它们。
那条分叉是被有意从产品里拿掉的；一条只有测试走得到的回头路，断言的是任何用户都到不了的
行为，比什么都不断言更糟。

分四阶段，顺序是刻意的：任何一刻的覆盖都不低于今天。每一阶段落地并绿了，才开始下一阶段。

**阶段一：新起一套托管的页面外壳套件——已完成，2026-08-29（Phase 3D C2）。** 以前
能过的那三幕考的是页面契约，不是传输契约，本来就不该长在一套传输套件里。它们连同
`unsupportedLayoutScenario`（当前单列布局契约，同样不依赖任何被删控件，只是排序上轮
不到）一起搬进了 `web/e2e/page-shell.mjs`：一套只对 `vite preview`、不接真 Go 服务器
的新套件，`/api/plans` 由 a11y 扫描已经在用的那份进程内夹具同源应答。已加进
`.github/workflows/web.yml`（`test:e2e:page-shell`）。`page-shell-contract.test.mjs`
守着这个 runner 本身不会悄悄漏掉一幕：钉的是一个写死的 `EXPECTED_SCENARIO_COUNT`
（不是拿数组自己会跟着缩水的 `.length` 去比），并且钉住新 CI 步骤没有 `if:` 或
`continue-on-error`。光这一步就把 `/apps` 层级契约从"只在本地"变成托管——这是它第一次
由"有人记得跑"以外的东西来保证。

**阶段二：传输类独有断言并入 `mixed-link.mjs`，并把 `mixed-link` 托管起来。**
上表第 1–6 条考的是真管道（commit-reveal、分块 AES-GCM、ACK 流控、checkpoint 续传、
同意），不是那条退休的分叉。它们从 `STRIP_LINK_CAP` 上摘下来，改走统一 `link/1` 工作区：
`.open-workspace`，然后是工作区自带的草稿框和 `.attach-file` / `.attach-folder`。
`mixed-link.mjs` 驱动的就是这套界面。把独有断言搬进一套没人跑的套件是挪问题，不是解决
问题，所以"把 `mixed-link` 托管起来"先做，而且**已经并入 `main`**（C3a，2026-08-29，
`a703c56f`）：`mixed-link-e2e` 作业每次推送和 PR 都跑它现有的那一幕。把剩下的搬过去
是 C3b，它的起点因此是一条绿的、托管着的基线，而不是一套自己的排队断言已经陈旧了好几周
的套件。

**C3b-1 —— 活进度条，只做文件那条通道。** C3b 的第一刀只搬**第 6 条，别的一条都不动**。
它在每个值得记录的意义上都是一条"只涉及文件"的条目：

- *搬了什么*：活的 `role="progressbar"` 断言，进到 `mixed-link.mjs` 现有那一幕 5 MiB
  续传里，成为新的 `live-progressbar` act。它跑在唯一存在"传输进行中"这个状态的窗口里
  ——接收方已经落了两个 durable chunk 之后、强制掐断两条 PeerConnection **之前**。
  先证明主体确实在（每个方向一条进度条、`role="progressbar"`、`aria-labelledby` 指到卡片
  自己那个标题 id `xfer-label-{send,recv}`、`0 ≤ aria-valuenow ≤ 100`、卡片还没进终局），
  然后才用 `scanLiveState` 以 `XFER.card` 为 context 扫。一个 context 什么都没匹配到的
  `axe.run` 报的是零违规——所以少了这一步存在性证明，这一 act 会永远打印"axe clean"。
- *这个窗口是怎么撑开的，以及它什么时候合上*：接收侧桩 sink 每写一个 192 KiB 分块要
  睡一觉，而这个睡眠现在有**两个**值，因为这一幕里有两件预算差一个数量级的活。
  `SCAN_WRITE_DELAY_MS`（1000ms）只服务上面这一 act：等到两个分块之后还剩约 25 次写，
  按旧的 20ms 只给出约 500ms——够那一次强制掐断（一个 CDP 往返），远不够在两个标签页上
  注入并跑完 axe，传输会先跑完，这一 act 就会以"卡片已进终局"失败，而不是给出一个无障碍
  结论。**扫完立刻**换回 `RESUME_WRITE_DELAY_MS`（20ms，也就是这一 act 出现之前这一幕
  一直在跑的那个值），换回的位置刻意排在读 PeerConnection 计数和强制掐断**之前**：剩下
  约 25 次写按 1000ms 睡就是纯粹的墙钟时间，谁也没有因此更安全。第一版把 1000ms 一路留到
  底，把这一幕从约 10 秒拖成了约 31 秒——一次绿跑里完全看不出来的回归，所以换回的**顺序**
  由 `go-server.test.mjs` 钉着，不是靠一行注释。换回那一步还顺手断言传输此刻确实还活着：
  要是哪天两次 axe 真的跑到把文件跑完，下面每一条等待都会以别的名义超时，而这一幕会悄悄
  退化成一次没被打断的普通传输。
- *C3b-1 当时没搬什么*：第 1、2、3、5 条都没被那一刀改动，但这四条后来都改了状态——
  第 5 条按上面的确定性证据退役，第 2 条在 C3b-4、第 3 条在 C3b-5、第 1 条在 C3b-6 搬走，
  所以只剩第 7、8 两条，都归阶段三。逐字节续传和
  "真的换了 PeerConnection"那两组断言原样保留——这一 act 是**插进**那一幕的，不是替掉它
  的任何一部分。
- *这次改动碰了哪些文件*：只有测试和文档——`web/e2e/mixed-link.mjs`、
  `web/e2e/dom-contracts.mjs`、`web/e2e/go-server.test.mjs`、
  `web/src/lib/ReceiveActions.test.ts`、`web/src/lib/workspace-orchestration.test.ts`、
  本文件和 `docs/TESTING.md`。产品源码、workflow、依赖、原生和 ops 一个都没动。
- *顺手加的反空转机制*：一幕不等于一条断言。`mixed-link.mjs` 当时加了一份**冻结的逐 act
  执行台账**——C3b-1 是十七个具名 act，C3b-4 加入第十八个，C3b-5 加入第十九个，C3b-6
  加入第二十个；成员、顺序和一个**字面量**计数（`EXPECTED_ACT_COUNT`，
  绝不是 `ACTS.length`）三样都查——外加一个字面量 `EXPECTED_SCENARIO_COUNT`。否则一个被
  改到只剩第一条断言的 run 照样会报 `1/1`。`e2e/go-server.test.mjs` 钉住这个形状，也钉住
  那次活扫描确实落在"接受"和"强制掐断"之间。
- *共享选择器*：同意卡和传输卡现在和 `QUEUED` 一样，只在 `e2e/dom-contracts.mjs` 里写一遍
  （`RECEIVE`、`XFER`），由 `ReceiveActions.test.ts` 对着真渲染出来的标记、
  `workspace-orchestration.test.ts` 对着 `App.svelte` 真实的分支结构各钉一遍——这两条每次
  推送都跑，浏览器道次不是。`RECEIVE` 还记下了那张卡片唯一的坑：大批次内存提示一起来，
  两颗按钮的含义**互换**，`.btn-primary` 变成"拒绝"——所以它们按呈现角色叫
  `primary` / `ghost`，不叫 `accept` / `decline`，runner 也在它两次同意点击之前都先查
  这个提示在不在。

**验证状态：本地已跑绿，并已在 exact-main `129e4cd` 托管跑绿。** 2026-08-30 由作者在本地 macOS
worktree 上记录，服务器是这套用例自起的 Go 服务器（`127.0.0.1:8124`），浏览器是无头
Chrome：

| 命令 | 结果 |
|---|---|
| `npm run check` | 548 个文件，**0 错误 0 警告**，0 个有问题的文件 |
| `npx vitest run`（全量） | **4370 通过**，3 跳过，0 失败（233 个文件） |
| `npx vitest run`（这一刀碰的四个文件） | **176 通过**——`e2e/go-server.test.mjs` 79 条，`ReceiveActions` / `workspace-orchestration` / `QueuedBatches` 合计 97 条 |
| `npm run build` | 成功；写出 12 个按路由的 SPA 外壳 |
| `npm run test:e2e:mixed` | **17/17 act 按序执行**，连跑五次——12.05s、11.24s、12.41s、13.01s、12.69s（换回节流之前是约 31s） |

之前记为"没跑过"的那次对抗性变异现在跑过了，而且跑的正是要紧的那一个：把 `XFER.bar`
指向一个不存在的类名——也就是"进度条在传输中不再渲染"的形状——真浏览器那一跑**在这一
act 上**红，报的是

> no in-flight progress bar in the send card on tab A: the transfer is already
> terminal, or the bar left its `{#if !xf.done}` branch. Either way this act has
> no live subject left to scan.

而不是一句空洞的"axe clean"。另外三个便宜的源码变异也照样跑了，每一个都被一条指着自己
原因的消息抓住：删掉那次节流换回（"nothing restores the throttle after the scan"）、
把 `RECEIVE.primary` 改回 `accept`（`go-server.test.mjs` 与 `ReceiveActions.test.ts`
一共红四条）、把 `web.yml` 的道次数改回"四"（"the mixed-link job's stated reason names
the wrong lane count"）。

有一个数值值得留下来，因为它正是"换回节流"而不是"调低 `SCAN_WRITE_DELAY_MS`"的依据：
五次跑到换回那一刻，接收方写下的字节数都恰好是 **393,216 / 5,242,953**，也就是它起步时
那两个 durable chunk 一个没多。两次 axe 都塞进了**第一次** 1000ms 睡眠里，所以留给强制
掐断的跑道仍是完整的约 25 次写 × 20ms ≈ 500ms——正是这一幕原本就验过的预算。

之后 exact-main `129e4cd` 的 `mixed-link-e2e` 已通过，所以第 6 条现在是已托管迁移，不再只是
本地跑绿。

**C3b-2 没有迁移另一条 `lan-transfer.mjs` 独有断言。** U1 钉的是仅发起方、只发一次、
同一 PeerConnection 上的 ICE restart；U3a 钉的是 stored receive 共用的空保存参数。二者是
相邻的确定性韧性补强；它们当时没有改变第 2、3 条。第 2 条后来由 C3b-4 搬走，第 3 条由
C3b-5 搬走。

**C3b-4 —— 桌面 picker 取消，复用现有托管旅程。** 第 2 条现在插进原有 5 MiB 传输，
没有另起第二套浏览器场景，也没有再发一份大文件。接收侧先包一层已有保存桩，让第一次调用
抛真正的、名字为 `AbortError` 的 `DOMException`；runner 随即证明：只有一个带非空
`role="status"` 文案的 retry hint，没有写入字节、没有打开 sink、没有新增终局失败，短暂等待
后 picker 仍只调用一次，request 标题和清单没换，link、SAS、composer、附件控件也都还活着。
只有第二次明确 click 才能把 picker 计数推进到二并开始 durable writes；后面原封不动的
progressbar / resume 尾巴继续证明最终名称、大小、逐字节内容和替换 PeerConnection。

`.savehint.retry` 只写在 `e2e/dom-contracts.mjs`，普通 Vitest 用渲染出来的
`ReceiveActions` 钉住它；`e2e/go-server.test.mjs` 则独立冻结第十八个 act、它必须在
progress/resume 之前、真实 AbortError 注入、第一次/第二次 picker 计数、非终局同一 consent
证据和后续精确字节证据。产品源码和节流常量都没改。

这次被分类的取消会刻意打一条 console error。runner 在第一次 click 前同时记下两页 error
数组长度，证明 retry 状态后只消费接收页窗口内**恰好一条**完整匹配固定产品前缀、
`SaveCancelledError` 和 `showSaveFilePicker` 来源的记录。重复、异名、异来源、出现在发送页，
或同一句落在窗口之外，都继续留给未放宽的最终 console sweep 判红；没有全局忽略 picker
错误的正则。

之后 exact-main `daadc94a` 的 `mixed-link-e2e` 已通过，所以第 2 条现在是已托管覆盖，不再是
本地迁移待 CI。

旧脚本的 `NotAllowedError` 第二幕没有搬进 Chromium。它本来就是旧 runner 人工抛的异常，
并不证明真实浏览器权限弹窗；对应产品规则已有直接确定性证据：`src/lib/filesink.test.ts`
区分 `AbortError` 与非取消失败，`src/lib/mixed-file-session.test.ts` 证明非取消的保存失败会拒绝
传输、不会冒充用户取消。这半按上述精确测试退役；本次迁移不声称覆盖真实浏览器权限拒绝。

**C3b-5 —— 对端不通告 SCTP 上限时的 RFC 8841 边界，复用同一条 mixed 旅程。** 两个现有
标签页都在 `setRemoteDescription` 入口删除非零 `a=max-message-size` 行，让真 Chromium 自己
得出默认值，而不是给应用塞一个 mock 数。旅程先在接收页跑一个很小的真 DataChannel probe：
证明删掉了一条真实的非零通告，`pc.sctp.maxMessageSize` 精确等于 65,536，65,536 字节发送后通道
仍开着，而 65,537 字节不能保持为一次成功且仍开的发送。随后明确核对并清空 probe 的两个
PeerConnection 和删除计数，再打开产品链路，避免 probe 冒充产品或 replacement 证据。

产品旅程接着独立证明两页最初各自唯一的产品 PC 都是 65,536；原有 5 MiB 精确字节、强制
断线、续传和 replacement 尾巴全部在这个上限下照跑。结束时两页都读取**未过滤**的全部
tracked PC 上限数组，数组长度必须等于 PC 数，而且每一项都必须是 65,536；null/关闭状态
不能被藏掉。这里完全不碰 `TEXT_MAX_BYTES`——它是明文产品上限，不是 SCTP 传输上限。旧
runner 的 262,144→65,536 动态分片算术仍由 `transfer-fragmentation.test.ts` 直接覆盖；本次
浏览器迁移证明的是缺省协商和受限 replacement 旅程，没有增加第二套 runtime。

**当前状态：本地跑绿，且已在 exact-main `b08457d6` 托管通过。** 作者本地记录为：focused
四文件 Vitest 194/194、`svelte-check` / TypeScript 0 错误 0 警告、production build 成功、真
Chromium 自起服务旅程 19/19 act 按序通过。之后 exact-main `b08457d6` 的 `mixed-link-e2e`
已通过，所以第 3 条现在是已托管覆盖，不再是本地迁移待 CI。

**C3b-6 —— 手机上一个 picker 都不开，复用同一条 mixed 旅程。** 第 1 条现在作为台账里的
第二十个 act 落在同一条 `link/1` 上，位置在"正文逐字节一致"和桌面 picker 那一幕之间——按
执行顺序是第十三幕，后面还有七幕。针对一个
96 KiB 确定性文件，接收页先用 `Emulation.setUserAgentOverride` 换上安卓 UA 和 platform，
然后一次替掉四个浏览器边界：`showSaveFilePicker`、`showDirectoryPicker`、
`URL.createObjectURL` 和 `HTMLAnchorElement.prototype.click`。

**为它装上的两个 picker 是真能用的，这就是整个反空转论证。** 它们返回的句柄，
`createWritable()` 真的收字节、真的计数；而且这一幕在依赖"它们没被调用"之前，**先在运行时
证明**它们能用——各调一次、恰好吞下 8 字节——再把计数清零，让这次证明不可能被误算成产品
开了 picker。"picker 调用数为零"这句话，架在一个会抛异常的桩上说的是桩；架在一个本来会
成功并把文件吃掉的桩上，才是"产品**事先**决定不开"的唯一证据。两条 picker 分支分开计数，
因为产品本来就有两条（扁平单文件 vs. 其余），合成一个计数器会让"走了目录 picker"的 run
冒充"保存 picker 从没打开过"。这一条源码契约替不了：没人调用的函数，函数体是观察不到的。

UA 必须**赶在批次发出之前**落地，因为 `ReceiveActions` 只在同意卡挂载那一刻解析一次保存
提示。点"接受"之前，runner 用共享的 `.savehint` 选择器读卡片，要求恰好一条提示、不是 retry
那一版、没有内存提示，而且文案**双向**成立：必须承诺下载目录，且必须不是桌面分支那句
"选择保存位置"——按本次 run 启动时所处的那个维护语言判断，所以"只靠缺失来断言"的提示不会
在空文本上蒙混过关。点击之后，两个 picker 计数和句柄自己的字节计数必须仍然精确为零；必须
恰好捕获到一次下载，名字、声明长度和字节模式逐项精确；它那张按文件名唯一限定的传输卡必须
成功、卡内没有在途进度条、状态里没有任何"取消"字样；同一条 link、SAS、草稿框、附件控件和
空的请求队列都必须还在。载荷公式只写一遍，同时插进发送页和校验页——写两份会让"逐字节精确"
退化成"这个文件和它自己一致"。字节是从捕获到的 `Blob` 上读的，不是 fetch `blob:`：生产
CSP 的 `connect-src` 不允许 `blob:`，fetch 会红在桩上而不是红在产品上。

**因为这一幕在前面多了一次成功传输，续传那一幕的终局等待必须改。** 它原来等的是页面上
任意一个 `.xfer.ok`；现在手机那次下载会立刻满足它，于是一次根本没续上的续传会径直穿过去，
后面每一条断言描述的都是另一次传输。两处现在都按"单文件计数器正好写着这个文件名"的卡片
限定；而一张不再渲染那个计数器的卡片会**抛错**，不是被过滤掉——否则改名字会把每一条按名
限定的检查悄悄降级成 `length === 0`，也就是一条只会超时、还栽赃给产品的等待。

还原按**同一性**，不是按形状：紧随其后的桌面取消那一幕会捕获 `window.showSaveFilePicker`
并透传调用它，所以"装着一个 picker"不是要保的性质。`finally` 会还原四个函数以及原来的 UA
和 platform，把临时全局连同它钉住的 `Blob` 和 object URL 一起丢掉，并且**刻意不会抛**。
一个会抛的 `finally` 会**顶掉**把它送到这里的那个异常：如果失败发生在装桩之前，跑出来的报错
会是"全局不存在"，真正的诊断一个字都不会打印；而且第一个故障还会跳过后面的 UA 还原，把一台
手机交给桌面的那几幕。所以两半各自 catch、两半永远都跑，清理故障只在块**之后**重新抛出——
那时它只可能是全部真相。后面那一幕原封不动地证明自己的两次 picker 调用仍然发生，这就是
"还原是真的"的下游证据。

**要说准这到底是什么。** 这是桌面 Chromium 套了一个伪造的安卓 UA，加上浏览器边界桩。它
**不是**真安卓设备、不是真系统 picker、也不是真安卓下载管理器；runner 和
`go-server.test.mjs` 都不许把它说成那样——有一条契约会在它们开始那么说时判红。产品规则背后
那两桩真实故障（自带浏览器的 picker 弹不出可用界面；Chrome 文件夹页上一次误触返回键取消
整次接收）在这里**没有**被复现。被证明的是产品自己在统一管道上的主动策略：
`pickersAllowed()` 事先拒掉这条分支、卡片提前说明、文件仍然只靠浏览器下载逐字节到手。
产品源码、workflow、依赖包和节流常量一个都没动；这次改动只有
`web/e2e/mixed-link.mjs`、`web/e2e/go-server.test.mjs`、
`web/src/lib/ReceiveActions.test.ts`、本文件和 `docs/TESTING.md`。

浏览器查不了的那一半交给普通 Vitest 道次。浏览器那一幕匹配的是"承诺下载目录"的模式而不是
字面字符串，因为它跑在本次 run 启动时的那个维护语言里；而这个配对只有在两句话确实不同、
且"下载"那句确实说了下载目录时才有意义。`ReceiveActions.test.ts` 就对着真渲染出来的标记
钉住这一点，**英文和简体中文各一遍**，每次推送都跑——而且是**从一开始就挂在**对应语言下
渲染的：`lang()` 在渲染时读一次，挂完再切语言证明不了 `zh` 用户看到的是什么。

**当前状态：本地对着当前这份字节跑绿，等待 main 的托管 `mixed-link-e2e`。** 在那次
exact hosted 通过前，第 1 条只能记作本地迁移，不能写成托管覆盖；下面没有任何一行是托管
证据。所有行都记录于 2026-08-30，跑的是**现在这棵树**——评审更正已落、下面那轮变异也已
还原之后——在本地 macOS worktree 上，浏览器是 headless Chrome，分支
`test/mixed-link-mobile-download`，基线 `origin/main` `b08457d6`。这三次跑**不是**由套件
自起服务器：隔离的 Go 测试服务器是从这同一个 worktree 里用
`RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=127.0.0.1:8124` 单独起好的，runner 只是显式指
向那台已经在跑的实例。承载这些 act 的 runner
按内容钉死：`web/e2e/mixed-link.mjs` SHA-256
`b2b78bb2b7f2e44fc0d1669e6036b3a93b5a1e0cb5481334254960fba358cedc`。

| 命令 | 结果 |
|---|---|
| 对 `e2e/mixed-link.mjs` 与 `e2e/go-server.test.mjs` 跑 `node --check` | 两个都干净通过 |
| focused `npx vitest run e2e/go-server.test.mjs src/lib/ReceiveActions.test.ts` | **121 passed** |
| `npm run check` | **0 错误 0 警告** |
| `npx vitest run`（Web 全量） | **4394 passed**、3 skipped |
| `npm run build` | 成功；447 个生成页面，12 份 per-route SPA 外壳 |
| `node e2e/mixed-link.mjs --url http://127.0.0.1:8124`（对着上面单独起的那台服务器） | **20/20 act 按序执行**，连跑三次——13.27s、11.90s、12.59s 墙钟 |

**对抗性变异测试已经做过，而且先做的就是运行时那道闸门。** 把
`web/src/lib/filesink.ts` 的 `pickersAllowed()` 改成无条件走 File System Access 分支，用
这份变异重新构建，再跑一次旅程：它在 **2.284s** 内判红——落在第一个决定性的保存边界上，
早于更慢的终局与逐字节检查——并打出具名诊断 `saveCalls=1 dirCalls=0 handleBytes=0
downloads=0`。这正是"先判计数器"的全部意义：手机闸门一旦被抬掉，报出来的是**哪条 picker
分支开了、它的句柄吃了多少字节**，而不是一次等在永远不会来的下载上的 60 秒超时。随后
`filesink.ts` 被还原成变异前的原样——SHA-256
`624e6b344a5627bd3a43c4707aed94e2fdcc4ada7214aa913265e1b589bd8e90`——并用还原后的源码重新
构建；所以本刀的改动仍然只有上面那五个测试与文档文件，运行时源码一个字节都没留下。

另有六种变异只改测试文件，且**一次只改一种**、下一种之前先还原：让 picker 桩抛错而不是
真能用；破坏 `Blob` 捕获内容；把续传那一幕的终局等待改回原来泛化的 `.xfer.ok`；删掉
`finally` 清理；把手机那一项从 `ACTS` 台账里删掉；以及删掉那次 `act()` 调用。每一种都被
它对应的那条契约判红，之后逐一还原。有两件事这轮变异**不能**代表：它不是关于托管道次的
结论，也不会让上面那条"伪造安卓 UA"的限制变成真机结果。

**阶段三：身份，以及有界的中继失败。** 第 7、8 条放到最后，因为两者都需要前面用不到的
搭台：多页设备身份要在一个浏览器的两页之外再加一个独立上下文；有界中继池失败要那份
池形状的 `/api/ice` 响应、一个连不上的 TURN 主机，以及一个真的会走完的探测预算。

**阶段四：删掉 `lan-transfer.mjs` 和它的 `test:e2e` npm 脚本。** 只在托管 `main` 带着
阶段一到三全绿之后。删早了会丢掉仍然搁浅在里面的那几条——第 1、2、3、6 条搬走且第 4、5 条按上面
记录的确定性证据退役后还剩两条；而留着比没用更糟——一个永远退不出 0 的
脚本，教会所有人忽略一次红。

两件这次迁移**不许**做的事：不许把删掉的控件加回来，不许加降级开关。真正只属于老路的
那部分，缩成了一条关于"不存在"的断言——不通告 `link/1` 的对端拿不到任何控件，并且被
如实告知。

这条断言的两半**状态完全不同**，别混着说：

- **当前在跑的**：`src/lib/link-only-surface.test.ts`（删掉分叉的同一个提交加的）。
  它是确定性的 Vitest 源码级门——production 源码里不 import 任何老会话模块，工作区
  路由器手上没有可回退的传输——每次推送都在 `test` 作业的 `npm test` 那一步跑。
- **写了但不执行的**：`capsSuppressedScenario` 当初是设计来在真浏览器里钉观察方那一侧
  的形状（从不通告 caps 的对端拿不到任何控件，老对端那边也不冒出任何假卡片）。它是
  `main()` 里的**最后**一幕，位于上面说的非执行尾巴的最深处，今天无论本地还是 CI 都
  不跑。

也就是说：源码那一半有门守着，渲染出来那一半没有。这个缺口不大——源码门让老传输在结构上
很难回来——但它确实是个缺口，独有断言第 7 条和浏览器侧的"不支持对端"形状都在等阶段三。
这里不需要真的做一次老式传输，因为已经没有老式传输可做。

每一条断言迁移完都要真跑一次、绿了，才可以在文档里重新称它是自动化覆盖。改到不抛异常
为止、背后没有一次记录在案的绿色运行，正是这一节要防的那种"什么也没测出来的断言"。

### 它测的是什么（设计意图；见上，尾巴当前未执行）

vitest 那些测试**一行都覆盖不到实时传输管道**：收发两条管道原本长在 App.svelte 里、
现在在 `mixed-file-session.svelte.ts` / `mixed-text-session.svelte.ts` 那条统一
`link/1` 链路里，两者都需要两个真实的浏览器上下文、一条真 WebSocket 信令和一个真
RTCPeerConnection 才跑得起来。这个脚本**当年**是它们唯一的回归网；`mixed-link.mjs` 和
`code-room.mjs` 出现之后已经不是了（见上面那份重复/独有的拆分）。下面五条按原样保留，
但读的时候要带上两个限定：**它们现在一条都没在跑**，而且其中大部分在那两套里有等价
断言，真正搁浅的是上表那八条。

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

### 它为什么是**降级**回归，以及那个过滤器

默认产物在无配对码的 LAN 房间里是会通告 `link/1` 的。所以这套用例在开出第一个标签页
之前调一次 `setDefaultInit(STRIP_LINK_CAP)`：**每一个**标签页（包括以后新加的场景）
都被套上一个测试侧的线上过滤器，把离开 socket 的每一帧里的 `link/1` 及与它耦合的
`preupload/1` 抹掉——名册那一帧和 SDP 上捎带的那一份都抹，正是一个老版本
Web/原生/CLI 对端会发出的东西。

页面本身是原封不动的发行构建、原封不动的策略。**产品里没有降级开关**：放一个进去，
等于给所有能碰到它的人发了一条把协议降级的路。

消息那一幕上钉了两件事，缺一件都证明不了什么（它本来就要等 caps 到达，不额外花时间）：

- `__legacyPeer.sawLink > 0` —— 这个产物在 LAN 房间里**确实**通告了 `link/1`。哪天谁
  把通告整个关掉，下面所有"老路照旧工作"的断言都会因为错误的原因通过。
- `__legacyPeer.hello === ["text/1"]` —— 但对端收到的是老对端的那一份，且页面里一个
  统一工作区节点都不挂。

上面这两条现在也随尾巴一起不执行。而且要看清这个过滤器如今意味着什么：`d175f863`
之后，一个只通告 `text/1` 的对端在产品里**没有任何可驱动的传输入口**，卡片上给的是
`.pa-unsupported` 那句话。所以"降级回归"这个身份对传输类场景已经不成立了——不是选择器
改个名的事。这正是上面"迁移方向"里说的：传输类的几幕摘掉 `STRIP_LINK_CAP` 走统一工作区，
而只属于老路的部分退化成"没有控件、并且说清楚"这一条关于不存在的断言。
`STRIP_LINK_CAP` 这个机制本身留着——不是因为 `capsSuppressedScenario` 眼下在用它（那一幕
也不执行），而是因为迁移后的那条"不存在"断言仍然需要一个真的老对端才能制造出来。在那之前，
守着这条不变式的是源码级的 `src/lib/link-only-surface.test.ts`，不是这个过滤器。
**产品里依旧没有降级开关**，这条纪律不因为要修绿而松动。

---

## `mixed-link.mjs` — 一条真的统一链路（`link/1`）

`npm run test:e2e:mixed`（CI 的 `mixed-link-e2e` 作业里跑）

跑的是**普通的默认产物**，不需要任何专门构建，也不需要你先起服务器：

```bash
cd web && npm run build && npm run test:e2e:mixed
#   自起端口：--port 8124（默认；刻意避开手工那台的 8098 和 device-inbox 的 8123）
#   留证据：  --screenshots [目录]（默认 web/e2e-screenshots，已 gitignore）
#   调试：    --keep 保留 Chrome 的临时 profile，以及自起服务器的临时目录
```

服务器由 `go-server.mjs` 从 `./server` 构建、起在一个自己的临时数据库上，跑完（成功、
失败、看门狗超时都一样）连临时目录一起收掉。五条它会**当场拒绝**而不是慢慢超时的情况：

- `--port` 给的不是一个 1–65535 的整数。这一条排在最前面，因为 Node 对"没有端口"的两种
  写法反应并不一样：`listen(undefined)` 会绑一个内核随便挑的空闲端口，所以程序里直接
  `startGoServer({ port: undefined })` 那种调用能骗过"这个端口没人占"，花掉一次完整的
  Go 构建，最后由子进程拿着 `RELAYIUM_ADDR=127.0.0.1:undefined` 去死——报的是服务器，
  不是那个缺掉的值；而命令行上的 `--port`（后面什么都没有）经 `Number()` 变成 `NaN`，
  `listen(NaN)` 直接抛 `RangeError`：红得是早，可既没说 `--port`，也没说这是哪套用例。
  现在两种都在最前面被同一条检查拦下，报的是那个值本身。
- `web/dist/index.html` 不存在，或者比 `web/src` 里任何一个源文件旧。旧 dist 是这套
  用例最会骗人的一种失败——每一页都加载得出来，然后在某一幕深处对着这份 checkout 里
  已经没有的代码红掉。
- 那个端口上已经有人在听。它**不接管**：那台服务器有它自己的库、自己的 dist、可能
  还有开发者的真配置，对着它跑绿什么也证明不了。
- 子进程还没应答 `/healthz` 就退出了。报的是"退出了"，并给出抓下来的日志路径，
  而不是等满整个就绪预算再报一个指向错误方向的超时。
- 给了 `--url` 却没给地址：后面什么都没有、`--url ""`、或者后面跟着的是下一个开关。
  前两种以前都是 falsy，于是这套用例转头去自起一台本地服务器——绿是绿了，绿的不是你
  点名的那台；第三种把开关当成地址吞下去。三种现在都在构建和浏览器之前，以
  `Mixed link E2E` 的名义报出来。

要打一台**你自己起着**的服务器，显式给 `--url`（这条手工快路保留）：

```bash
cd server && RELAYIUM_STATIC=../web/dist RELAYIUM_ADDR=:8098 go run .
cd web    && node e2e/mixed-link.mjs --url http://localhost:8098
```

### 作用域在哪：能力，不是房间，更不是构建旗标

`peer-caps.svelte.ts` 里是两样分开的东西：

- `LINK_BUILD_SUPPORT` —— 这个**构建**实现了 link/1 吗。一个普通常量，不读环境变量。
  以前它是 `VITE_RELAYIUM_LINK_E2E` 的构建期替换，意味着"发行版说不说这条协议"取决
  于有没有人记得设那个变量，而唯一证明这条路的 E2E 跑的是一个从没被部署过的产物。
- `linkRoomActive()` —— 现在允许用吗。**每个房间都允许**，LAN 和配对码一视同仁
  （DECISION-LOG 2026-08-10 取代了 2026-08-04 的 LAN-only 作用域）。中继链路换来的
  不是拒绝说这条协议，而是一条有界的寿命：`relay-deadline.ts` 从服务器签发的 TURN
  凭据里推出一个带时钟偏移余量的边界，`mixed-session` 到点让链路进入可信的终局态。
  这个谓词留着，是为了让"通告"和"路由"永远只有**一个**开关。

跟着房间一起走掉的**不是**降级边界：`peerSupportsLink()` 仍然是精确匹配，只认
`link/1` 这一个字符串。老版本浏览器、原生客户端和 CLI 都只通告 `text/1`，而它们会把
任何入站 offer 读成一次文件传输、然后等一个永远不来的 manifest——所以对它们的投机性
双通道 offer 是**这条协议唯一真正的危险动作**，两个房间里都不许发生。

`advertisedCaps()` 是名册通告和 SDP 确认（`localCaps()`）的**同一个**来源，
`peerSupportsLink()` 读的是**同一个** `linkRoomActive()`——所以不会出现"通告了却拒绝
路由"或者反过来的不对称。两边的行为覆盖在 `peer-caps.test.ts` 和
`peer-workspace.test.ts` 的 "link/1 routing scope"（含精确匹配的降级用例、伪造/畸形
名册声明、入站请求/应答、换房间清场）。

脚本第一件事就是读页面**真正发出去的**名册通告；不做这件事的话，"服务器指着旧 dist"
会伪装成"链路建不起来"——一条看起来像回归的假红。

### 它跑的是**默认的 LAN 界面**

这一点先说，因为它决定了脚本里的每一个选择器：在无配对码的 LAN 房间里，一个能说
`link/1` 的对端**只有一个**主动作 `.open-workspace`。它打开的工作区自带草稿框和附件
控件（`.attach-file` / `.attach-folder`），而对端卡片和"可以发消息"那条提示在工作区
活着的时候整个收走。老的"文件 / 文件夹 / 消息"三选一**已经不存在了**：`d175f863` 把它
连同 `.pa-files` / `.file-pick-input` 一起删了，说不了这条协议的对端现在拿到的是
`.pa-unsupported` 那一句话，一个控件都没有。（这里以前写着"那条路由 `lan-transfer.mjs`
的降级套件覆盖"——两半都已过期：那条路由没了，而那套降级套件也不再执行。）配对码房间
走的是和这里同一套界面，由 `code-room.mjs` 覆盖。

两边的工作区都会为一条新链路**自动开一次**文本通道（否则只有点了按钮的那一边有草稿
框，另一边连一个能点的东西都没有）。两个请求撞在一起时协议按 `link.role` 收敛成一个
会话、一次同意提示，而那次提示落在哪一边取决于真实网络时序——所以脚本等的是"有且只有
一边在问"，不是"B 在问"。

### 它测的是什么

一条链路，两条通道，全程真东西：真 caps → 真 link 请求/应答 → 真 commit-reveal →
**一条** PeerConnection 上的两条 DataChannel → 两条通道各自的同意状态机。

1. **默认卡片只有一个动作**：`.peer-actions` 里正好一个控件，一个 `.open-workspace`，
   零个 `.file-pick-input`。点它就出工作区。
2. **一条链路一个 SAS**。这是这套 UI 最核心的规矩，所以它是一个在每个阶段都复用的
   断言：数**整页**的 `.sas` 必须是 1 且在头部里，同时点名文件进度卡、请求卡和消息
   面板那三个历史渲染点必须是 0。路径徽标同理。两个标签页的六位码必须一致。
3. **工作区一活起来就独占屏幕**：`.peers`、`.peer-actions`、`.open-workspace` 和那条
   可用性提示在两个标签页上都归零，断开之后又一起回来。
4. **第一条同意边念一次码，后面的边不再念**：这条链路的第一次同意（文本通道）必须在
   live region 里带上那六位码；同一条链路上后来的文件同意边必须**不**再念一遍——码一直
   挂在钉住的头部里。跨链路的那一份在第 10 幕单独验。
5. **手机上下一步就在第一屏**：390×844 下，消息同意卡和 40 个文件的同意卡，SAS 与同意
   按钮都在视口内，没有横向溢出，也没有替用户聚焦任何"接受/发送"。
6. **粘性头部**：长清单滚下去之后，唯一那个 SAS 仍然钉在验证语境里（先断言页面确实
   可滚，否则这条检查什么也证明不了）。
7. **队列可见可取消**：传输中再从工作区选文件不会禁用附件控件，而是排成一条带取消按钮
   的队列；同一时刻草稿框仍在。选文件这个动作本身就会在控件是 `disabled` 时抛错。
8. **文件同意可以拒绝**，而链路**和会话**都活下来——拒绝一批文件不等于断开一条链路。
9. **两条通道同时可用**：打字打到一半时附件控件仍然可用、发送键仍然可按；正文**逐字节
   一致**（比 UTF-8 十六进制，含 tab、空行、CJK、阿拉伯语和星平面 emoji）。
10. **手机上一个 picker 都不开，文件仍逐字节到手**（2026-08-30 / C3b-6，从
    `lan-transfer.mjs` 搬来的独有断言第 1 条）：同一条链路上临时给接收页换安卓 UA 与
    platform，并装上**两个真能用**的 picker（先在运行时证明各调一次、吞下 8 字节，再清零）
    外加 Blob/anchor 下载捕获。点"接受"之前，共享的 `.savehint` 必须是唯一一条、不是 retry
    版、没有内存提示，并且既承诺下载目录又不是"选择保存位置"那句。点完之后：两个 picker
    计数与句柄字节数精确为零；恰好一次下载，名字、声明长度和字节模式逐项精确；它那张按
    文件名唯一限定的传输卡成功、无在途进度条、状态无"取消"字样；link、SAS、草稿框和附件
    控件都还在。四个边界与 UA 在一个不会抛的 `finally` 里按**同一性**还原，紧接着的桌面
    picker 那一幕据此仍能证明它自己的两次调用。**这是伪造 UA 的桌面 Chromium 加浏览器
    边界桩，不是真安卓设备、真系统 picker 或真下载管理器**；它证明的是产品主动的手机策略
    （`filesink.ts` 的 `pickersAllowed()`），不是那两桩真机故障本身。
11. **真 Chromium 的 SCTP 缺省上限**（2026-08-30 / C3b-5，从 `lan-transfer.mjs`
    搬来的独有断言第 3 条）：先删除远端 SDP 的非零 `a=max-message-size` 通告并证明真的删过，
    再用原生 DataChannel 精确探测 65,536 可发、65,537 不能保持成功且开放；probe 清零后，
    两页的初始产品 PC 和续传后的全部 replacement PC 都必须精确报告 65,536。它不等于
    `TEXT_MAX_BYTES`，后者是明文产品上限。
12. **传输进行中的活进度条**（2026-08-29 / Phase 3D C3b-1，从 `lan-transfer.mjs`
    搬来的独有断言第 6 条）：在 5 MiB 那次传输的**中途**——接收方已经落了两个 durable
    chunk、强制掐断还没发生——先证明主体在（发送与接收两侧各一条 `.progress-bar`、
    `role="progressbar"`、`aria-labelledby` 指到卡片自己那个标题 id
    `xfer-label-{send,recv}` 且解析得出非空名字、`0 ≤ aria-valuenow ≤ 100`、卡片还没
    进终局），然后才以 `XFER.card` 为 context 扫一次 axe。顺序不能反：一个 context
    什么都没匹配到的 `axe.run` 报的是零违规，看起来和"干净"一模一样。
13. **真断线后按字节续传**：强制换掉 PeerConnection（并断言真的换了），5 MiB 文件按
    durable checkpoint 续完、逐字节校验、不重新同意、SAS 不变；会话被传输中断关掉但
    **记录还在**，而且重开是一颗显式的 `.restart`，不是自动重连。
14. **320/390px、中英文与深色**：三种组合下头部和附件行都不溢出、SAS 和断开按钮都在
    视口里、断开按钮留在行尾、粘性头部有不透明背景，每一格都跑一次 axe。
    `--screenshots` 会把每一格存成 PNG，但每条几何规矩下面都有真断言钉着。运行时维护
    语言目前都为 LTR；若恢复 RTL 语言，必须先恢复逻辑属性镜像的真实运行时门禁。
15. **一次活过了自己那条链路的待决同意**：挂着不答就断链，再连回同一个对端——reveal
    去重键（peer+lane，不含世代）算出来是同一个，所以新链路的第一条边必须念它**自己**
    那串新码。顺带钉住：断开之后统一草稿框和附件不许留在屏幕上。
16. **显式断开收干净**：一次点击关掉两条通道，两个标签页的头部、队列和输入框都消失，
    对端也跟着收——然后那个对端重新可选，而且回来的仍然是那一个动作。

最后和默认那一套一样：两页都不许有 console 错误。

### 一幕不等于一条断言：冻结的逐 act 执行台账

上面这十六条被拆成**二十个具名 act**（一条编号里含多个 act 的地方，是因为它们各自
能单独失效）。每个 act 在自己的断言全部通过之后调一次 `act(name, message)`——它同时
负责打印那行 ✓ 和记台账，所以"报告成功"和"记录为执行过"是同一句话，拆不开。

跑完 `runScenarios()` 三样一起查：成员、**顺序**，以及一个字面量
`EXPECTED_ACT_COUNT = 20`。这里必须是字面量，不能写 `ACTS.length`——数组和它自己的长度
在有人删掉一项之后仍然彼此同意，于是一次少了一幕的运行会干干净净地报 `19/19`。同样的
道理，`EXPECTED_SCENARIO_COUNT = 1` 单独存在，但它保护不了什么：这一套只有一幕，一个
被改到只剩第一条断言的 `mixedScenario` 照样报 `1/1`。真正起作用的是 act 那个数。

`e2e/go-server.test.mjs` 对着这个 runner 的**源码**钉住整个形状（每次推送都跑）：
冻结的 act 名单与顺序、两个字面量计数、`ran++` 和场景调用之间没有 `catch`、活进度条那
一扫确实落在"接受"和"强制掐断"之间，以及这个 runner 手里不再有任何一份 `.request` /
`.xfer` / `.progress-bar` 的私抄。

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

15 格，表在 `a11y-targets.mjs`（单独一个模块，好让 `a11y-core.test.mjs` 能 import 它
去断言——`a11y-scan.mjs` 顶层就跑完整轮扫描，谁 import 它谁就等于跑了一次 CI）。

静态那 7 格覆盖全部 6 种模板（landing / article / guides-index / legal /
mode / 404）：landing 的代表页本身是 RTL，article 再加一份 RTL 分支；mode 模板只有本地化
语言有静态页（英文走 SPA 路由），所以它那一格是 `/zh/cross-network/`。SPA 那 6 格覆盖首页
的桌面浅色与移动深色、cross-network / pricing / apps / cli。另外 **2 格是动态决策态**，
都挂在账户弹窗上（账户按钮只在 cross / offline / pricing / me 四条路由上渲染）：一格是
登出态的登录表单，一格是**已登录免费用户展开的内联档位网格**。

Pricing 这个组件有**两处**嵌入，两格各扫一处：独立的 `/pricing`（`h1` 之下），和账户
弹窗里 `role="dialog"` 内的那一份。只扫前者就等于宣称这个组件是干净的，而弹窗里那一份
从来没被看过——那是另一套语境、另一种可视宽度、另一种会话状态。

每格都钉死视口、`prefers-color-scheme` 和 `prefers-reduced-motion`，等的是各自的
readySelector 而不是固定 sleep——固定 sleep 在快机器上浪费时间，在慢机器上给出一张
还没画完的页面，然后同一份代码今天绿明天红。readySelector 要选**真正想扫的内容**：
`ready` 加可选的 `readyCount` 判「至少这么多个节点在了」，两个定价格子要的是四张真卡
全到齐，而不是骨架屏还在时的那个容器。

### 定价那两格为什么带一份浏览器端 API 夹具

`vite preview` 只吐 `dist`，`/api/*` 后面什么都没有。于是 `/pricing` 的 `onMount` 拿到
一份 HTML、`res.json()` 抛错、组件停在 loadError 分支——而 `.pricing-page` 这个外壳**照样
在**。这一格因此长期在扫一句红色的错误提示：四张真卡、它们的标题层级、价格排版和 CTA
一个都没进过 axe。那里正好藏着一条真的 `heading-order` 违规（`h1 → h3`），它只在
`/api/plans` 真的解析成功之后才出现，所以这道门一次都没看见过它。

修法是 `a11y-fixtures.mjs`：一段用 `Page.addScriptToEvaluateOnNewDocument` 注进去的
`window.fetch` 补丁，**只**给需要的那两格。不接真后端是有意的——那会给一条纯前端的 CI
门加上 Go 服务器 + 数据库 + 迁移 + 种子数据的依赖，而它们任何一个抖一下，红的都是无障碍
扫描，一个指向完全错误方向的失败。补丁本身守四条纪律（`a11y-fixtures.test.mjs` 逐条钉着）：
认 `Request` 也认字符串/`URL`（`String(new Request(u))` 是 `[object Request]`，只看字符串
会静默失配）、只接管同源 GET、没匹配上的**原样**放行（连参数对象都不重建，重建会悄悄丢掉
`signal`/`credentials`/`body`）、返回真的 `Response`。注入是按标签页会话下发的，而每一格
各开各的标签页，所以夹具不会漏到别的目标上。

拿掉夹具这两格不会变绿，会**超时报错**：readySelector 要的是四张真卡，没有真数据就到不了。

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
`scanLiveState()`（`a11y-core.mjs` 导出）被挂进了三套真 E2E——但三套里只有
`code-room.mjs` 那一套在 CI 里跑，所以下面这三行的执行状态各不相同，逐条标在后面：

- `lan-transfer.mjs`：文件同意卡（accept 之前）、传输进行中（`role="progressbar"`
  唯一活着的时候）、掉线续传完成后的终态、消息会话（`role="log"` + 输入框）。
  **这四格挂在该脚本的尾巴上，眼下随尾巴一起不执行**（见上面的"现状"）——所以这四个
  真场景的无障碍覆盖目前是空的，迁移完成前不要把它算进任何"已覆盖"的口径。其中
  "传输进行中"那一格已经在 C3b-1 搬进 `mixed-link.mjs`（下一条），并且**本地跑绿过、
  也做过删主体的对抗性变异**（见上面的验证状态表）；剩下的三格仍然是空的。
- `mixed-link.mjs`（CI，`mixed-link-e2e` 作业）：统一工作区头部、390px 下的 40 文件
  同意卡、文本通道同意后两条通道都活着的状态，以及 **C3b-1 新加的**"5 MiB 传输真的
  在进行中"那一格——两个方向各扫一次，context 收在 `XFER.card` 上，而且扫之前先证明
  那条 `role="progressbar"` 确实在。
- `code-room.mjs`（CI）：配对码房间里的统一工作区（390px）、切换到中文后的同一工作区，
  以及文件同意卡。归档阿拉伯语的 RTL 渲染由静态模板与 axe 目标继续覆盖；运行时恢复
  RTL 语言前，需要另行补回工作区逻辑属性镜像门禁。

这一层**不读允许清单**，是有意的：真场景状态本来就少、本来就该干净，接上清单等于给它们
开一条可以静音的口子。有违规就抛，`incomplete` 只打印。

这几格不是摆设——它们上线当天就抓到了静态扫描看不见的四类真问题：进度条没有可访问名、
`<ol role="log">` 顶掉列表语义让 40 个 `<li>` 变成孤儿、消息面板把 `opacity` 叠在本来
就是次要色的 `--text` 上（掉到 3.3:1）、以及 40 文件同意清单滚得动却聚不上焦点。

## `page-shell.mjs` — 托管的页面外壳契约（不是传输契约）

`npm run test:e2e:page-shell`（CI 的 web / test 作业里跑，紧跟 a11y 扫描）

```bash
cd web && npm run build && npm run test:e2e:page-shell
```

四幕，全部单标签页，2026-08-29（Phase 3D C2）从 `lan-transfer.mjs` 搬过来——它们从来
不碰对端卡片、信令或分块传输，测的是页面本身：

1. `authLandingScenario` —— `/magic-link`、`/verify-email`、`/reset-password`：标题
   文字与字号、共享的 `.ui-card`、`canonical` 为空、零条 `hreflang` 备用链接、
   `robots: "noindex, nofollow"`、label 与输入框的对应关系、中性（非报错）输入框边框、
   320px 移动端不溢出且触摸目标 ≥44px（中英文各一遍）。然后导航回 `/`，断言**路由
   隔离**：`canonical`/`og:url` 恢复、3 条 `hreflang`、`robots` 以 `index, follow`
   开头——私密 auth 路由被压制的 SEO head 不能泄漏进公开路由，也不能在离开后残留。
2. `appsHierarchyScenario` —— `/apps` 的卡片模型从 `AppsPage.svelte` 和
   `native-releases.json` **推导**（`appsCardModel`），不是抄一份卡片 id 清单：标题
   层级计数、可用/未来卡片 id、CTA 链接、未来卡片零控件、明暗两个主题下对比度/不透明度
   ≥4.5:1（连同一条钉住的 EXERCISED/NOT-EXERCISED 披露）、390px 下中英文都不溢出、
   真 Tab 键在 `.cmd` 上留下的键盘焦点环。
3. `pricingHierarchyScenario` —— 第一档的位置、价格/标题字号、价格先于长解释出现的
   DOM 顺序、账户控件存在、390px 下 44px 循环切换目标与 `dir="ltr"` 的价格隔离
   （中英文各一遍）。
4. `unsupportedLayoutScenario` —— **当前布局契约**。加载前把 `isSecureContext` 强制
   设为 `false`，断言单列兜底：`.lan-workspace` 不是 `grid`，没有 `two-col`/紧凑英雄区
   类，不支持横幅存在，`.peers` 不存在，零横向溢出。

**不需要 Go 服务器，只对 `vite preview`。** 四幕里没有一条断言依赖真实的 `/api/*`
响应内容：`authLandingScenario` 的三个组件自己的 `onMount` 都不发请求；
`appsHierarchyScenario` 读的是打包进产物的 `native-releases.json`，不是运行时请求；
`pricingHierarchyScenario` 需要 `/api/plans` 解析成功才会渲染卡片，用
`a11y-fixtures.mjs` 已经导出的 `PRICING_ROUTES`（和 `PricingPage.test.ts` 同一份档位
表）在页面自己的进程里同源应答；`unsupportedLayoutScenario` 完全不碰任何 API 调用。
`Nav.svelte`→`Account.svelte` 触发的匿名会话探测（`GET /api/me`）在四条路由上都会打，
但 `refreshSession()` 把任何非 2xx 都当"未登录"处理，不抛异常，所以不需要专门为它
搭一份夹具。

`/api/plans` 因此换了口径：以前 `pricingHierarchyScenario` 打的是真 Go 服务器，现在
量的是这份手工维护的夹具表，和 `server/account/settings.go` 的真实档位定义有第二处
需要人工同步的地方——但这一幕从来只验证**几何**（第一档在折叠线以上、价格/标题字号、
卡片顺序），从不验证金额，所以这不是一次覆盖回归。

反悄悄丢场景：`main()` 按一个写死的 `EXPECTED_SCENARIO_COUNT = 4` 校验跑过的幕数，
而不是拿 `SCENARIOS.length` 自证——删掉数组里一项会让两者一起缩水，那样"3/3"照样
打印成功。`page-shell-contract.test.mjs` 是这条防线的源码层护栏：钉住四个函数名都还在
`SCENARIOS` 里、钉住比较的是这个写死常量、钉住计数循环里没有把某一幕的异常吞掉的
`catch`、也钉住 `.github/workflows/web.yml` 里那一步没有 `if:` 或
`continue-on-error: true`。

## `code-room.mjs` — 配对码房间里的同一套统一工作区

`npm run test:e2e:code-room`（CI 的 web / test 作业里跑，紧跟 build 与 a11y 扫描）

```bash
cd web && npm run build && npm run test:e2e:code-room
#   换端口：--port 4184
#   留证据：--screenshots [目录]（默认 web/e2e-screenshots，已 gitignore）
#   调试：  --keep 保留 Chrome 的临时 profile
```

这个脚本跑**三幕**，各用各的房间码（BroadcastChannel 是按房间字符串分的，共用一个码
会让上一幕没关干净的标签页混进来，变成偶发红）：

1. `483920` —— 统一工作区本身：一个动作、一条链路、一个 SAS、两条通道、中英文与断开。
2. `915273` —— **预置队列**遇上统一对端。走的是产品里"先选文件、再铸码"那条真入口
   （所以这一幕的发方是**登录**状态，`/api/pair` 也被夹具答掉）。它钉的是那个洞：
   确认栏在对端刚进房的那一刻就弹出来，而链路——以及它让人核对的那串校验码——那时
   还不存在。此刻栏里**不该有发送按钮**，只有"打开工作区"；打开工作区建链路、出
   SAS，但一个字节都不排空；然后按一次取消，验证工作区里那条常驻的重新武装路径；
   最后确认发送，字节按 SHA-256 核对。
3. `604118` —— **相关性丢失**：传输进行中，把收方的**信令** socket 单独掐掉
   （`window.__e2eDropSignaling()`，页面和 DataChannel 一个字不动）。房间因此给发方
   发一帧 `left`。发方必须**留着**那条健康的链路（头部还在、SAS 还是那一个），只是
   如实告知它掉了就回不来了；而正在传的那个文件必须照样传完、字节对得上。这是这条
   不变式在真浏览器里唯一能被制造出来的样子。

**不需要 Go 服务器**，也不需要账号（第二幕的"登录"同样是夹具答的）。缺的服务器职责由
`code-room-fixture.mjs` 在页面里补上：

- **会合**：`window.WebSocket` 被换成一条 BroadcastChannel 上的假房间，按
  `docs/protocol/relayium-signaling-v1.md` 复刻 join/welcome/peers/signal/left 这五帧
  ——**只**复刻这五帧。两个标签页的 peer id 是**显式**给的（`aaaa1111` / `bbbb2222`），
  因为 initiator/responder 按 `selfId < peerId` 定，随机 id 会让角色分配每次运行都不同，
  一个只在某一半角色上出现的回归就变成偶发红。
- **ICE**：`/api/ice` 返回**空**的 iceServers，于是两个标签页用 host 候选在环回上直连。
- **账号与铸码**（只有第二幕用）：`/api/me` 给一个已登录用户，`POST /api/pair` 答一个
  固定的码。这两样是"先选文件、再铸码"那条入口的前置条件，本来就是服务器的职责。
- **单独掐信令**（只有第三幕用）：`window.__e2eDropSignaling()` 关掉这个标签页的假
  socket（房间因此广播它走了），并且**不让它连回来**——真实世界里重连拿到的是一个新
  的 peer id，让夹具用同一个 id 连回来会把那一幕变成另一回事。

页面本身是原样的构建产物，跑原样的策略；产品里没有因此多出任何开关。它证明的是：一个
配对码房间里的升级过的对端，拿到的是和 LAN 一样的**一个**主动作 `.open-workspace`；
它打开的工作区默认就有草稿框、下面挂着发送文件/发送文件夹；一条链路只有**一个** SAS
（整页只有一个 `.sas`，通道卡片里一个都没有）；文本和一个真文件走**同一条**连接、
收方仍然独立同意、落盘字节按 SHA-256 逐一核对；中文下 390px 不横向溢出；
断开之后两边的工作区都收走、选择器回来、房间还在；一个预置的批次在**校验码出现之前
没有任何办法被放走**；以及对端的信令没了不等于那条数据通道没了。

它**不**证明的：服务器对配对码的准入、TURN 中继本身、以及中继凭据的到期边界
（理由见开头那两条"覆盖不到"）。
